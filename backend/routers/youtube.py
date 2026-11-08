# Routes for youtube, moved out of main.py.
import asyncio
import logging

from fastapi import APIRouter, BackgroundTasks, File, Header, HTTPException, Request, UploadFile

import config
import dependencies
import languages
import media as media_io
import repair
import store
import store_video
import voicevox
import voices
import youtube
from routers import align as align_r
from services import captions

router = APIRouter()
log = logging.getLogger("shadow")


# --- youtube-shadowing ---
@router.get("/shadow/youtube/info")
async def youtube_info(url: str, authorization: str | None = Header(None),
                       x_shadow_device: str = Header("")) -> dict:
    """Title, author and thumbnail for a pasted YouTube link."""
    dependencies.require_token(authorization)
    dependencies._require_device(x_shadow_device)
    video_id = youtube.parse_video_id(url)
    if video_id is None:
        raise HTTPException(400, {"code": "youtube_bad_link"})
    info = await asyncio.to_thread(youtube.oembed_info, video_id)
    return {
        "video_id": video_id,
        "url": youtube.watch_url(video_id),
        "title": info.get("title", ""),
        "author": info.get("author", ""),
        "thumbnail": info.get("thumbnail") or f"https://i.ytimg.com/vi/{video_id}/hqdefault.jpg",
    }


@router.post("/shadow/youtube/captions")
async def import_youtube_captions(
    request: Request,
    background: BackgroundTasks,
    authorization: str | None = Header(None),
    x_shadow_device: str = Header(""),
) -> dict:
    """Build a video island from caption events the phone fetched. The body is
    untrusted: size, shape and timestamps are checked before a build slot is
    taken, so a bad request never burns a daily create. `asr_events`, the
    auto track when the picked track is manual, gives ja lines their word
    times (yt-precise)."""
    dependencies.require_token(authorization)
    device = dependencies._require_device(x_shadow_device)
    body = await captions._captions_body(request)
    url, title = body.get("url"), body.get("title", "")
    speaker = body.get("speaker", voicevox.DEFAULT_SPEAKER)
    language, native = body.get("language", "ja"), body.get("native", "en")
    if (not isinstance(url, str) or not isinstance(title, str) or isinstance(speaker, bool)
            or not isinstance(speaker, int) or not isinstance(language, str)
            or not isinstance(native, str)):
        raise HTTPException(400, {"code": "captions_invalid"})
    languages.require_learning(language, device)
    if native not in ("he", "en"):
        raise HTTPException(400, "native must be 'he' or 'en'")
    if language == native:
        raise HTTPException(400, "the learning language must differ from the native one")
    if voices.language_for(speaker) != language:
        raise HTTPException(400, "that voice does not speak the chosen language")
    video_id = youtube.parse_video_id(url)
    if video_id is None:
        raise HTTPException(400, {"code": "youtube_bad_link"})
    dropped: list[int] = []
    try:
        lines = youtube.json3_to_lines(body.get("events"), dropped)
    except youtube.CaptionsInvalid:
        raise HTTPException(400, {"code": "captions_invalid"})
    # The ASR track only refines timing: a bad or oversized one is dropped
    # and the manual track imports as it would without it.
    asr_events = body.get("asr_events") or []
    try:
        tokens = youtube.asr_tokens(asr_events)
    except youtube.CaptionsInvalid as exc:
        log.warning("youtube import %s: asr track ignored (%s)", video_id, exc)
        asr_events, tokens = [], []
    if not lines:
        raise HTTPException(400, {"code": "no_captions"})

    island_title = title.strip()[:200] or "YouTube video"
    dependencies._take_build_slot(device, "create", "import")
    island_id = store.create_island(
        "simple", speaker, language=language, native=native, source="youtube",
        source_name=video_id, device=device,
    )
    store_video.add_video(island_id, video_id, 0.0, island_title, "")
    if dropped:
        await asyncio.to_thread(store_video.set_lines_dropped, island_id, dropped[0])
    # youtube-asr-context-repair: the watch page's context rides along with
    # the captions; an empty one never blocks the import.
    context = repair.clean_context(body.get("context"))
    await asyncio.to_thread(store_video.set_repair_context, video_id, context)
    log.info("youtube import %s: context title=%r description=%d chars keywords=%d chapters=%d",
             video_id, context["title"], len(context["description"]), len(context["keywords"]),
             len(context["chapters"]))
    await asyncio.to_thread(captions._write_captions_json, island_id, video_id, body.get("events"), asr_events)
    background.add_task(
        dependencies._refunding(captions._build_from_captions,island_id, device, "create", "import"),
        island_id, lines, island_title, language, native,
        any(ln.get("pieces") for ln in lines), asr_tokens=tokens,
    )
    return {"id": island_id, "status": "pending"}


