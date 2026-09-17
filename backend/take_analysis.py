"""Mora length and pitch accent analysis for shadow takes.

Pure numpy: the backend venv has no scipy, librosa, parselmouth or
soundfile, and a YIN tracker plus a banded DTW is a few hundred lines of
array arithmetic, so nothing else earns its place here. The tracker and
aligner below are copied from the parked pitch-contour branch
(`pitch.py` at c4ea6d3); this module adds the mora-level readings on top:
which long vowels, geminates (っ) and ん the learner clipped, and a hit
or miss on every pitch accent nucleus.

Frames are 10 ms apart (HOP_S), long enough that a mora (about 100 to
150 ms) always spans several of them, short enough to see the fall inside
one. The search band 70 to 400 Hz covers a speaking voice, male or
female, without reaching into the harmonics that cause octave errors.
`semitones` centres each track on its own median f0, so two different
voices reading the same line become comparable curves regardless of how
different their register is; only the shape (the fall, the rise) carries
meaning.

This module never imports aec, main or store: it only ever sees arrays,
timelines and plain dicts, so it can be tested and reasoned about on its
own.
"""

from __future__ import annotations

import math
import warnings
from dataclasses import dataclass

import numpy as np

HOP_S = 0.010
WIN = 1024
F_MIN, F_MAX = 70.0, 400.0
YIN_THRESHOLD = 0.15
RMS_FLOOR_DB = -50.0
MEDIAN_FRAMES = 5
MIN_RUN_FRAMES = 3
BAND = 60
# Mean per frame distance of [energy, voiced] along the DTW path. Synthetic
# copies of a line, re-voiced in another register with pitch drift and
# 15 dB noise, stay under 0.10; unrelated speech with its own pauses mostly
# lands between 0.2 and 0.56. A flat reading of the right words is near 0.
DTW_MAX_COST = 0.2
ENERGY_RANGE_DB = 60.0
ENERGY_SCALE_DB = 20.0
COVERAGE_MIN = 0.4
MIN_TRUST_ERLE_DB = 10.0

_MAX_WALK_STEPS = 64  # local-minimum walk never needs more than a handful
_STACK_SLOPES = np.array([1, 0, 2], dtype=np.int8)  # align()'s candidate order

MIN_MORA_MS = 30
CLIP_RATIO = 0.6
RATE_MIN, RATE_MAX = 0.5, 2.0
NUCLEUS_DROP_ST = 1.0
_VOICE_FLOOR = 0.15
_ANCHOR_LEAD_MS = 500.0

# Vowel of a mora's last character, one row per vowel: covers plain kana,
# small kana (glide markers) and the katakana rows VOICEVOX moras are
# written in. ン and ッ and any punctuation are deliberately absent.
_VOWEL_ROWS: dict[str, str] = {
    "a": "アカサタナハマヤラワガザダバパァャヮ",
    "i": "イキシチニヒミリギジヂビピィ",
    "u": "ウクスツヌフムユルグズヅブプゥュヴ",
    "e": "エケセテネヘメレゲゼデベペェ",
    "o": "オコソトノホモヨロヲゴゾドボポォョ",
}
_CHAR_VOWEL: dict[str, str] = {c: v for v, row in _VOWEL_ROWS.items() for c in row}


@dataclass
class Track:
    """One speaker's pitch contour on a 10 ms frame grid.

    f0 is nan where the frame is unvoiced. energy_db is defined everywhere
    (silence is just very negative), so alignment can use it as a rough
    voice activity signal even where f0 has nothing to say.
    """

    times: np.ndarray
    f0: np.ndarray
    energy_db: np.ndarray


@dataclass
class Alignment:
    """How a take's frames line up with a line's frames.

    path_i has one take frame index per line frame, non-decreasing.
    method is "dtw" when the banded search found a plausible path, or
    "offset" when it gave up and fell back to a constant shift. cost is
    the mean energy and voicing distance along the DTW path either way
    (inf when no path fits the band), so the caller can see how close it
    came even when it fell back.
    """

    path_i: np.ndarray
    method: str
    cost: float


