"""English and Spanish speech with Kokoro (kokoro-onnx), the counterpart to
voicevox.py for ja. Model files are not in the repo. The model dir must hold
`kokoro-v1.0.onnx` and `voices-v1.0.bin`, downloaded from the GitHub release
`thewh1teagle/kokoro-onnx` tag `model-files-v1.0`. It is `KOKORO_MODEL_DIR`
when set, else `~/models/kokoro-timed` when its onnx exists (the re-export with
durations, see below), else `~/models/kokoro`. Both defaults sit outside any
worktree so they survive a worktree deletion, and dev and prod share them.

Output is 24kHz mono, the same rate VOICEVOX renders at, so aec.SR,
SLICE_RATE and the take cleaner work unchanged.

Kokoro's own `speed` is not a linear time stretch (0.5x renders about 2.03x
as long), which breaks the client's `start / speed` highlight maths. So the
model always renders at 1.0 and a slower or faster line is stretched with
ffmpeg rubberband, which is linear and keeps the pitch and the 24kHz rate.

Word timing: kokoro-onnx can return Kokoro's own per-phoneme durations
(`create_timed`), but only when the ONNX export has a `duration` output. The
stock `kokoro-v1.0.onnx` does not; a re-export with `scripts/export.py` from
the kokoro-onnx repo does. Without it `synthesize_timed` returns no timings
and the caller falls back to whisper.
"""

import io
import logging
import os
import shutil
import subprocess
import tempfile
import threading
import wave
from pathlib import Path

log = logging.getLogger(__name__)

ONNX_NAME = "kokoro-v1.0.onnx"
VOICES_NAME = "voices-v1.0.bin"


def resolve_model_dir() -> Path:
    """KOKORO_MODEL_DIR if set, else the timed export if present, else stock."""
    override = os.getenv("KOKORO_MODEL_DIR", "").strip()
    if override:
        return Path(override).expanduser()
    timed = Path.home() / "models" / "kokoro-timed"
    if (timed / ONNX_NAME).exists():
        return timed
    return Path.home() / "models" / "kokoro"


MODEL_DIR = resolve_model_dir()
MODEL_PATH = MODEL_DIR / ONNX_NAME
VOICES_PATH = MODEL_DIR / VOICES_NAME

# kokoro-onnx 0.6.1 pads the gap after every full stop and comma once it has
# timings, so the timed model would render the same text longer than stock.
# No extra pauses keeps the two renders the same length: stored wavs, speed
# variants and the retime frame gate all rely on that.
NO_PAUSES = {"sentence_pause": 0.0, "clause_pause": 0.0}


class KokoroError(RuntimeError):
    pass


# The ONNX session is not built for concurrent calls and the machine is CPU
# bound anyway, so synthesis is serialized rather than pooled.
_LOCK = threading.Lock()
_KOKORO = None


def _get_kokoro():
    global _KOKORO
    if _KOKORO is None:
        if not MODEL_PATH.exists() or not VOICES_PATH.exists():
            raise KokoroError(
                f"Kokoro model files not found in {MODEL_DIR}. Set KOKORO_MODEL_DIR or"
                " download kokoro-v1.0.onnx and voices-v1.0.bin from the"
                " thewh1teagle/kokoro-onnx model-files-v1.0 release."
            )
        try:
            from kokoro_onnx import Kokoro

            _KOKORO = Kokoro(str(MODEL_PATH), str(VOICES_PATH))
            log.info(
                "kokoro model loaded from %s (phoneme timings: %s)",
                MODEL_DIR, bool(getattr(_KOKORO, "has_timings", False)),
            )
        except KokoroError:
            raise
        except Exception as exc:
            raise KokoroError(f"Kokoro failed to load: {exc}") from exc
    return _KOKORO


def warm_up() -> None:
    """Load the model now rather than on the first line, so the first en or
    es island does not wait for it. Blocking; logs and returns on failure."""
    try:
        with _LOCK:
            _get_kokoro()
    except KokoroError as exc:
        log.warning("kokoro warm-up skipped: %s", exc)


