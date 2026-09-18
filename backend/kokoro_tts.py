"""English and Spanish speech with Kokoro (kokoro-onnx), the counterpart to
voicevox.py for ja. Model files are not in the repo: `KOKORO_MODEL_DIR`
(default `~/models/kokoro`, outside any worktree so it survives a worktree
deletion) must hold `kokoro-v1.0.onnx` and `voices-v1.0.bin`, downloaded from
the GitHub release `thewh1teagle/kokoro-onnx` tag `model-files-v1.0`.

Output is 24kHz mono, the same rate VOICEVOX renders at, so aec.SR,
SLICE_RATE and the take cleaner work unchanged.
"""

import io
import logging
import os
import threading
import wave
from pathlib import Path

log = logging.getLogger(__name__)

MODEL_DIR = Path(os.getenv("KOKORO_MODEL_DIR", Path.home() / "models" / "kokoro"))
MODEL_PATH = MODEL_DIR / "kokoro-v1.0.onnx"
VOICES_PATH = MODEL_DIR / "voices-v1.0.bin"


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
        log.info("kokoro model loaded from %s", MODEL_DIR)
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


def synthesize(text: str, voice: str, lang: str, speed: float = 1.0) -> tuple[bytes, float]:
    """Render one line. Returns (wav bytes, duration in seconds).

    Blocking and CPU-bound; callers use asyncio.to_thread. Raises
    KokoroError if the model is missing or synthesis fails, so the caller
    can mark the island failed rather than storing a silent line.
    """
    with _LOCK:
        # Loaded under the lock, so two first requests load the model once.
        kokoro = _get_kokoro()
        try:
            samples, sample_rate = kokoro.create(text, voice=voice, speed=speed, lang=lang)
        except Exception as exc:
            raise KokoroError(f"Kokoro synthesis failed for {text!r}: {exc}") from exc
    duration = (len(samples) / sample_rate) if sample_rate else 0.0
    return _to_wav(samples, sample_rate), duration