def _frame(x: np.ndarray, sr: int) -> tuple[np.ndarray, np.ndarray, int, int]:
    """Slide overlapping windows over x, one every hop samples.

    Frame j is x[j*hop : j*hop + WIN + tau_max], stamped at the centre of
    its first WIN samples. x is zero padded at the end so the last
    partial frame exists instead of being dropped.
    """
    hop = int(round(HOP_S * sr))
    tau_min = int(math.floor(sr / F_MAX))
    tau_max = int(math.ceil(sr / F_MIN))
    length = WIN + tau_max

    n = len(x)
    n_frames = max(1, int(math.ceil(n / hop)))
    padded_len = (n_frames - 1) * hop + length
    pad = max(0, padded_len - n)
    x_pad = np.concatenate([x.astype(np.float64), np.zeros(pad, dtype=np.float64)])

    frames = np.lib.stride_tricks.sliding_window_view(x_pad, length)[::hop][:n_frames]
    times = (np.arange(n_frames) * hop + WIN / 2.0) / sr
    return frames, times, tau_min, tau_max


def track(x: np.ndarray, sr: int) -> Track:
    """YIN pitch tracking, vectorised across frames.

    Runs the difference function and its cumulative mean normalisation for
    every frame at once (one rfft pair per frame, all frames together),
    then walks each frame down to its local minimum with a short bounded
    loop (never more than a few steps in practice, since the walk starts
    already inside the dip) and refines it by parabolic interpolation.
    Measured at about 0.15 s for a 6 s take on this machine (track and
    align together), well inside the analysis budget.
    """
    frames, times, tau_min, tau_max = _frame(x, sr)
    n_frames, length = frames.shape

    # r(tau) = sum_{n=0}^{WIN-1} x[n] * frame[n+tau] for tau in [0, tau_max],
    # via one circular cross correlation per frame: zeroing the frame beyond
    # WIN samples before the transform means the circular wraparound never
    # reaches the tau range we read back, so it behaves exactly like the
    # linear correlation YIN wants.
    template = frames.copy()
    template[:, WIN:] = 0.0
    a = np.fft.rfft(template, n=length, axis=1)
    b = np.fft.rfft(frames, n=length, axis=1)
    r_full = np.fft.irfft(np.conj(a) * b, n=length, axis=1)
    r = r_full[:, : tau_max + 1]

    sq = frames ** 2
    cumsq = np.concatenate([np.zeros((n_frames, 1)), np.cumsum(sq, axis=1)], axis=1)
    tau_range = np.arange(tau_max + 1)
    e = cumsq[:, tau_range + WIN] - cumsq[:, tau_range]  # E(tau)
    e0 = e[:, :1]

    d = e0 + e - 2.0 * r
    cumd = np.cumsum(d, axis=1)
    with np.errstate(divide="ignore", invalid="ignore"):
        dprime = np.where(cumd > 0, d * tau_range[np.newaxis, :] / np.where(cumd == 0, 1.0, cumd), 1.0)
    dprime[:, 0] = 1.0

    window = dprime[:, tau_min : tau_max + 1]
    mask = window < YIN_THRESHOLD
    has_dip = mask.any(axis=1)
    tau0 = tau_min + np.argmax(mask, axis=1)

    frame_idx = np.arange(n_frames)
    current = tau0.copy()
    for _ in range(_MAX_WALK_STEPS):
        nxt = np.minimum(current + 1, tau_max)
        d_cur = dprime[frame_idx, current]
        d_nxt = dprime[frame_idx, nxt]
        can_step = has_dip & (nxt > current) & (d_nxt < d_cur)
        if not np.any(can_step):
            break
        current = np.where(can_step, nxt, current)

    lo = np.clip(current - 1, 0, tau_max)
    hi = np.clip(current + 1, 0, tau_max)
    d_lo = dprime[frame_idx, lo]
    d_mid = dprime[frame_idx, current]
    d_hi = dprime[frame_idx, hi]
    denom = d_lo - 2.0 * d_mid + d_hi
    flat = np.abs(denom) < 1e-12
    shift = np.where(flat, 0.0, 0.5 * (d_lo - d_hi) / np.where(flat, 1.0, denom))
    shift = np.clip(shift, -1.0, 1.0)
    tau_refined = current.astype(np.float64) + shift

    f0 = sr / tau_refined

    frame_rms = np.sqrt(np.mean(frames[:, :WIN] ** 2, axis=1))
    rms_floor = 10.0 ** (RMS_FLOOR_DB / 20.0)
    quiet_floor = 0.05 * np.percentile(frame_rms, 95)
    low_energy = frame_rms < max(rms_floor, quiet_floor)
    out_of_range = (f0 < F_MIN) | (f0 > F_MAX)
    unvoiced = (~has_dip) | low_energy | out_of_range

    f0 = np.where(unvoiced, np.nan, f0)
    energy_db = 20.0 * np.log10(np.maximum(frame_rms, 1e-12))

    f0 = _smooth_and_prune(f0)
    return Track(times=times, f0=f0, energy_db=energy_db)


