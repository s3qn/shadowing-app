"""Echo cancellation for shadow takes.

Removes the cached VOICEVOX line from a take recorded through the phone
speaker with the microphone open, leaving Sean's voice behind. The
speaker to microphone path (speaker EQ, phone body, room) is learned once
from a calibration recording made with him silent, then applied frozen on
every take, because he speaks over the whole line and a filter left free
to adapt on the take itself would learn to cancel his voice instead of
the echo. Pure numpy plus the ffmpeg CLI: the backend venv has no scipy,
soundfile or librosa, and a partitioned block frequency domain adaptive
filter is about eighty lines of array arithmetic, so nothing else earns
its place.

python -m aec --selfcheck builds a synthetic take from a real VOICEVOX
line and checks the filter against the numbers the design was validated
with: delay estimate, calibration ERLE with and without mic noise, voice
preservation through a frozen apply, and runtime.
"""

from __future__ import annotations

import os
import subprocess
import sys
import tempfile
import time
import wave
from dataclasses import dataclass
from pathlib import Path

import numpy as np

SR = 24000
BLOCK = 256          # samples per block, 10.7 ms
TAPS = 4096          # 170 ms of speaker to mic path
MU_CALIBRATE = 0.5   # step size while learning with nobody talking
MU_TRACK = 0.1        # step size on a real take, guarded by double talk
CAL_PASSES = 8
DTD_RATIO = 2.0       # freeze adaptation when mic power > ratio * predicted echo power
MIN_ECHO_DB = -45     # predicted echo below this (dBFS) means no bleed: leave the take alone
MIN_ERLE_DB = 3.0     # cancellation that buys less than this is not worth altering a take for

N = 2 * BLOCK                  # FFT size for the overlap-save block pair
P = TAPS // BLOCK              # partitions
_N_BINS = N // 2 + 1           # rfft length of an N point real transform
_ALIGN_LEAD = 200              # samples of margin given to the delay estimate
_POWER_SMOOTH = 0.9            # exponential smoothing factor for the per-bin power estimate

DATA_DIR = Path(os.getenv("SHADOW_DATA_DIR", Path(__file__).parent / "data"))
AEC_DIR = DATA_DIR / "aec"


@dataclass
class Profile:
    """A learned speaker to mic path."""

    delay: int
    W: np.ndarray
    erle_db: float


@dataclass
class Result:
    """The outcome of cleaning one take against a stored profile."""

    cleaned: bool
    note: str
    output: np.ndarray
    erle_db: float | None = None
    delay_ms: float | None = None
    drift_samples: int | None = None
    frozen_blocks: int | None = None
    profile: Profile | None = None


def decode(path: Path) -> np.ndarray:
    """Decode any audio file to 24 kHz mono float32 in [-1, 1] via ffmpeg.

    Goes through a temp s16 wav (matching main.py's _to_wav) so decoding
    never depends on a Python audio codec being installed, then divides
    by 32768 to get float samples.
    """
    with tempfile.TemporaryDirectory() as td:
        tmp = Path(td) / "decoded.wav"
        subprocess.run(
            ["ffmpeg", "-y", "-i", str(path), "-ac", "1", "-ar", str(SR),
             "-sample_fmt", "s16", str(tmp)],
            capture_output=True,
            check=True,
            timeout=120,
        )
        with wave.open(str(tmp), "rb") as w:
            raw = w.readframes(w.getnframes())
    return np.frombuffer(raw, dtype="<i2").astype(np.float32) / 32768.0


