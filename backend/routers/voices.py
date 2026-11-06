# Routes for voices, moved out of main.py.
import hashlib
import logging
import os

from fastapi import APIRouter, Header, HTTPException, Query
from fastapi.responses import FileResponse, Response

import config
import dependencies
import kokoro_tts
import store
import voices
import voicevox

router = APIRouter()
log = logging.getLogger("shadow")

PREVIEW_TEXT = {
    "ja": "はじめまして。今日はいい天気ですね。",
    "en": "Hello, nice to meet you. It's a fine day today.",
    "es": "Hola, mucho gusto. Hoy hace buen tiempo.",
}
PREVIEW_DIR = store.DATA_DIR / "previews"


@router.get("/shadow/speakers")
async def speakers(language: str = "ja",
                   authorization: str | None = Header(None)) -> list[dict]:
    """Every speaker for one learning language: VOICEVOX's own list for ja,
    one Kokoro entry with a style per voice for en or es."""
    dependencies.require_token(authorization)
    try:
        return await voices.list_speakers(language)
    except Exception as exc:
        raise HTTPException(502, {"code": "voice_unreachable"}) from exc


@router.get("/shadow/speakers/{speaker_uuid}/icon/{style_id}")
async def speaker_icon(speaker_uuid: str, style_id: int, token: str = "",
                       authorization: str | None = Header(None)) -> Response:
    dependencies._token_or_header(token, authorization)
    try:
        info = await voicevox.speaker_info(speaker_uuid)
        style = next((st for st in info["style_infos"] if st["id"] == style_id), None)
        if style is None:
            raise HTTPException(404, "no such style")
        png = await voicevox.fetch_resource(style["icon"])
    except HTTPException:
        raise
    except Exception as exc:
        raise HTTPException(502, {"code": "voice_unreachable"}) from exc
    return Response(content=png, media_type="image/png",
                    headers={"Cache-Control": "public, max-age=86400"})


@router.get("/shadow/voices/{style_id}/preview")
async def voice_preview(style_id: int, token: str = "",
                        authorization: str | None = Header(None)) -> FileResponse:
    """The same sentence in any voice, rendered once and kept on disk."""
    dependencies._token_or_header(token, authorization)
    PREVIEW_DIR.mkdir(parents=True, exist_ok=True)
    path = PREVIEW_DIR / f"{style_id}.wav"
    if not path.exists():
        text = PREVIEW_TEXT[voices.language_for(style_id)]
        try:
            wav, _, _, _ = await voices.speak(text, style_id)
        except (voicevox.VoicevoxError, kokoro_tts.KokoroError) as exc:
            log.warning("voice failed: %s", exc)
            raise HTTPException(502, {"code": "voice_unreachable"}) from exc
        path.write_bytes(wav)
    return FileResponse(path, media_type="audio/wav")




@router.get("/shadow/word-audio")
async def word_audio(text: str, speaker: int = voicevox.DEFAULT_SPEAKER, token: str = "",
                     authorization: str | None = Header(None),
                     x_shadow_device: str = Header(""),
                     device_q: str = Query("", alias="device")) -> FileResponse:
    """One word rendered on its own, so hearing it again is a complete,
    natural utterance rather than a slice cut out of the line. Cached per
    voice and text."""
    dependencies._token_or_header(token, authorization)
    device = dependencies._require_device(x_shadow_device, device_q)
    clean = text.strip(config.WORD_STRIP)
    if not clean:
        raise HTTPException(400, "empty word")
    folder = store.DATA_DIR / "words" / str(speaker)
    folder.mkdir(parents=True, exist_ok=True)
    path = folder / f"{hashlib.sha1(clean.encode()).hexdigest()[:16]}.wav"
    if not path.exists():
        dependencies._take_use_slot(device, "word_audio")
        try:
            wav, _, _, _ = await voices.speak(clean, speaker)
        except (voicevox.VoicevoxError, kokoro_tts.KokoroError) as exc:
            log.warning("voice failed: %s", exc)
            raise HTTPException(502, {"code": "voice_unreachable"}) from exc
        tmp = path.with_suffix(".tmp")
        tmp.write_bytes(wav)
        os.replace(tmp, path)
    return FileResponse(path, media_type="audio/wav")
