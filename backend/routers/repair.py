# Routes for repair, moved out of main.py.
import asyncio

from fastapi import APIRouter, BackgroundTasks, Header, HTTPException, Request

import dependencies
import guardrails  # --- ai-guardrails ---
import repair
import store
from services import captions

router = APIRouter()


# --- youtube-asr-context-repair ---
@router.post("/shadow/islands/{island_id}/repair")
async def post_video_repair(
    island_id: str,
    request: Request,
    background: BackgroundTasks,
    authorization: str | None = Header(None),
    x_shadow_device: str = Header(""),
) -> dict:
    """The phone's video context for an existing video island; queues the
    text pass when the island has not had one at the current version.
    Replies {repair: queued | running | done}. 404 not the owner, 400
    not_video, 409 not_ready while building, 409 repair_closed when the
    attempts are spent."""
    dependencies.require_token(authorization)
    device = dependencies._require_device(x_shadow_device)
    island = await asyncio.to_thread(dependencies._own_island, island_id, device)
    if island["source"] != "youtube":
        raise HTTPException(400, {"code": "not_video"})
    video = await asyncio.to_thread(store.get_video, island_id)
    if video is None:
        raise HTTPException(400, {"code": "not_video"})
    if island["status"] != "ready":
        raise HTTPException(409, {"code": "not_ready"})
    body = await captions._captions_body(request)
    context = repair.clean_context(body.get("context"))
    await asyncio.to_thread(store.set_repair_context, video["video_id"], context)
    status = video.get("repair_status", "")
    if status in ("queued", "running"):
        return {"repair": status}
    if status == "done" and video.get("repair_version", 0) >= repair.VERSION:
        return {"repair": "done"}
    if video.get("repair_attempts", 0) >= repair.REPAIR_MAX_ATTEMPTS:
        raise HTTPException(409, {"code": "repair_closed"})
    # Switch and cap first, so a refusal claims nothing; the slot row is
    # written only once the claim is won, so a lost race costs no slot.
    owner = dependencies._is_owner(device)
    if not owner:  # --- ai-guardrails ---
        await asyncio.to_thread(guardrails.check_ai_call, device, "repair")
    if not await asyncio.to_thread(store.claim_repair, island_id, repair.REPAIR_MAX_ATTEMPTS, repair.VERSION):
        # Lost the race to another open of the same island.
        return {"repair": "queued"}
    if not owner:
        await asyncio.to_thread(store.log_build, device, "repair")
    background.add_task(captions._repair_job, island_id)
    return {"repair": "queued"}
# --- end youtube-asr-context-repair ---
