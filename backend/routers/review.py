# Routes for review, moved out of main.py.
import asyncio

from fastapi import APIRouter, Form, Header, HTTPException
from fastapi.responses import FileResponse
from pydantic import BaseModel

import access
import dependencies
import generate
import progression
import review_deck
import review_session
import starter
import store

router = APIRouter()


@router.post("/shadow/review/cards")
async def review_save(
    island_id: str = Form(...),
    idx: int = Form(...),
    authorization: str | None = Header(None),
    x_shadow_device: str = Header(""),
) -> dict:
    dependencies.require_token(authorization)
    device = dependencies._require_device(x_shadow_device)
    island = await asyncio.to_thread(dependencies._own_island, island_id, device)
    line = next((l for l in island["lines"] if l["idx"] == idx), None)
    if line is None:
        raise HTTPException(404, "no such line")
    video = await asyncio.to_thread(store.get_video, island_id)
    try:
        return await asyncio.to_thread(review_deck.create_card, device, island, line, video)
    except ValueError as exc:
        if str(exc) == "full":
            raise HTTPException(409, {"code": "review_full"})
        raise HTTPException(409, {"code": "review_no_audio"})


@router.delete("/shadow/review/cards/{card_id}")
async def review_delete(
    card_id: str,
    authorization: str | None = Header(None),
    x_shadow_device: str = Header(""),
) -> dict:
    dependencies.require_token(authorization)
    device = dependencies._require_device(x_shadow_device)
    if not await asyncio.to_thread(review_deck.delete_card, device, card_id):
        raise HTTPException(404, "no such card")
    return {"ok": True}


@router.get("/shadow/review/cards")
async def review_list(
    island_id: str | None = None,
    authorization: str | None = Header(None),
    x_shadow_device: str = Header(""),
) -> dict:
    dependencies.require_token(authorization)
    device = dependencies._require_device(x_shadow_device)
    cards = await asyncio.to_thread(review_deck.list_cards, device, island_id)
    return {"cards": cards}


@router.get("/shadow/review/due")
async def review_due(
    authorization: str | None = Header(None),
    x_shadow_device: str = Header(""),
) -> dict:
    dependencies.require_token(authorization)
    device = dependencies._require_device(x_shadow_device)
    due = await asyncio.to_thread(review_deck.due_cards, device, review_deck._today())
    total = await asyncio.to_thread(review_deck.count_cards, device)
    return {"due": due, "total": total}


@router.post("/shadow/review/cards/{card_id}/grade")
async def review_grade(
    card_id: str,
    result: str = Form(...),
    authorization: str | None = Header(None),
    x_shadow_device: str = Header(""),
) -> dict:
    dependencies.require_token(authorization)
    device = dependencies._require_device(x_shadow_device)
    if result not in ("again", "got"):
        raise HTTPException(400, "result must be again or got")
    card = await asyncio.to_thread(
        review_deck.grade, device, card_id, result, review_deck._today()
    )
    if card is None:
        raise HTTPException(404, "no such card")
    return card


@router.get("/shadow/review/cards/{card_id}/audio")
async def review_audio(
    card_id: str,
    token: str = "",
    device: str = "",
    authorization: str | None = Header(None),
    x_shadow_device: str = Header(""),
) -> FileResponse:
    dependencies._token_or_header(token, authorization)
    dev = dependencies._require_device(x_shadow_device, device)
    card = await asyncio.to_thread(review_deck.get_card, dev, card_id)
    path = review_deck.clip_path(card_id)
    if card is None or card["kind"] != "clip" or not await asyncio.to_thread(path.exists):
        raise HTTPException(404, "no such clip")
    return FileResponse(path, media_type="audio/wav")


# BL-51 sessions
class SessionPick(BaseModel):
    island_id: str
    count: int


class SessionStartBody(BaseModel):
    size: int = 20
    order: list[str] = []
    # The learner's edited plan, in play order. Non-empty replaces size and order.
    projects: list[SessionPick] = []
    # Learning language to keep; empty mixes every language.
    language: str = ""


def _session_size(size: int) -> int:
    if size not in review_session.SIZES:
        raise HTTPException(422, "size must be 5, 10, 20 or 30")
    return size


def _session_edit(raw: str) -> list[tuple[str, int]] | None:
    """`id:count,id:count` from the plan query, or None when absent."""
    if not raw:
        return None
    out = []
    for part in raw.split(","):
        key, _, n = part.partition(":")
        if not key or not n.isdigit():
            raise HTTPException(422, "projects must be id:count pairs")
        out.append((key, int(n)))
    return out


@router.get("/shadow/review/session/plan")
async def review_session_plan(
    size: int = 20,
    order: str = "",
    projects: str = "",
    language: str = "",
    authorization: str | None = Header(None),
    x_shadow_device: str = Header(""),
) -> dict:
    dependencies.require_token(authorization)
    device = dependencies._require_device(x_shadow_device)
    edit = _session_edit(projects)
    on = await asyncio.to_thread(access._beta_on, device)
    return await asyncio.to_thread(review_session.plan, device,
                                   size if edit else _session_size(size),
                                   [k for k in order.split(",") if k], edit, language or None, on)