def _smooth_and_prune(f0: np.ndarray) -> np.ndarray:
    """Nan-aware median over MEDIAN_FRAMES, then drop short voiced runs.

    A frame that was unvoiced stays unvoiced regardless of its neighbours;
    the median only ever moves a voiced frame's value towards its voiced
    neighbours. Runs shorter than MIN_RUN_FRAMES are single-frame flukes,
    not real pitch.
    """
    pad = MEDIAN_FRAMES // 2
    padded = np.concatenate([np.full(pad, np.nan), f0, np.full(pad, np.nan)])
    windows = np.lib.stride_tricks.sliding_window_view(padded, MEDIAN_FRAMES)
    with np.errstate(all="ignore"), warnings.catch_warnings():
        # A window of all-nan (silence, or right at the padded edges) is
        # expected, not a bug: nanmedian warns about it every time anyway.
        warnings.simplefilter("ignore", category=RuntimeWarning)
        med = np.nanmedian(windows, axis=1)
    smoothed = np.where(np.isnan(f0), np.nan, med)

    voiced = ~np.isnan(smoothed)
    edges = np.flatnonzero(np.diff(np.concatenate(([0], voiced.astype(int), [0]))))
    for start, end in zip(edges[0::2], edges[1::2]):
        if end - start < MIN_RUN_FRAMES:
            smoothed[start:end] = np.nan
    return smoothed


def semitones(f0: np.ndarray) -> np.ndarray:
    """12 * log2(f0 / median f0), so each speaker is centred on themselves.

    A doubling of f0 is +12 semitones (an octave) regardless of whose
    voice it is; the two tracks become comparable shapes even though
    their absolute pitch never matches.
    """
    with np.errstate(all="ignore"), warnings.catch_warnings():
        # An all-nan track (a silent take) is handled just below.
        warnings.simplefilter("ignore", category=RuntimeWarning)
        med = np.nanmedian(f0) if len(f0) else np.nan
    if not np.isfinite(med) or med <= 0:
        return np.full_like(f0, np.nan)
    with np.errstate(divide="ignore", invalid="ignore"):
        return 12.0 * np.log2(f0 / med)


def _activity(tr: Track) -> np.ndarray:
    """[energy, voiced] per frame: the pitch-free half of _features.

    Used only for the coarse offset, which has to work before anything
    says which frames belong together, so it leaves the semitones (each
    centred on a median the offset has not settled yet) out.
    """
    energy = _relative_energy(tr) / ENERGY_SCALE_DB
    voiced = (~np.isnan(tr.f0)).astype(np.float64)
    return np.stack([energy, voiced], axis=1)


