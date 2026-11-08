# Routes for voices, moved out of main.py.
import logging

from fastapi import APIRouter, Header, HTTPException, Query
from fastapi.responses import FileResponse, Response

import config
import dependencies
import tts_cache
import tts_registry
import voices
import voicevox

router = APIRouter()
log = logging.getLogger("shadow")

PREVIEW_TEXT = {
    "ja": "はじめまして。今日はいい天気ですね。",
    "en": "Hello, nice to meet you. It's a fine day today.",
    "es": "Hola, mucho gusto. Hoy hace buen tiempo.",
    "fr": "Bonjour, enchanté. Il fait beau aujourd'hui.",
    "pt": "Olá, muito prazer. Hoje o tempo está bom.",
    "zh": "你好，很高兴认识你。今天天气很好。",
    "ko": "안녕하세요, 만나서 반갑습니다. 오늘 날씨가 좋네요.",
    "de": "Hallo, freut mich. Heute ist schönes Wetter.",
    "he": "שלום, נעים מאוד. מזג האוויר יפה היום.",
    "ar": "مرحبا، تشرفت بمعرفتك. الطقس جميل اليوم.",
}


@router.get("/shadow/speakers")
async def speakers(language: str = "ja",
                   authorization: str | None = Header(None)) -> list[dict]:
    """Every speaker for one learning language: VOICEVOX's own list for ja,
    one entry per other provider with a style per voice."""
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
                        authorization: str | None = Header(None)) -> Response:
    """The same sentence in any voice, rendered once into the shared cache.
    A hosted voice that is out of budget or down answers in the free voice."""
    dependencies._token_or_header(token, authorization)
    language = tts_registry.language_for(style_id)
    if language not in PREVIEW_TEXT:
        raise HTTPException(404, "no such voice")
    try:
        out = await voices.render(PREVIEW_TEXT[language], style_id)
    except voices.VOICE_ERRORS as exc:
        log.warning("voice failed: %s", exc)
        raise HTTPException(502, {"code": "voice_unreachable"}) from exc
    return _wav_response(style_id, PREVIEW_TEXT[language], out)


def _wav_response(voice: int, text: str, out) -> Response:
    """The cached file when this voice rendered it (Range works on iOS), else
    the bytes of the fallback render."""
    # A fallback render is cached under the voice that really rendered it,
    # so serve that file too: a raw Response has no Range and iOS refuses it.
    path = tts_cache.path_for(out.voice or voice, text)
    if path.is_file():
        return FileResponse(path, media_type="audio/wav")
    return Response(content=out.wav, media_type="audio/wav")


@router.get("/shadow/word-audio")
async def word_audio(text: str, speaker: int = voicevox.DEFAULT_SPEAKER, token: str = "",
                     authorization: str | None = Header(None),
                     x_shadow_device: str = Header(""),
                     device_q: str = Query("", alias="device")) -> Response:
    """One word rendered on its own, so hearing it again is a complete,
    natural utterance rather than a slice cut out of the line. Cached per
    voice and text in the shared render cache; the daily slot is spent only
    on a miss."""
    dependencies._token_or_header(token, authorization)
    device = dependencies._require_device(x_shadow_device, device_q)
    clean = text.strip(config.WORD_STRIP)
    if not clean:
        raise HTTPException(400, "empty word")
    if len(clean) > 40:
        raise HTTPException(400, "word too long")
    voice = tts_registry.voice(speaker)
    if voice is None:
        raise HTTPException(404, "no such voice")
    if tts_cache.get(speaker, clean) is None:
        dependencies._take_use_slot(device, "word_audio")
    try:
        out = await voices.render(clean, speaker, device if voice.hosted else "")
    except voices.VOICE_ERRORS as exc:
        log.warning("voice failed: %s", exc)
        raise HTTPException(502, {"code": "voice_unreachable"}) from exc
    return _wav_response(speaker, clean, out)
