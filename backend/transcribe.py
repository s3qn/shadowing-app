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


def transcribe(
    audio_path: Path,
    language: str | None = None,
    word_timestamps: bool = False,
    vad: bool = False,
) -> dict:
    """Transcribe a local audio file.

    With language=None whisper detects the language itself, so Sean can talk
    about his day in Hebrew or English without telling the app which. The
    detected language is returned so the generator can be told.

    `word_timestamps` also asks whisper for per-word timing, carried on each
    segment's `"words"` and flattened onto the top-level `"words"` list (both
    `[{"start", "end", "text"}, ...]`), for the import pipeline's aligner.
    `vad` filters silence before transcription, useful on a whole imported
    file rather than a short recording.

    Returns {"ok": bool, "text": str, "language": str,
    "segments": [{"start", "end", "text", "words"}, ...], "words": [...]}.
    `ok` is False on a missing file, a whisper crash or a model load
    failure; every other field is then empty. Never raises.
    """
    try:
        if not audio_path.exists():
            log.warning("transcribe: missing file %s", audio_path)
            return {"ok": False, "text": "", "language": "", "segments": [], "words": []}

        model = _get_model()
        start = time.monotonic()
        kwargs = {"language": language, "vad_filter": vad, "word_timestamps": word_timestamps}
        if word_timestamps:
            kwargs["condition_on_previous_text"] = False
        segments, info = model.transcribe(str(audio_path), **kwargs)
        seg_list = []
        words: list[dict] = []
        for s in segments:
            seg_words = [
                {"start": float(w.start), "end": float(w.end), "text": w.word}
                for w in (s.words or [])
            ] if word_timestamps else []
            seg_list.append({
                "start": float(s.start),
                "end": float(s.end),
                "text": s.text.strip(),
                "words": seg_words,
            })
            words.extend(seg_words)
        text = " ".join(s["text"] for s in seg_list if s["text"]).strip()

        log.info(
            "transcribed %s in %.1fs lang=%s chars=%d segments=%d",
            audio_path.name,
            time.monotonic() - start,
            getattr(info, "language", "?"),
            len(text),
            len(seg_list),
        )
        return {
            "ok": True,
            "text": text,
            "language": getattr(info, "language", "") or "",
            "segments": seg_list,
            "words": words,
        }
    except Exception:
        log.exception("transcribe failed for %s", audio_path)
        return {"ok": False, "text": "", "language": "", "segments": [], "words": []}
