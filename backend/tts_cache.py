"""The (voice, text) render cache every user shares:
`DATA_DIR/tts-cache/<voice id>/<sha1(norm text)>.wav` plus a `.json` with the
duration and timings. Only 1.0 renders are stored; speed variants are
stretched from them. Blocking IO, meant for asyncio.to_thread."""

import hashlib
import json
import re
import unicodedata
from pathlib import Path

import store
from tts_registry import Render

CACHE_DIR = store.DATA_DIR / "tts-cache"

_WS = re.compile(r"\s+")


def norm(text: str) -> str:
    return _WS.sub(" ", unicodedata.normalize("NFC", text)).strip()


def path_for(voice: int, text: str) -> Path:
    digest = hashlib.sha1(norm(text).encode("utf-8")).hexdigest()
    return CACHE_DIR / str(voice) / f"{digest}.wav"


def get(voice: int, text: str) -> Render | None:
    wav_path = path_for(voice, text)
    meta_path = wav_path.with_suffix(".json")
    if not wav_path.exists() or not meta_path.exists():
        return None
    try:
        meta = json.loads(meta_path.read_text(encoding="utf-8"))
        wav = wav_path.read_bytes()
    except (OSError, ValueError):
        return None
    return Render(
        wav=wav,
        duration=float(meta.get("duration", 0.0)),
        timeline=meta.get("timeline", []),
        kana=meta.get("kana", ""),
        phonemes=meta.get("phonemes", []),
        pieces=meta.get("pieces", []),
        voice=voice,
    )


def put(voice: int, text: str, render: Render) -> None:
    # Imported here: services.line_audio imports voices, which imports this module.
    from services.line_audio import _write_atomic

    wav_path = path_for(voice, text)
    wav_path.parent.mkdir(parents=True, exist_ok=True)
    meta = {
        "duration": render.duration,
        "timeline": render.timeline,
        "kana": render.kana,
        "phonemes": render.phonemes,
        "pieces": render.pieces,
    }
    _write_atomic(wav_path, render.wav)
    _write_atomic(wav_path.with_suffix(".json"), json.dumps(meta, ensure_ascii=False).encode("utf-8"))
