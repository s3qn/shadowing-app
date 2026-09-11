"""Local speech-to-text with faster-whisper.

Ported from the working module in AI-Social-Content-Generator, keeping the two
properties that matter: a lazy singleton so the model load cost is paid once per
process, and a never-raises contract so a bad recording degrades to an empty
transcript instead of a 500.

Measured on this machine: model load ~8s, then ~22s for a 1-minute clip at
medium/cpu/int8. The medium and small models are already in the HuggingFace
cache, so there is no download on first run.

BLOCKING. Callers must use asyncio.to_thread, or the whole API freezes for the
duration of the transcription.
"""

import logging
import os
import time
from pathlib import Path

log = logging.getLogger(__name__)

WHISPER_MODEL_SIZE = os.getenv("WHISPER_MODEL", "medium")
WHISPER_DEVICE = "cpu"
WHISPER_COMPUTE_TYPE = "int8"

_MODEL = None


def _get_model():
    """Lazy singleton. The model load happens once, on first transcription."""
    global _MODEL
    if _MODEL is None:
        from faster_whisper import WhisperModel

        start = time.monotonic()
        _MODEL = WhisperModel(
            WHISPER_MODEL_SIZE,
            device=WHISPER_DEVICE,
            compute_type=WHISPER_COMPUTE_TYPE,
        )
        log.info(
            "whisper loaded (%s/%s/%s) in %.1fs",
            WHISPER_MODEL_SIZE,
            WHISPER_DEVICE,
            WHISPER_COMPUTE_TYPE,
            time.monotonic() - start,
        )
    return _MODEL


def transcribe(audio_path: Path, language: str | None = "en") -> dict:
    """Transcribe a local audio file.

    Returns {"text": str, "segments": [{"start","end","text"}, ...]}.
    Returns empty values on any failure, never raises.
    """
    try:
        if not audio_path.exists():
            log.warning("transcribe: missing file %s", audio_path)
            return {"text": "", "segments": []}

        model = _get_model()
        start = time.monotonic()
        segments, info = model.transcribe(str(audio_path), language=language)
        seg_list = [
            {"start": float(s.start), "end": float(s.end), "text": s.text.strip()}
            for s in segments
        ]
        text = " ".join(s["text"] for s in seg_list if s["text"]).strip()

        log.info(
            "transcribed %s in %.1fs lang=%s chars=%d segments=%d",
            audio_path.name,
            time.monotonic() - start,
            getattr(info, "language", "?"),
            len(text),
            len(seg_list),
        )
        return {"text": text, "segments": seg_list}
    except Exception:
        log.exception("transcribe failed for %s", audio_path)
        return {"text": "", "segments": []}