@router.get("/shadow/islands/{island_id}/video")
async def island_video(island_id: str, authorization: str | None = Header(None),
                       x_shadow_device: str = Header("")) -> dict:
    dependencies.require_token(authorization)
    device = dependencies._require_device(x_shadow_device)
    await asyncio.to_thread(dependencies._require_owner, island_id, device)
    video = await asyncio.to_thread(store_video.get_video, island_id)
    if video is None:
        raise HTTPException(404, "no video for this island")
    video["captions_only"] = not store.line_audio_path(island_id, 0).exists()
    # bl36-align: 'closed' once the last allowed attempt failed, so clients stop uploading.
    status = video.pop("align_status", "")
    if status == "failed" and video.pop("align_attempts", 0) >= config.ALIGN_MAX_ATTEMPTS:
        status = "closed"
    video.pop("align_attempts", None)
    video["align"] = status
    # youtube-asr-context-repair: same shape for the text pass.
    repair_status = video.pop("repair_status", "")
    if repair_status == "failed" and video.get("repair_attempts", 0) >= repair.REPAIR_MAX_ATTEMPTS:
        repair_status = "closed"
    # A pass done at an older VERSION reads as never run, so the player
    # posts the context again and the island re-queues once.
    if repair_status == "done" and video.get("repair_version", 0) < repair.VERSION:
        repair_status = ""
    video.pop("repair_attempts", None)
    video.pop("repair_version", None)
    video["repair"] = repair_status
    video["repair_error"] = video.pop("repair_error", "")
    return video


@router.get("/shadow/videos")
async def list_videos(authorization: str | None = Header(None),
                      x_shadow_device: str = Header("")) -> list[dict]:
    dependencies.require_token(authorization)
    device = dependencies._require_device(x_shadow_device)
    return await asyncio.to_thread(store_video.list_videos, device)


@router.post("/shadow/islands/{island_id}/video-audio")
async def upload_video_audio(
    island_id: str,
    audio: UploadFile = File(...),
    authorization: str | None = Header(None),
    x_shadow_device: str = Header(""),
) -> dict:
    """The phone's audio for a video island. Queues forced alignment of the
    captions against it; the island is already playable and stays so."""
    dependencies.require_token(authorization)
    device = dependencies._require_device(x_shadow_device)
    island = await asyncio.to_thread(dependencies._own_island, island_id, device)
    if island["source"] != "youtube":
        raise HTTPException(400, {"code": "not_video"})
    video = await asyncio.to_thread(store_video.get_video, island_id)
    if video is None:
        raise HTTPException(400, {"code": "not_video"})
    if video["align_status"] in ("queued", "running"):
        raise HTTPException(409, {"code": "align_busy"})
    if video["align_status"] == "done" or video["align_attempts"] >= config.ALIGN_MAX_ATTEMPTS:
        raise HTTPException(409, {"code": "align_closed"})
    # Claim the row before streaming, so a second upload racing this one gets
    # align_busy instead of overwriting the file.
    if not await asyncio.to_thread(store_video.claim_align, island_id, config.ALIGN_MAX_ATTEMPTS):
        raise HTTPException(409, {"code": "align_busy"})
    src = store_video.video_audio_path(island_id, "src")
    try:
        size = await asyncio.to_thread(media_io._stream_upload, audio, src, config.VIDEO_AUDIO_MAX_BYTES)
        if size == 0:
            raise HTTPException(400, "empty upload")
    except BaseException:
        src.unlink(missing_ok=True)
        store_video.set_align_status(island_id, video["align_status"], video["align_error"])
        raise
    store_video.set_align_status(island_id, "queued", count_attempt=True)
    align_r._get_align_queue().put_nowait(island_id)
    return {"align": "queued"}


@router.post("/shadow/islands/{island_id}/captions-timing")
async def post_captions_timing(
    island_id: str,
    request: Request,
    background: BackgroundTasks,
    authorization: str | None = Header(None),
    x_shadow_device: str = Header(""),
) -> dict:
    """The ASR track for an existing video island (yt-precise): its word
    times are transferred onto the island's lines in the background. Same
    claim and attempt rules as the audio upload, so the two never run at
    once and a video gets at most ALIGN_MAX_ATTEMPTS tries. 409 not_ready
    while the island is still being built."""
    dependencies.require_token(authorization)
    device = dependencies._require_device(x_shadow_device)
    island = await asyncio.to_thread(dependencies._own_island, island_id, device)
    if island["source"] != "youtube":
        raise HTTPException(400, {"code": "not_video"})
    video = await asyncio.to_thread(store_video.get_video, island_id)
    if video is None:
        raise HTTPException(400, {"code": "not_video"})
    if island["status"] != "ready":
        raise HTTPException(409, {"code": "not_ready"})
    body = await captions._captions_body(request)
    asr_events = body.get("asr_events")
    try:
        youtube.asr_tokens(asr_events)
    except youtube.CaptionsInvalid:
        raise HTTPException(400, {"code": "captions_invalid"})
    if video["align_status"] in ("queued", "running"):
        raise HTTPException(409, {"code": "align_busy"})
    if video["align_status"] == "done" or video["align_attempts"] >= config.ALIGN_MAX_ATTEMPTS:
        raise HTTPException(409, {"code": "align_closed"})
    if not await asyncio.to_thread(store_video.claim_align, island_id, config.ALIGN_MAX_ATTEMPTS):
        raise HTTPException(409, {"code": "align_busy"})
    try:
        await asyncio.to_thread(captions._write_captions_json, island_id, video["video_id"], None, asr_events)
    except BaseException:
        store_video.set_align_status(island_id, video["align_status"], video["align_error"])
        raise
    store_video.set_align_status(island_id, "queued", count_attempt=True)
    background.add_task(align_r._asr_retime, island_id)
    return {"align": "queued"}