def _coarse_offset(line: Track, take: Track) -> int:
    """Lag, in frames over -0.5 s to +3.0 s, that best explains the take
    as silence with the line placed at that lag.

    Scored as the squared distance between the take's activity and that
    model over the whole take, plus the line frames that fall outside the
    take (heard against silence). Silence therefore matches silence: a
    long lead or tail neither rewards nor penalises any lag, which a plain
    cross correlation gets wrong (it scores the line's short pauses laid
    over the take's silence as a match). A direct loop over the few
    hundred lags, each O(n): not a search worth an FFT for.
    """
    act_line = _activity(line)
    act_take = _activity(take)
    silence = np.array([-ENERGY_RANGE_DB / ENERGY_SCALE_DB, 0.0])
    n_line, n_take = len(act_line), len(act_take)

    # Per frame squared distance of each track from silence, as prefix
    # sums, so every lag's "not overlapped" parts cost O(1).
    take_vs_silence = np.concatenate(([0.0], np.cumsum(np.sum((act_take - silence) ** 2, axis=1))))
    line_vs_silence = np.concatenate(([0.0], np.cumsum(np.sum((act_line - silence) ** 2, axis=1))))

    lag_min = int(round(-0.5 / HOP_S))
    lag_max = int(round(3.0 / HOP_S))
    best_lag, best_score = 0, np.inf
    for lag in range(lag_min, lag_max + 1):
        i_lo = max(0, -lag)
        i_hi = min(n_line, n_take - lag)
        if i_hi <= i_lo:
            continue
        overlap = float(np.sum((act_line[i_lo:i_hi] - act_take[i_lo + lag : i_hi + lag]) ** 2))
        take_rest = take_vs_silence[-1] - (take_vs_silence[i_hi + lag] - take_vs_silence[i_lo + lag])
        line_rest = line_vs_silence[-1] - (line_vs_silence[i_hi] - line_vs_silence[i_lo])
        score = overlap + take_rest + line_rest
        if score < best_score:
            best_score, best_lag = score, lag
    return best_lag


def _relative_energy(tr: Track) -> np.ndarray:
    """Energy in dB below the track's own loud level, floored at
    -ENERGY_RANGE_DB.

    The loud level is the 95th percentile frame, so it only depends on
    how loud the voice is, not on how much silence surrounds it: a take
    with a second of lead and tail reads the same over its spoken part as
    one without. The floor keeps digital silence (-240 dB) from swamping
    every mean and distance the aligner takes.
    """
    if len(tr.energy_db) == 0:
        return np.zeros(0)
    loud = float(np.percentile(tr.energy_db, 95))
    return np.clip(tr.energy_db - loud, -ENERGY_RANGE_DB, 0.0)


def _features(tr: Track) -> np.ndarray:
    """[energy, voiced, voiced * semitone / 4] per frame, for DTW cost.

    energy is _relative_energy scaled to 0 (loud) .. -3 (silence), the
    same range the other two terms move in.
    """
    st = semitones(tr.f0)
    voiced = ~np.isnan(tr.f0)
    energy = _relative_energy(tr) / ENERGY_SCALE_DB
    st_filled = np.where(voiced, st, 0.0)
    term3 = np.where(voiced, st_filled / 4.0, 0.0)
    return np.stack([energy, voiced.astype(np.float64), term3], axis=1)


