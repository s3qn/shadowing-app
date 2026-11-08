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
import sys
import threading
import time
from pathlib import Path

import lang_text
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

HE_MODEL_ID = "ivrit-ai/whisper-large-v3-turbo-ct2"
# The Hebrew model is about 1.0-1.1 GB resident, so it unloads after this much
# idle time.
# The medium model is the hot path for takes and is never unloaded.
IVRIT_IDLE_S = 600

# Loaded models by name: "medium" (default) and "he" (ivrit).
_MODELS: dict = {}
# Two first transcriptions at once would otherwise both load the ~8s model.
_LOCK = threading.Lock()
# Guarded by _LOCK: transcriptions running on the ivrit model and the idle timer.
_HE_USERS = 0
_HE_TIMER: threading.Timer | None = None
# Bumped on every re-arm, so a timer that fired just before a cancel sees a
# newer generation and does nothing.
_HE_GEN = 0
# Detection only counts when the winner of Hebrew vs English is this sure, or
# leads the other by HE_EN_MARGIN with at least HE_EN_MIN_P.
HE_EN_CONFIDENT_P = 0.6
HE_EN_MIN_P = 0.3
HE_EN_MARGIN = 0.25


def _get_model(name: str = "medium"):
    """Lazy singleton per model name. The load happens once, on first use."""
    model = _MODELS.get(name)
    if model is not None:
        return model
    with _LOCK:
        model = _MODELS.get(name)
        if model is not None:
            return model
        from faster_whisper import WhisperModel

        start = time.monotonic()
        if name == "he":
            size, workers = HE_MODEL_ID, 1
        else:
            size, workers = WHISPER_MODEL_SIZE, WHISPER_WORKERS
        model = WhisperModel(
            size,
            device=WHISPER_DEVICE,
            compute_type=WHISPER_COMPUTE_TYPE,
            num_workers=workers,
        )
        _MODELS[name] = model
        log.info(
            "whisper loaded (%s/%s/%s) in %.1fs",
            size,
            WHISPER_DEVICE,
            WHISPER_COMPUTE_TYPE,
            time.monotonic() - start,
        )
    return model


def _he_begin() -> None:
    """Marks an ivrit transcription as running so the idle unload waits."""
    global _HE_USERS
    with _LOCK:
        _HE_USERS += 1


def _he_end() -> None:
    """Ends an ivrit use and re-arms the idle-unload timer."""
    global _HE_USERS, _HE_TIMER, _HE_GEN
    with _LOCK:
        _HE_USERS = max(0, _HE_USERS - 1)
        if _HE_TIMER is not None:
            _HE_TIMER.cancel()
        _HE_GEN += 1
        _HE_TIMER = threading.Timer(IVRIT_IDLE_S, _unload_he_if_idle, args=(_HE_GEN,))
        _HE_TIMER.daemon = True
        _HE_TIMER.start()


def _unload_he_if_idle(gen: int | None = None) -> bool:
    """Frees the ivrit model when no transcription is using it. A timer passes
    its generation; a stale one (re-armed since) does nothing. Returns True
    when the model was freed."""
    global _HE_TIMER
    with _LOCK:
        if gen is not None and gen != _HE_GEN:
            return False
        if _HE_USERS > 0 or "he" not in _MODELS:
            return False
        del _MODELS["he"]
        _HE_TIMER = None
    import gc

    gc.collect()
    # glibc keeps freed heap pages; without the trim RSS barely drops
    # (measured 1089 -> 1019 MB without, -> 149 MB with).
    if sys.platform.startswith("linux"):
        try:
            import ctypes

            ctypes.CDLL("libc.so.6").malloc_trim(0)
        except Exception:
            log.exception("malloc_trim failed")
    log.info("ivrit model unloaded after idle")
    return True


def detect_he_en(audio_path: Path) -> str | None:
    """Tells Hebrew from English in the first 30 s using the loaded medium
    model's encoder (one pass, no transcription). Returns "he" or "en" only
    when confident (see HE_EN_CONFIDENT_P), so callers keep their own default
    on a weak lean; None when the clip is neither or unsure. Never raises."""
    try:
        from faster_whisper.audio import decode_audio

        audio = decode_audio(str(audio_path), sampling_rate=16000)[: 16000 * 30]
        res = _get_model().detect_language(audio)
        probs = dict(res[2]) if len(res) > 2 and res[2] else {}
        p_he = float(probs.get("he", 0.0))
        p_en = float(probs.get("en", 0.0))
        lang, p, other = ("he", p_he, p_en) if p_he >= p_en else ("en", p_en, p_he)
        if p >= HE_EN_CONFIDENT_P:
            return lang
        if p >= HE_EN_MIN_P and p - other >= HE_EN_MARGIN:
            return lang
        return None
    except Exception:
        log.exception("language detection failed for %s", audio_path)
        return None


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
    initial_prompt: str | None = None,
    model: str = "default",
) -> dict:
    """Transcribe a local audio file.

    With language=None whisper detects the language itself, so Sean can talk
    about his day in Hebrew or English without telling the app which. The
    detected language is returned so the generator can be told.
    `initial_prompt` is a short sentence in the pinned language that steers
    the script and spelling (Simplified characters, Hangul, accents); the
    text comes back in the script the lines use (`lang_text.normalize_transcript`).

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

    `model="he"` uses the ivrit Hebrew model; if it cannot load, the default
    model runs with language="he" instead.
    """
    he_used = False
    try:
        if not audio_path.exists():
            log.warning("transcribe: missing file %s", audio_path)
            return {"ok": False, "text": "", "language": "", "segments": [], "words": []}

        if model == "he":
            _he_begin()
            he_used = True
            try:
                wm = _get_model("he")
            except Exception:
                log.exception("ivrit model failed to load, using the default model")
                wm = _get_model()
                language = "he"
        else:
            wm = _get_model()
        start = time.monotonic()
        kwargs = {"language": language, "vad_filter": vad, "word_timestamps": word_timestamps}
        if word_timestamps:
            kwargs["condition_on_previous_text"] = False
        if fast:
            kwargs.update(beam_size=1, temperature=0.0, condition_on_previous_text=False,
                          without_timestamps=not word_timestamps)
        if initial_prompt:
            kwargs["initial_prompt"] = initial_prompt
        segments, info = wm.transcribe(str(audio_path), **kwargs)
        heard = getattr(info, "language", None) or language or ""

        def script(s: str) -> str:
            return lang_text.normalize_transcript(s, heard)

        seg_list = []
        words: list[dict] = []
        for s in segments:
            seg_words = [
                {"start": float(w.start), "end": float(w.end), "text": script(w.word)}
                for w in (s.words or [])
            ] if word_timestamps else []
            seg_list.append({
                "start": float(s.start),
                "end": float(s.end),
                "text": script(s.text.strip()),
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
    finally:
        if he_used:
            _he_end()