@router.get("/shadow/review/session/projects")
async def review_session_projects(
    language: str = "",
    authorization: str | None = Header(None),
    x_shadow_device: str = Header(""),
) -> dict:
    dependencies.require_token(authorization)
    device = dependencies._require_device(x_shadow_device)
    on = await asyncio.to_thread(access._beta_on, device)
    return {"projects": await asyncio.to_thread(review_session.available, device,
                                                language or None, on)}


@router.post("/shadow/review/session/start")
async def review_session_start(
    body: SessionStartBody,
    authorization: str | None = Header(None),
    x_shadow_device: str = Header(""),
) -> dict:
    dependencies.require_token(authorization)
    device = dependencies._require_device(x_shadow_device)
    edit = [(p.island_id, p.count) for p in body.projects] or None
    on = await asyncio.to_thread(access._beta_on, device)
    return await asyncio.to_thread(review_session.start, device,
                                   body.size if edit else _session_size(body.size),
                                   body.order, edit, body.language or None, on)


@router.post("/shadow/starter/finish")
async def starter_finish(
    authorization: str | None = Header(None),
    x_shadow_device: str = Header(""),
) -> dict:
    dependencies.require_token(authorization)
    device = dependencies._require_device(x_shadow_device)
    owner = device
    return {"progress": await asyncio.to_thread(progression.grant_starter, owner),
            "item": progression.STARTER_ITEM}


@router.post("/shadow/starter")
async def starter_start(
    language: str = Form(...),
    native: str = Form(...),
    level: str = Form("new"),
    authorization: str | None = Header(None),
    x_shadow_device: str = Header(""),
) -> dict:
    """The first-run starter island: seeded from the baked template for the
    level pick, free and instant. A repeat call with the same level returns
    the island the device already has; the other level seeds its own."""
    dependencies.require_token(authorization)
    device = dependencies._require_device(x_shadow_device)
    if language not in ("ja", "es", "en"):
        raise HTTPException(400, "language must be 'ja', 'es' or 'en'")
    if native not in ("he", "en"):
        raise HTTPException(400, "native must be 'he' or 'en'")
    if language == native:
        raise HTTPException(400, "the learning language must differ from the native one")
    if level not in starter.INTRO_LEVELS:
        raise HTTPException(400, "level must be 'new' or 'some'")
    if not starter.has_intro(language, level):
        raise HTTPException(404, "no starter island for that language")
    for existing in store.list_islands(device):
        if (existing["source"] == "starter" and existing["language"] == language
                and existing["source_name"] == starter.intro_name(level)
                and existing["status"] != "failed"):
            if existing["status"] != "ready" or starter.intro_is_current(
                    existing["id"], language, level):
                return {"id": existing["id"], "status": existing["status"]}
            # Seeded by an older build: drop it so Home shows one "First steps".
            await asyncio.to_thread(store.delete_island, existing["id"])
    island_id = await asyncio.to_thread(starter.seed_intro, device, language, native, level)
    return {"id": island_id, "status": "ready"}


# --- BL-63 ai-picks ---


@router.post("/shadow/islands/{island_id}/ai-picks")
async def ai_picks(
    island_id: str,
    authorization: str | None = Header(None),
    x_shadow_device: str = Header(""),
) -> dict:
    """The AI picks 5 to 10 easy lines of a podcast episode that has no saved
    sentences and saves them as review cards, each with a grammar tag."""
    dependencies.require_token(authorization)
    device = dependencies._require_device(x_shadow_device)
    island = await asyncio.to_thread(dependencies._own_island, island_id, device)
    if island.get("source") != "podcast":
        raise HTTPException(409, {"code": "not_podcast"})
    if await asyncio.to_thread(review_deck.list_cards, device, island_id):
        raise HTTPException(409, {"code": "has_cards"})
    if island.get("status") != "ready":
        raise HTTPException(409, {"code": "no_lines"})
    usable = [l for l in island["lines"] if generate.PICK_MIN_S <= float(l.get("duration") or 0) <= generate.PICK_MAX_S]
    if len(usable) < generate.PICK_MIN_PICKS:
        raise HTTPException(409, {"code": "no_lines"})
    await asyncio.to_thread(dependencies._take_use_slot, device, "pick_sentences", "pick")
    picks = await asyncio.to_thread(
        generate.pick_shadow_lines, island["lines"], island.get("native") or "en"
    )
    if len(picks) < generate.PICK_MIN_PICKS:
        await asyncio.to_thread(dependencies._refund_use_slot, device, "pick_sentences", "pick")
        raise HTTPException(502, {"code": "pick_failed"})
    by_idx = {l["idx"]: l for l in island["lines"]}
    video = await asyncio.to_thread(store.get_video, island_id)
    cards: list[dict] = []
    for pick in sorted(picks, key=lambda p: p["n"]):
        try:
            cards.append(await asyncio.to_thread(
                review_deck.create_card, device, island, by_idx[pick["n"]], video, pick["tag"]
            ))
        except ValueError as exc:
            if str(exc) == "full":
                break  # keep what is saved so far
    if not cards:
        await asyncio.to_thread(dependencies._refund_use_slot, device, "pick_sentences", "pick")
        raise HTTPException(502, {"code": "pick_failed"})
    return {"cards": cards, "picked": len(cards)}