def align(line: Track, take: Track) -> Alignment:
    """Map every line frame onto a take frame.

    Coarse cross correlation finds a starting offset, then a banded,
    asymmetric DTW refines it: the line advances one frame per step, the
    take advances 0, 1 or 2, so a stretch or a slack passage in the take
    is absorbed without needing the take to move at exactly the line's
    pace. In the DTW's own band-relative coordinate (distance from
    i + offset) this recurrence only ever looks at the neighbouring three
    columns of the previous row, so each row is one numpy operation and
    the loop over rows is the only one align() runs.

    Falls back to a plain constant shift when the path's mean energy and
    voicing distance is too high to trust (DTW_MAX_COST), which happens
    when the two tracks are not actually the same words spoken twice.
    """
    n_line = len(line.times)
    n_take = len(take.times)
    if n_line == 0 or n_take == 0:
        return Alignment(path_i=np.zeros(0, dtype=np.int64), method="offset", cost=float("inf"))

    offset = _coarse_offset(line, take)

    feat_line = _features(line)
    feat_take = _features(take)

    width = 2 * BAND + 1
    rel = np.arange(-BAND, BAND + 1)
    i_idx = np.arange(n_line)[:, None]
    j_grid = i_idx + offset + rel[None, :]
    valid = (j_grid >= 0) & (j_grid < n_take)
    j_clamped = np.clip(j_grid, 0, n_take - 1)

    diff = feat_line[:, None, :] - feat_take[j_clamped]
    cost = np.sqrt(np.sum(diff ** 2, axis=2))
    cost = np.where(valid, cost, np.inf)

    d = np.full((n_line, width), np.inf)
    back = np.zeros((n_line, width), dtype=np.int8)
    d[0] = cost[0]

    for i in range(1, n_line):
        prev = d[i - 1]
        cand_slope0 = np.concatenate((prev[1:], [np.inf]))  # take frame stalls: j' = j
        cand_slope1 = prev  # take advances 1: j' = j - 1
        cand_slope2 = np.concatenate(([np.inf], prev[:-1]))  # take advances 2: j' = j - 2
        # Slope 1 first: argmin keeps the first of equal costs, so over
        # identical frames (a long vowel after its carrier) the path moves
        # in step with the line instead of stalling on the carrier.
        stacked = np.stack([cand_slope1, cand_slope0, cand_slope2], axis=0)
        best = np.argmin(stacked, axis=0)
        best_val = np.take_along_axis(stacked, best[np.newaxis, :], axis=0)[0]
        d[i] = best_val + cost[i]
        back[i] = _STACK_SLOPES[best]

    last = d[-1]
    offset_path = np.clip(np.arange(n_line) + offset, 0, n_take - 1).astype(np.int64)
    if np.all(np.isinf(last)):
        return Alignment(path_i=offset_path, method="offset", cost=float("inf"))

    rel_idx = int(np.argmin(last))
    path_rel = np.zeros(n_line, dtype=np.int64)
    path_rel[-1] = rel_idx
    for i in range(n_line - 1, 0, -1):
        slope = back[i, rel_idx]
        if slope == 0:
            rel_idx += 1
        elif slope == 2:
            rel_idx -= 1
        path_rel[i - 1] = rel_idx
    path_i = np.clip(i_idx[:, 0] + offset + (path_rel - BAND), 0, n_take - 1).astype(np.int64)

    # Trust is judged on energy and voicing only. The pitch term steers the
    # path, but a pitch mismatch is what the caller is here to measure: a
    # flat reading of the right words must still align.
    gap = _activity(line) - _activity(take)[path_i]
    activity_cost = float(np.mean(np.sqrt(np.sum(gap ** 2, axis=1))))
    if activity_cost <= DTW_MAX_COST:
        return Alignment(path_i=path_i, method="dtw", cost=activity_cost)
    return Alignment(path_i=offset_path, method="offset", cost=activity_cost)


def usable(cleaned: bool, erle_db: float | None) -> bool:
    """Whether the take is trustworthy enough to draw a pitch line from.

    A take with nothing to clean (headphones, or the cleaner found no
    echo) never had the line mixed into it, so it is always usable. A
    cleaned take is only usable once the echo return loss enhancement
    clears MIN_TRUST_ERLE_DB: below that, enough of the voice survives in
    the residual that the tracker could easily be drawing its contour
    instead of the learner's.
    """
    if not cleaned or erle_db is None:
        return True
    return erle_db >= MIN_TRUST_ERLE_DB


