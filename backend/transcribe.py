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
import threading
import time
from pathlib import Path

import pauses

log = logging.getLogger(__name__)

WHISPER_MODEL_SIZE = os.getenv("WHISPER_MODEL", "medium")
WHISPER_DEVICE = "cpu"
WHISPER_COMPUTE_TYPE = "int8"
# Two CTranslate2 workers share one copy of the weights (measured: same RSS
# as one), so a take's few seconds of decoding run beside an import's long
# transcription instead of queueing behind each of its 30 s windows. Each
# worker uses 4 threads; this box has 8 cores.
WHISPER_WORKERS = 2

_MODEL = None
# Two first transcriptions at once would otherwise both load the ~8s model.
_LOCK = threading.Lock()


def _get_model():
    """Lazy singleton. The model load happens once, on first transcription."""
    global _MODEL
    if _MODEL is not None:
        return _MODEL
    with _LOCK:
        if _MODEL is not None:
            return _MODEL
        from faster_whisper import WhisperModel

        start = time.monotonic()
        _MODEL = WhisperModel(
            WHISPER_MODEL_SIZE,
            device=WHISPER_DEVICE,
            compute_type=WHISPER_COMPUTE_TYPE,
            num_workers=WHISPER_WORKERS,
        )
        log.info(
            "whisper loaded (%s/%s/%s) in %.1fs",
            WHISPER_MODEL_SIZE,
            WHISPER_DEVICE,
            WHISPER_COMPUTE_TYPE,
            time.monotonic() - start,
        )
    return _MODEL


def warm_up() -> None:
    """Loads the model ahead of the first take, for a startup thread. Never
    raises."""
    try:
        _get_model()
    except Exception:
        log.exception("whisper warm-up failed")


def transcribe(
    audio_path: Path,
    language: str | None = None,
    word_timestamps: bool = False,
    vad: bool = False,
    fast: bool = False,
) -> dict:
    """Transcribe a local audio file.

    With language=None whisper detects the language itself, so Sean can talk
    about his day in Hebrew or English without telling the app which. The
    detected language is returned so the generator can be told.

    `word_timestamps` also asks whisper for per-word timing, carried on each
    segment's `"words"` and flattened onto the top-level `"words"` list (both
    `[{"start", "end", "text"}, ...]`), for the import pipeline's aligner.
    `vad` filters silence before transcription, useful on a whole imported
    file rather than a short recording. `fast` is for a take of one line:
    greedy decoding, no temperature fallback and no timestamp tokens, the
    cheapest settings that still read a clear line correctly.

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
        if fast:
            kwargs.update(beam_size=1, temperature=0.0, condition_on_previous_text=False,
                          without_timestamps=not word_timestamps)
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
        if word_timestamps and words:
            try:
                from faster_whisper.audio import decode_audio

                samples = decode_audio(str(audio_path), sampling_rate=16000)
                pauses.snap_words(words, pauses.find_pauses(samples, 16000))
            except Exception:
                log.exception("pause snapping skipped for %s", audio_path)

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