def encode(path: Path, x: np.ndarray) -> None:
    """Write x as a 16 bit 24 kHz mono wav, clipped to [-1, 1]."""
    clipped = np.clip(np.asarray(x, dtype=np.float64), -1.0, 1.0)
    ints = (clipped * 32767.0).astype("<i2")
    path.parent.mkdir(parents=True, exist_ok=True)
    with wave.open(str(path), "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(SR)
        w.writeframes(ints.tobytes())


def _xcorr(ref: np.ndarray, mic: np.ndarray, max_lag: int) -> np.ndarray:
    """sum_n ref[n] * mic[n + k] for k in [0, max_lag], via FFT."""
    length = len(ref) + len(mic)
    fft_len = 1
    while fft_len < length:
        fft_len *= 2
    a = np.fft.rfft(ref.astype(np.float64), fft_len)
    b = np.fft.rfft(mic.astype(np.float64), fft_len)
    c = np.fft.irfft(np.conj(a) * b, fft_len)
    return c[: max_lag + 1]


def find_delay(ref: np.ndarray, mic: np.ndarray, max_s: float = 3.0) -> int:
    """Bulk delay of mic after ref, in samples, by FFT cross correlation."""
    max_lag = min(int(max_s * SR), max(len(mic) - 1, 0))
    if max_lag <= 0:
        return 0
    c = _xcorr(ref, mic, max_lag)
    return int(np.argmax(np.abs(c)))


def _align(ref: np.ndarray, d: int, lead: int = _ALIGN_LEAD) -> np.ndarray:
    """Shift ref so the filter sees it `lead` samples early.

    That way the filter models the rest of the true delay itself, and a
    delay estimate that is a few samples off in either direction still
    lands well inside the tap budget.
    """
    ref = ref.astype(np.float64)
    shift = d - lead
    if shift >= 0:
        return np.concatenate([np.zeros(shift, dtype=np.float64), ref])
    return ref[-shift:]


def pbfdaf(
    ref: np.ndarray,
    mic: np.ndarray,
    W0: np.ndarray | None = None,
    mu: float = MU_TRACK,
    passes: int = 1,
    dtd: bool = True,
    adapt: bool = True,
) -> tuple[np.ndarray, np.ndarray, np.ndarray, int]:
    """Partitioned block frequency domain adaptive filter, overlap save.

    ref and mic must already be time aligned (see _align). Returns the
    error signal (mic minus the predicted echo) and the predicted echo
    itself, both from the final pass, the filter weights after every
    pass, and how many blocks of the final pass were frozen by the
    double talk detector.
    """
    n = min(len(ref), len(mic))
    n_blocks = n // BLOCK
    n = n_blocks * BLOCK
    ref = ref[:n].astype(np.float64)
    mic = mic[:n].astype(np.float64)

    W = np.zeros((P, _N_BINS), dtype=np.complex128) if W0 is None else np.array(W0, dtype=np.complex128, copy=True)
    power_smooth = np.zeros(_N_BINS, dtype=np.float64)
    floor = 1e-6 * N * P

    err = np.zeros(n, dtype=np.float64)
    echo = np.zeros(n, dtype=np.float64)
    frozen_blocks = 0

    for pass_idx in range(passes):
        Xbuf = np.zeros((P, _N_BINS), dtype=np.complex128)
        prev_block = np.zeros(BLOCK, dtype=np.float64)
        last_pass = pass_idx == passes - 1
        if last_pass:
            frozen_blocks = 0

        for b in range(n_blocks):
            lo, hi = b * BLOCK, (b + 1) * BLOCK
            cur = ref[lo:hi]
            frame = np.concatenate([prev_block, cur])
            X_new = np.fft.rfft(frame, N)
            Xbuf[1:] = Xbuf[:-1]
            Xbuf[0] = X_new

            Y = np.sum(Xbuf * W, axis=0)
            y_time = np.fft.irfft(Y, N)
            y_valid = y_time[BLOCK:]

            mic_block = mic[lo:hi]
            e_block = mic_block - y_valid

            if last_pass:
                err[lo:hi] = e_block
                echo[lo:hi] = y_valid

            current_power = np.sum(np.abs(Xbuf) ** 2, axis=0)
            power_smooth = _POWER_SMOOTH * power_smooth + (1 - _POWER_SMOOTH) * current_power
            # The smoothed-only estimate is near zero right after the lead
            # silence and would blow the step size up the instant playback
            # starts; the max against the current block's power fixes it.
            norm = np.maximum(np.maximum(power_smooth, current_power), floor)

            do_update = adapt
            if adapt and dtd:
                mic_power = float(np.sum(mic_block ** 2))
                echo_power = float(np.sum(y_valid ** 2))
                if mic_power > DTD_RATIO * echo_power:
                    do_update = False
                    if last_pass:
                        frozen_blocks += 1

            if do_update:
                e_pad = np.concatenate([np.zeros(BLOCK), e_block])
                E = np.fft.rfft(e_pad, N)
                # Normalise per bin before the constraint, never after. Dividing
                # by a frequency dependent norm is a filtering operation, so
                # doing it last smears the gradient back across the whole frame
                # and undoes the projection, letting W drift out of the zero
                # padded tap span the forward path assumes. A white reference
                # has a nearly flat norm and hides this; speech, whose bin
                # powers span 60 dB, diverges within a second of it.
                grad_f = np.conj(Xbuf) * E[np.newaxis, :] / norm[np.newaxis, :]
                grad_t = np.fft.irfft(grad_f, N, axis=1)
                grad_t[:, BLOCK:] = 0.0  # constrained gradient: linear, not circular
                W = W + mu * np.fft.rfft(grad_t, N, axis=1)

            prev_block = cur

    return err, echo, W, frozen_blocks


def calibrate(ref: np.ndarray, mic: np.ndarray) -> Profile:
    """Learn the speaker to mic path from a recording made with the mic open and nobody talking."""
    d = find_delay(ref, mic)
    ref_a = _align(ref, d)
    n = min(len(ref_a), len(mic))
    mic = mic[:n].astype(np.float64)
    err, _echo, W, _frozen = pbfdaf(
        ref_a[:n], mic, mu=MU_CALIBRATE, passes=CAL_PASSES, dtd=False, adapt=True,
    )
    # Only over the line. A calibration recording runs on past the end of the
    # line, and averaging that trailing room tone in (where mic and residual
    # are the same quiet noise) would drag the reported figure toward 0 dB.
    span = slice(min(d, n), min(n, d + len(ref)))
    p_mic = float(np.mean(mic[span] ** 2))
    p_err = float(np.mean(err[span] ** 2))
    erle_db = 10.0 * np.log10(max(p_mic, 1e-12) / max(p_err, 1e-12))
    return Profile(delay=d, W=W, erle_db=float(erle_db))


def _erle_db(before: np.ndarray, after: np.ndarray) -> float:
    p_before = float(np.mean(before.astype(np.float64) ** 2))
    p_after = float(np.mean(after.astype(np.float64) ** 2))
    return 10.0 * np.log10(max(p_before, 1e-12) / max(p_after, 1e-12))


def _drift_samples(ref: np.ndarray, mic: np.ndarray, d: int) -> int:
    """Delay found on the line's first second versus its last, in samples."""
    span = SR
    pad = int(0.05 * SR)
    if len(ref) < 2 * span:
        return 0

    def local(ref_seg: np.ndarray, approx: int) -> int:
        lo = max(0, approx - pad)
        hi = min(len(mic), approx + len(ref_seg) + pad)
        seg_mic = mic[lo:hi]
        if len(seg_mic) <= len(ref_seg):
            return approx
        rel = find_delay(ref_seg, seg_mic, max_s=(2 * pad) / SR)
        return lo + rel

    d_first = local(ref[:span], d)
    tail_start = len(ref) - span
    d_last = local(ref[tail_start:], d + tail_start)
    return int((d_last - tail_start) - d_first)


def clean(ref: np.ndarray, mic: np.ndarray, profile: Profile) -> Result:
    """Subtract the line from a take using a stored, frozen profile.

    Steps, in order: find the delay and bail out if there is no
    correlation peak worth trusting; align the reference; use the
    stored, frozen filter on the first 300 ms of the line to refit a
    gain and bail out if the predicted echo is negligible; apply the
    frozen filter to the whole take, then run one guarded tracking pass
    starting from the gain-corrected weights and keep whichever of the
    two has the better head ERLE; leave everything outside the line span
    untouched; report the drift between the delay estimated on the first
    and last second of the line.
    """
    ref = np.asarray(ref, dtype=np.float64)
    mic = np.asarray(mic, dtype=np.float64)

    d = find_delay(ref, mic)
    max_lag = min(int(3.0 * SR), max(len(mic) - 1, 0))
    corr = np.abs(_xcorr(ref, mic, max_lag)) if max_lag > 0 else np.zeros(1)
    peak = corr[d] if d < len(corr) else 0.0
    med = float(np.median(corr))
    if med <= 0.0 or peak <= 0.0 or 20.0 * np.log10(peak / med) < 6.0:
        return Result(cleaned=False, note="no echo", output=mic.copy(), profile=profile)

    ref_a = _align(ref, d)
    take = mic  # the full take; only the line span is ever rewritten
    # pbfdaf consumes whole blocks and returns only what it consumed, so keep
    # the working span on a block boundary: its outputs then line up with mic
    # sample for sample. Whatever follows is take tail with no echo in it, and
    # is copied through untouched rather than dropped off the end.
    n = (min(len(ref_a), len(take)) // BLOCK) * BLOCK
    mic = take[:n]
    if n == 0:
        return Result(cleaned=False, note="no echo", output=take.copy(), profile=profile)

    head_len = int(0.3 * SR)
    head_lo = min(d, n)
    head_hi = min(n, d + head_len)
    if head_hi <= head_lo:
        return Result(cleaned=False, note="no echo", output=take.copy(), profile=profile)

    err_frozen, echo_frozen, _, _ = pbfdaf(
        ref_a[:n], mic, W0=profile.W, mu=0.0, passes=1, dtd=False, adapt=False,
    )

    echo_head = echo_frozen[head_lo:head_hi]
    mic_head = mic[head_lo:head_hi]
    denom = float(np.dot(echo_head, echo_head))
    g = float(np.dot(mic_head, echo_head) / denom) if denom > 0.0 else 0.0
    # No floor. On a take recorded through headphones the mic never hears the
    # line, so the least squares fit correctly lands near zero, and pinning it
    # up to a quarter would subtract a predicted echo that was never there.
    # Only the ceiling is a real guard, against a wild fit on a noisy head.
    g = min(max(g, 0.0), 4.0)

    line_hi = min(n, d + len(ref) + int(0.05 * SR))
    line_echo = g * echo_frozen[head_lo:line_hi]
    echo_db = 20.0 * np.log10(max(float(np.sqrt(np.mean(line_echo ** 2))), 1e-12))
    if echo_db < MIN_ECHO_DB:
        return Result(cleaned=False, note="no echo", output=take.copy(), profile=profile)

    out_frozen = mic - g * echo_frozen

    err_track, _echo_track, W_track, frozen_blocks = pbfdaf(
        ref_a[:n], mic, W0=profile.W * g, mu=MU_TRACK, passes=1, dtd=True, adapt=True,
    )

    erle_frozen = _erle_db(mic_head, out_frozen[head_lo:head_hi])
    erle_track = _erle_db(mic_head, err_track[head_lo:head_hi])

    if erle_track >= erle_frozen:
        out = err_track
        used_erle = erle_track
        new_profile = Profile(delay=d, W=W_track, erle_db=profile.erle_db)
    else:
        out = out_frozen
        used_erle = erle_frozen
        new_profile = profile

    # The last word on whether there was an echo here, and the only one that
    # looks at the take rather than at a prediction made from the reference.
    # A take through headphones still has a loud predicted echo, because the
    # profile says what the speaker would have done; what it does not have is
    # any of that echo to remove, which shows up here and nowhere earlier.
    if used_erle < MIN_ERLE_DB:
        return Result(cleaned=False, note="no echo", output=take.copy(), profile=profile)

    full_out = take.copy()
    lo = max(head_lo, 0)
    hi = min(line_hi, n)
    full_out[lo:hi] = out[lo:hi]

    drift = _drift_samples(ref, mic, d)

    return Result(
        cleaned=True,
        note="",
        output=full_out,
        erle_db=float(used_erle),
        delay_ms=d * 1000.0 / SR,
        drift_samples=drift,
        frozen_blocks=frozen_blocks,
        profile=new_profile,
    )


def save_profile(name: str, profile: Profile) -> None:
    AEC_DIR.mkdir(parents=True, exist_ok=True)
    np.savez(AEC_DIR / f"{name}.npz", delay=profile.delay, W=profile.W, erle_db=profile.erle_db)


def load_profile(name: str) -> Profile | None:
    path = AEC_DIR / f"{name}.npz"
    if not path.exists():
        return None
    with np.load(path) as data:
        return Profile(delay=int(data["delay"]), W=data["W"], erle_db=float(data["erle_db"]))


# --- self check -------------------------------------------------------


def _find_default_wav() -> Path:
    root = DATA_DIR / "audio"
    matches = sorted(root.rglob("*.wav"))
    if not matches:
        raise SystemExit(f"no wav files found under {root}; pass a path on the command line")
    return matches[0]


def _tile_to_length(x: np.ndarray, length: int) -> np.ndarray:
    if len(x) >= length:
        return x[:length].copy()
    reps = int(np.ceil(length / len(x)))
    return np.tile(x, reps)[:length]


def _make_room(rng: np.random.Generator, delay_samples: int, path_len: int) -> np.ndarray:
    """A direct arrival at the bulk delay, then a 160 ms decaying random tail.

    The direct path is the loudest tap on purpose: a phone speaker a few
    centimetres from its own microphone always reaches it ahead of any
    reflection, and find_delay looks for the strongest correlation peak, so
    a room built as reflections alone would put the peak at a random tap in
    the tail and make the delay check measure nothing.
    """
    decay = np.exp(-np.linspace(0.0, 6.0, path_len))
    body = rng.normal(0.0, 1.0, path_len) * decay
    body /= np.max(np.abs(body)) + 1e-9
    h = np.zeros(delay_samples + path_len, dtype=np.float64)
    h[delay_samples:] = body * 0.2
    h[delay_samples] = 0.5
    return h


def _dbfs_noise(rng: np.random.Generator, n: int, dbfs: float) -> np.ndarray:
    rms = 10.0 ** (dbfs / 20.0)
    return rng.normal(0.0, rms, n)


def _selfcheck(wav_path: Path) -> int:
    t_all = time.monotonic()
    rng = np.random.default_rng(0)

    line = decode(wav_path)
    line = _tile_to_length(line, int(4.0 * SR))
    # main.py hands clean() the bare cached line as the reference and the take
    # as recorded, so build the case that way round. Padding the reference
    # instead puts the estimated delay inside the padding, and every span
    # clean() derives from it then lands on silence: the gain refit divides by
    # nothing, the ERLE is measured over room tone, and the check passes while
    # exercising none of the filter.
    ref = line.astype(np.float64)
    lead_silence = np.zeros(int(1.0 * SR), dtype=np.float64)
    tail_silence = np.zeros(int(1.0 * SR), dtype=np.float64)
    played = np.concatenate([lead_silence, ref, tail_silence])

    delay_samples = int(0.04 * SR)
    path_len = int(0.16 * SR)
    h = _make_room(rng, delay_samples, path_len)
    mic_clean = np.convolve(played, h)[: len(played)]
    line_start = len(lead_silence) + delay_samples  # where the echo starts in the take
    line_span = slice(line_start, line_start + len(ref))

    ok = True

    # 1a. on a clean single tap path the delay is exactly recoverable
    h_direct = np.zeros(delay_samples + 1, dtype=np.float64)
    h_direct[delay_samples] = 0.5
    d_direct = find_delay(ref, np.convolve(played, h_direct)[: len(played)])
    print(f"1a. delay, single tap path: estimated {d_direct}, true {line_start}")
    if abs(d_direct - line_start) > 1:
        print(f"    FAIL: off by {abs(d_direct - line_start)} samples, want <= 1")
        ok = False

    # 1b. through a reverberant room the peak sits a little after the direct
    # arrival, because the tail's energy correlates too. That is the estimator
    # working as intended, not drifting: all the aligner needs is an estimate
    # inside its lead, which is what this checks.
    d = find_delay(ref, mic_clean)
    delay_err = abs(d - line_start)
    print(f"1b. delay, reverberant room: estimated {d}, true {line_start}, "
          f"error {delay_err} samples (lead is {_ALIGN_LEAD})")
    if delay_err >= _ALIGN_LEAD:
        print(f"    FAIL: error {delay_err} is not inside the {_ALIGN_LEAD} sample lead")
        ok = False

    # 2. calibration ERLE above 25 dB with no noise
    profile = calibrate(ref, mic_clean)
    print(f"2. calibration ERLE, no noise: {profile.erle_db:.1f} dB")
    if not (profile.erle_db > 25.0):
        print(f"   FAIL: {profile.erle_db:.1f} dB is not above 25 dB")
        ok = False

    # 3. with -55 dBFS mic noise, ERLE close to the noise ceiling
    noise = _dbfs_noise(rng, len(mic_clean), -55.0)
    mic_noisy = mic_clean + noise
    profile_noisy = calibrate(ref, mic_noisy)
    p_echo = float(np.mean(mic_clean[line_span] ** 2))
    p_noise = float(np.mean(noise[line_span] ** 2))
    ceiling_db = 10.0 * np.log10(max(p_echo, 1e-12) / max(p_noise, 1e-12))
    gap = abs(profile_noisy.erle_db - ceiling_db)
    # The steady state sits a few dB under the ceiling and stays there however
    # many passes it is given: that distance is the filter's misadjustment, the
    # price of a gradient step that never stops reacting to the noise, not slow
    # convergence. Measured at about 4.5 dB, so 6 dB leaves room without hiding
    # a regression that would cost far more than that.
    print(f"3. calibration ERLE, -55 dBFS noise: {profile_noisy.erle_db:.1f} dB, "
          f"ceiling {ceiling_db:.1f} dB, gap {gap:.1f} dB")
    if gap > 6.0:
        print(f"   FAIL: gap {gap:.1f} dB is more than 6 dB from the ceiling")
        ok = False

    # Sean talking over the line, starting after the 300 ms clean.() refits its
    # gain on, so the refit sees echo alone the way it does on a real take.
    voice = np.zeros(len(played), dtype=np.float64)
    offset = line_start + int(0.35 * SR)
    voice_src = line[::-1].astype(np.float64) * 1.5
    end = min(len(voice), offset + len(voice_src))
    voice[offset:end] = voice_src[: end - offset]
    mic_dt = mic_clean + voice

    # 4. a frozen apply on the double talk mix leaves the near end voice untouched
    ref_a = _align(ref, profile.delay)
    n = min(len(ref_a), len(mic_dt), len(mic_clean))
    err_dt, _e1, _w1, _f1 = pbfdaf(ref_a[:n], mic_dt[:n], W0=profile.W, mu=0.0,
                                    passes=1, dtd=False, adapt=False)
    err_echo_only, _e2, _w2, _f2 = pbfdaf(ref_a[:n], mic_clean[:n], W0=profile.W, mu=0.0,
                                           passes=1, dtd=False, adapt=False)
    m = len(err_dt)  # pbfdaf truncates to a whole number of blocks
    voice_diff = float(np.max(np.abs((err_dt - voice[:m]) - err_echo_only[:m])))
    print(f"4. frozen apply, voice preservation: max abs diff {voice_diff:.3e}")
    if not (voice_diff < 1e-6):
        print(f"   FAIL: frozen apply touched the voice by {voice_diff:.3e}, want < 1e-6")
        ok = False

    # 5. clean() on that take: it cancels, it reports cancelling, what is left
    #    where Sean talks is his voice and not the line, and it fits the budget
    t0 = time.monotonic()
    result = clean(ref, mic_dt, profile)
    runtime = time.monotonic() - t0
    residual = result.output[line_span] - voice[line_span]
    rms_echo = float(np.sqrt(np.mean(mic_clean[line_span] ** 2)))
    rms_residual = float(np.sqrt(np.mean(residual ** 2)))
    suppression = 20.0 * np.log10(max(rms_echo, 1e-12) / max(rms_residual, 1e-12))
    print(f"5. clean(): cleaned={result.cleaned}, reported ERLE "
          f"{result.erle_db if result.erle_db is None else round(result.erle_db, 1)} dB, "
          f"echo left over the line {suppression:.1f} dB down, "
          f"drift {result.drift_samples}, runtime {runtime:.2f} s "
          f"for a {len(mic_dt) / SR:.1f} s take")
    if not result.cleaned:
        print("   FAIL: clean() reported it found no echo to remove")
        ok = False
    if suppression < 20.0:
        print(f"   FAIL: only took the echo {suppression:.1f} dB down over the line, want 20")
        ok = False
    if result.erle_db is None or result.erle_db < 20.0:
        print(f"   FAIL: reported ERLE {result.erle_db} is not above 20 dB")
        ok = False
    if len(result.output) != len(mic_dt):
        print(f"   FAIL: returned {len(result.output)} samples for a {len(mic_dt)} sample take")
        ok = False
    if not (runtime < 3.0):
        print(f"   FAIL: runtime {runtime:.2f} s is not under 3 s")
        ok = False

    # 6. a take recorded through headphones has no bleed to remove: clean()
    #    must say so and hand the take back untouched, rather than subtract an
    #    echo it only predicted and leave the recording worse than it found it
    mic_phones = voice + _dbfs_noise(rng, len(voice), -58.0)
    res_phones = clean(ref, mic_phones, profile)
    untouched = bool(np.array_equal(res_phones.output, mic_phones))
    print(f"6. headphones take: cleaned={res_phones.cleaned}, note={res_phones.note!r}, "
          f"returned untouched={untouched}")
    if res_phones.cleaned:
        print(f"   FAIL: reported cleaning a take with no echo in it "
              f"(ERLE {res_phones.erle_db})")
        ok = False
    if not untouched:
        print("   FAIL: altered a take it had nothing to remove from")
        ok = False

    print(f"selfcheck total wall time: {time.monotonic() - t_all:.2f} s")
    return 0 if ok else 1


def main(argv: list[str] | None = None) -> int:
    import argparse

    parser = argparse.ArgumentParser(prog="aec")
    parser.add_argument("wav", nargs="?", help="a VOICEVOX line wav to build the synthetic case from")
    parser.add_argument("--selfcheck", action="store_true")
    args = parser.parse_args(argv)

    if not args.selfcheck:
        parser.print_help()
        return 1

    wav_path = Path(args.wav) if args.wav else _find_default_wav()
    print(f"using {wav_path}")
    return _selfcheck(wav_path)


if __name__ == "__main__":
    sys.exit(main())