def to_points(times: np.ndarray, st: np.ndarray) -> list[list[float | None]]:
    """[[t, semitones or null], ...] rounded for the wire."""
    points: list[list[float | None]] = []
    for t, v in zip(times, st):
        value = None if math.isnan(v) else round(float(v), 2)
        points.append([round(float(t), 3), value])
    return points


# --- mora logic ------------------------------------------------------------


def vowel(text: str) -> str | None:
    """Vowel of a mora from its last character, or None for ン, ッ and
    anything else that carries no vowel of its own."""
    if not text:
        return None
    return _CHAR_VOWEL.get(text[-1])


def classify(timeline: list[dict]) -> list[str | None]:
    """Per mora: "long", "geminate", "n" or None.

    A mora is "long" when it is a bare vowel that repeats the vowel of the
    mora right before it in the same phrase (キョ|オ, ケ|イ via the e/i
    exception): VOICEVOX spells every long vowel this way, never with ー.
    """
    out: list[str | None] = []
    for k, mora in enumerate(timeline):
        text = mora.get("text", "")
        if text == "ッ":
            out.append("geminate")
            continue
        if text == "ン":
            out.append("n")
            continue
        if text in ("ア", "イ", "ウ", "エ", "オ") and k > 0:
            prev = timeline[k - 1]
            if prev.get("phrase") == mora.get("phrase"):
                prev_vowel = vowel(prev.get("text", ""))
                this_vowel = vowel(text)
                if prev_vowel == this_vowel or (text == "イ" and prev_vowel == "e"):
                    out.append("long")
                    continue
        out.append(None)
    return out


def mora_windows(
    timeline: list[dict], speed: float, span: tuple[int, int] | None
) -> list[tuple[float, float] | None]:
    """Milliseconds of the reference render, one window per mora: same
    arithmetic as take_score.word_windows, but with MIN_MORA_MS instead of
    MIN_WORD_MS since moras are shorter than a word's 80 ms floor."""
    span_start, span_end = span if span is not None else (None, None)
    out: list[tuple[float, float] | None] = []
    for m in timeline:
        a = m["start"] / speed * 1000.0
        b = m["end"] / speed * 1000.0
        if span is not None:
            if b <= span_start or a >= span_end:
                out.append(None)
                continue
            a = max(a, span_start) - span_start
            b = min(b, span_end) - span_start
        if b - a < MIN_MORA_MS:
            out.append(None)
            continue
        out.append((a, b))
    return out


def nuclei(timeline: list[dict]) -> list[int | None]:
    """One entry per phrase index: the mora index of that phrase's pitch
    accent nucleus, or None for a heiban phrase, a single-mora phrase, or
    a phrase where any mora's `high` is missing."""
    phrases: dict[int, list[int]] = {}
    for k, mora in enumerate(timeline):
        phrases.setdefault(mora.get("phrase", 0), []).append(k)

    out: list[int | None] = [None] * (max(phrases) + 1 if phrases else 0)
    for phrase, idxs in phrases.items():
        highs = [timeline[k].get("high") for k in idxs]
        if len(idxs) < 2 or any(h is None for h in highs):
            continue
        nucleus_k = None
        for pos in range(len(idxs) - 1):
            if highs[pos] is True and highs[pos + 1] is False:
                nucleus_k = idxs[pos]
        out[phrase] = nucleus_k
    return out


def mora_means(
    times: np.ndarray, st: np.ndarray, windows: list[tuple[float, float] | None]
) -> list[float | None]:
    """Mean semitone over the line-grid frames inside each window, or None
    when the window is None or too little of it is voiced."""
    out: list[float | None] = []
    for win in windows:
        if win is None:
            out.append(None)
            continue
        a_ms, b_ms = win
        mask = (times >= a_ms / 1000.0) & (times < b_ms / 1000.0)
        vals = st[mask]
        if len(vals) == 0 or np.mean(~np.isnan(vals)) < COVERAGE_MIN:
            out.append(None)
            continue
        out.append(float(np.nanmean(vals)))
    return out