def _to_wav(samples, sample_rate: int) -> bytes:
    import numpy as np

    pcm = np.clip(samples, -1.0, 1.0)
    pcm16 = (pcm * 32767.0).astype("<i2")
    buf = io.BytesIO()
    with wave.open(buf, "wb") as dst:
        dst.setnchannels(1)
        dst.setsampwidth(2)
        dst.setframerate(sample_rate)
        dst.writeframes(pcm16.tobytes())
    return buf.getvalue()


def _stretch_wav(wav: bytes, speed: float) -> bytes:
    """Time-stretch a wav with rubberband, pitch preserved. Output is
    1/speed of the input length. Uses temp files, not pipes, so the result
    has a real RIFF header. Raises KokoroError on any ffmpeg failure."""
    tmpdir = tempfile.mkdtemp(prefix="kokoro-stretch-")
    try:
        src = os.path.join(tmpdir, "in.wav")
        dst = os.path.join(tmpdir, "out.wav")
        with open(src, "wb") as f:
            f.write(wav)
        try:
            subprocess.run(
                [
                    "ffmpeg", "-y", "-i", src,
                    "-filter:a", f"rubberband=tempo={speed}",
                    "-c:a", "pcm_s16le",
                    "-f", "wav", dst,
                ],
                capture_output=True,
                check=True,
                timeout=120,
            )
            with open(dst, "rb") as f:
                out = f.read()
        except (OSError, subprocess.SubprocessError) as exc:
            raise KokoroError(f"could not change the playback speed: {exc}") from exc
        if not out:
            raise KokoroError("could not change the playback speed: empty output")
        return out
    finally:
        shutil.rmtree(tmpdir, ignore_errors=True)


def synthesize(text: str, voice: str, lang: str, speed: float = 1.0) -> tuple[bytes, float]:
    """Render one line. Returns (wav bytes, duration in seconds).

    The model always renders at 1.0. For speed != 1.0 the wav is then
    stretched with rubberband, so the duration is 1/speed of the normal
    render and the client's `start / speed` stays exact.

    Blocking and CPU-bound; callers use asyncio.to_thread. Raises
    KokoroError if the model is missing, synthesis fails or the stretch
    fails, so the caller can mark the island failed rather than storing a
    silent line (or the unstretched render under a slow speed).
    """
    with _LOCK:
        # Loaded under the lock, so two first requests load the model once.
        kokoro = _get_kokoro()
        try:
            samples, sample_rate = kokoro.create(
                text, voice=voice, speed=1.0, lang=lang, **NO_PAUSES
            )
        except Exception as exc:
            raise KokoroError(f"Kokoro synthesis failed for {text!r}: {exc}") from exc
    wav = _to_wav(samples, sample_rate)
    if speed != 1.0:
        wav = _stretch_wav(wav, speed)
        with wave.open(io.BytesIO(wav), "rb") as w:
            return wav, w.getnframes() / w.getframerate()
    duration = (len(samples) / sample_rate) if sample_rate else 0.0
    return wav, duration


def has_timings() -> bool | None:
    """True when the loaded model exports phoneme durations, False when it
    does not, None before the model has loaded."""
    if _KOKORO is None:
        return None
    return bool(getattr(_KOKORO, "has_timings", False))


def synthesize_timed(text: str, voice: str, lang: str) -> tuple[bytes, float, list[dict]]:
    """Render one line at speed 1.0 with Kokoro's phoneme durations. Returns
    (wav bytes, duration, timings) where timings is
    [{"phoneme", "start", "end"}] in seconds, or [] when the model has no
    duration output (then this is `synthesize` at 1.0). Same blocking and
    error contract as `synthesize`."""
    with _LOCK:
        kokoro = _get_kokoro()
        try:
            if getattr(kokoro, "has_timings", False):
                samples, sample_rate, raw = kokoro.create_timed(
                    text, voice=voice, speed=1.0, lang=lang, **NO_PAUSES
                )
                timings = [
                    {"phoneme": t.phoneme, "start": float(t.start), "end": float(t.end)}
                    for t in raw
                ]
            else:
                samples, sample_rate = kokoro.create(
                    text, voice=voice, speed=1.0, lang=lang, **NO_PAUSES
                )
                timings = []
        except Exception as exc:
            raise KokoroError(f"Kokoro synthesis failed for {text!r}: {exc}") from exc
    wav = _to_wav(samples, sample_rate)
    duration = (len(samples) / sample_rate) if sample_rate else 0.0
    return wav, duration, timings