def mora_take_ms(
    path_i: np.ndarray, times: np.ndarray, windows: list[tuple[float, float] | None]
) -> list[int | None]:
    """Learner duration of each mora: the span of take frames the DTW path
    mapped the mora's line frames onto, at 10 ms per frame."""
    out: list[int | None] = []
    for win in windows:
        if win is None:
            out.append(None)
            continue
        a_ms, b_ms = win
        mask = (times >= a_ms / 1000.0) & (times < b_ms / 1000.0)
        idx = np.flatnonzero(mask)
        if len(idx) == 0:
            out.append(None)
            continue
        mapped = path_i[idx]
        out.append(int((mapped[-1] - mapped[0] + 1) * 10))
    return out


def length_marks(
    kinds: list[str | None],
    line_ms: list[int | None],
    take_ms: list[int | None],
    pair_take_ms: list[int | None] | None = None,
) -> list[str | None]:
    """"clipped", "none" or "ok" for every mora with a kind, None for the
    rest. Judged against the learner's own overall pace (the median
    take/line ratio over every mora with both values), so a take that is
    slow or fast throughout is not a wall of one verdict.

    pair_take_ms[k], when given for a "long" mora, is the take span of the
    carrier and the vowel together. The boundary between the two is
    arbitrary in the take (オ after コ sounds like more of the same
    vowel), so the pair is judged as one: clipped when it falls short of
    the carrier's full length plus CLIP_RATIO of the vowel's.
    """
    ratios = [
        take_ms[k] / line_ms[k]
        for k in range(len(line_ms))
        if line_ms[k] is not None and take_ms[k] is not None and line_ms[k] > 0
    ]
    rate = float(np.clip(np.median(ratios), RATE_MIN, RATE_MAX)) if ratios else 1.0

    out: list[str | None] = []
    for k, kind in enumerate(kinds):
        if kind is None:
            out.append(None)
            continue
        if take_ms[k] is None:
            out.append("none")
            continue
        line_val = line_ms[k]
        pair = pair_take_ms[k] if pair_take_ms is not None else None
        carrier = line_ms[k - 1] if kind == "long" and k > 0 else None
        if pair is not None and carrier is not None and line_val is not None:
            short = pair < rate * (carrier + CLIP_RATIO * line_val)
            out.append("clipped" if short else "ok")
            continue
        if line_val is not None and take_ms[k] < CLIP_RATIO * rate * line_val:
            out.append("clipped")
        else:
            out.append("ok")
    return out


def nucleus_marks(
    timeline: list[dict], nuclei_by_phrase: list[int | None], take_means: list[float | None]
) -> list[str | None]:
    """"hit", "miss" or "none" for every nucleus mora, None for the rest."""
    nucleus_set = {k for k in nuclei_by_phrase if k is not None}
    out: list[str | None] = []
    for k, mora in enumerate(timeline):
        if k not in nucleus_set:
            out.append(None)
            continue
        if take_means[k] is None:
            out.append("none")
            continue
        phrase = mora.get("phrase")
        next_mean = None
        for ahead in (1, 2):
            j = k + ahead
            if j < len(timeline) and timeline[j].get("phrase") == phrase and take_means[j] is not None:
                next_mean = take_means[j]
                break
        if next_mean is None:
            out.append("none")
            continue
        out.append("hit" if take_means[k] - next_mean >= NUCLEUS_DROP_ST else "miss")
    return out


def _empty_result(note: str) -> dict:
    return {
        "note": note,
        "aligned": None,
        "coverage": 0.0,
        "moras": [],
        "curve": {"line": [], "take": []},
    }


def analyse(
    ref: np.ndarray,
    take: np.ndarray,
    sr: int,
    timeline: list[dict],
    speed: float,
    span: tuple[int, int] | None,
    anchor_ms: float | None,
    cleaned: bool,
    erle_db: float | None,
) -> dict:
    """Mora length and pitch accent nucleus readings for one take.

    Tracks both wavs' pitch, aligns the take onto the line's frame grid,
    and turns the mapped curve into a length verdict (ok, clipped, none)
    and a nucleus verdict (hit, miss, none) per mora. Never raises: any
    odd input (empty timeline, empty arrays) gives the empty shape back
    with a note explaining why there is nothing to analyse.
    """
    if len(timeline) == 0 or len(ref) == 0 or len(take) == 0:
        return _empty_result("Nothing to analyse")

    windows = mora_windows(timeline, speed, span)
    if all(win is None for win in windows):
        return _empty_result("Nothing to analyse")
    if anchor_ms is not None:
        shift_ms = max(anchor_ms - _ANCHOR_LEAD_MS, 0.0)
        shift_samples = int(round(shift_ms / 1000.0 * sr))
        take_slice = take[shift_samples:]
    else:
        take_slice = take
    if len(take_slice) == 0:
        return _empty_result("Nothing to analyse")

    line_track = track(ref, sr)
    take_track = track(take_slice, sr)
    alignment = align(line_track, take_track)

    line_st = semitones(line_track.f0)
    mapped_f0 = take_track.f0[alignment.path_i] if len(alignment.path_i) else np.zeros(0)
    take_st = semitones(mapped_f0)
    coverage = float(np.mean(~np.isnan(take_st))) if len(take_st) else 0.0

    note = ""
    blank_marks = False
    if not usable(cleaned, erle_db):
        note = "Take too noisy to analyse"
        blank_marks = True
    elif coverage < _VOICE_FLOOR:
        note = "No voice heard in the take"
        blank_marks = True
    elif alignment.method == "offset":
        note = "Could not follow the take"
        blank_marks = True

    kinds = classify(timeline)
    nuclei_by_phrase = nuclei(timeline)
    take_means = mora_means(line_track.times, take_st, windows)
    line_means = mora_means(line_track.times, line_st, windows)
    take_ms = mora_take_ms(alignment.path_i, line_track.times, windows)
    line_ms: list[int | None] = [
        None if win is None else int(round(win[1] - win[0])) for win in windows
    ]
    pair_windows: list[tuple[float, float] | None] = [
        (windows[k - 1][0], windows[k][1])
        if kind == "long" and k > 0 and windows[k] is not None and windows[k - 1] is not None
        else None
        for k, kind in enumerate(kinds)
    ]
    pair_take_ms = mora_take_ms(alignment.path_i, line_track.times, pair_windows)

    if blank_marks:
        length = [None if m is None else "none" for m in length_marks(kinds, line_ms, take_ms, pair_take_ms)]
        nucleus = [None if m is None else "none" for m in nucleus_marks(timeline, nuclei_by_phrase, take_means)]
    else:
        length = length_marks(kinds, line_ms, take_ms, pair_take_ms)
        nucleus = nucleus_marks(timeline, nuclei_by_phrase, take_means)

    moras = []
    for k, mora in enumerate(timeline):
        if windows[k] is None:
            continue
        moras.append(
            {
                "i": k,
                "text": mora.get("text"),
                "kind": kinds[k],
                "lineMs": line_ms[k],
                "takeMs": take_ms[k],
                "length": length[k],
                "high": mora.get("high"),
                "lineSt": None if line_means[k] is None else round(line_means[k], 2),
                "takeSt": None if take_means[k] is None else round(take_means[k], 2),
                "nucleus": nucleus[k],
            }
        )

    return {
        "note": note,
        "aligned": alignment.method,
        "coverage": round(coverage, 2),
        "moras": moras,
        "curve": {
            "line": to_points(line_track.times, line_st),
            "take": to_points(line_track.times, take_st),
        },
    }
