# Routes for progress, moved out of main.py.
import asyncio
import re

from fastapi import APIRouter, Form, Header, HTTPException, Query
from pydantic import BaseModel, Field

import accounts
import catch
import dependencies
import dev_review
import energy
import guardrails
import progression
import progression_board
import progression_shop
import schedule
import stats
import store
import user_profile

router = APIRouter()


# --- progression ---


@router.get("/shadow/progress")
async def get_progress(
    authorization: str | None = Header(None),
    x_shadow_device: str = Header(""),
) -> dict:
    dependencies.require_token(authorization)
    device = dependencies._require_device(x_shadow_device)
    imm = await asyncio.to_thread(schedule.immersion, device)
    listened = imm["total"]
    # Heal the hours ladder on read, so listening from before it existed pays.
    # The ladder pays on counted seconds (each day capped); the display does not.
    await asyncio.to_thread(progression.grant_hours, device, imm["counted_total"])
    snap = await asyncio.to_thread(progression.snapshot, device)
    snap["listened_seconds"] = listened
    snap["counted_seconds"] = imm["counted_total"]
    snap["known_lines"] = await asyncio.to_thread(store.count_known, device)
    if energy.ON:
        snap["energy"] = await asyncio.to_thread(energy.status, device, dependencies._is_owner(device))
    return snap


# cat-leaderboard routes


def _all_handles() -> dict[str, str]:
    """Every (owner, username) pair, so the board lists every named user, even
    one who has not earned any XP yet."""
    fn = getattr(user_profile, "all_usernames", None)
    return fn() if fn else {}


@router.get("/shadow/leaderboard")
async def leaderboard(
    limit: int = Query(progression_board.LEADERBOARD_MAX),
    authorization: str | None = Header(None),
    x_shadow_device: str = Header(""),
) -> dict:
    dependencies.require_token(authorization)
    device = dependencies._require_device(x_shadow_device)
    return await asyncio.to_thread(progression_board.leaderboard,device, limit, _all_handles)


@router.get("/shadow/cosmetics/catalog")
async def cosmetics_catalog(
    ui: str = Query("en"),
    authorization: str | None = Header(None),
    x_shadow_device: str = Header(""),
) -> dict:
    dependencies.require_token(authorization)
    device = dependencies._require_device(x_shadow_device)
    imm = await asyncio.to_thread(schedule.immersion, device)
    listened = imm["total"]
    await asyncio.to_thread(progression.grant_hours, device, imm["counted_total"])
    out = await asyncio.to_thread(progression.catalog, ui)
    out["listened_hours"] = round(listened / 3600, 1)
    out["counted_hours"] = round(imm["counted_total"] / 3600, 1)
    return out


@router.post("/shadow/cosmetics/buy")
async def cosmetics_buy(
    item_id: str = Form(...),
    authorization: str | None = Header(None),
    x_shadow_device: str = Header(""),
) -> dict:
    dependencies.require_token(authorization)
    device = dependencies._require_device(x_shadow_device)
    return await asyncio.to_thread(progression_shop.buy, device, item_id)


@router.post("/shadow/cosmetics/equip")
async def cosmetics_equip(
    slot: str = Form(...),
    item_id: str = Form(""),
    authorization: str | None = Header(None),
    x_shadow_device: str = Header(""),
) -> dict:
    dependencies.require_token(authorization)
    device = dependencies._require_device(x_shadow_device)
    return await asyncio.to_thread(progression_shop.equip, device, slot, item_id)


# cat-username routes
def _require_user(x_shadow_device: str) -> str:
    """The signed-in owner id. A bare device id cannot own a handle."""
    owner = dependencies._require_device(x_shadow_device)
    if not accounts.USER_RE.match(owner):
        raise HTTPException(401, "sign in to set a username")
    return owner


@router.get("/shadow/username")
async def username_get(
    authorization: str | None = Header(None),
    x_shadow_device: str = Header(""),
) -> dict:
    dependencies.require_token(authorization)
    owner = _require_user(x_shadow_device)
    return {"username": await asyncio.to_thread(user_profile.get_username, owner)}


@router.get("/shadow/username/check")
async def username_check(
    name: str = Query(""),
    authorization: str | None = Header(None),
    x_shadow_device: str = Header(""),
) -> dict:
    dependencies.require_token(authorization)
    owner = _require_user(x_shadow_device)
    return await asyncio.to_thread(user_profile.check, owner, name)


@router.post("/shadow/username")
async def username_set(
    username: str = Form(...),
    authorization: str | None = Header(None),
    x_shadow_device: str = Header(""),
) -> dict:
    dependencies.require_token(authorization)
    owner = _require_user(x_shadow_device)
    try:
        name = await asyncio.to_thread(user_profile.set_username, owner, username)
    except user_profile.UsernameInvalid:
        raise HTTPException(400, {"code": "username_invalid"})
    except user_profile.UsernameTaken:
        raise HTTPException(409, {"code": "username_taken"})
    return {"username": name}


# --- stats-profile ---


@router.get("/shadow/profile/{username}")
async def profile_get(
    username: str,
    ui: str = Query("en"),
    authorization: str | None = Header(None),
    x_shadow_device: str = Header(""),
) -> dict:
    dependencies.require_token(authorization)
    dependencies._require_device(x_shadow_device)
    lang = ui if isinstance(ui, str) else "en"
    res = await asyncio.to_thread(stats.profile, username, _all_handles, lang)
    if res is None:
        raise HTTPException(404, {"code": "profile_not_found"})
    return res


# --- bl52-energy ---
# The meter routes. Everything a learner sees comes through get_progress;
# these two exist for the owner's grant sheet and for a direct read.


def _energy_target(device: str, username: str) -> str:
    """Owner only: the device behind a handle. 403 for anyone else, flag or
    no flag, so the grant control has no server surface for other users;
    404 when no profile carries the handle."""
    if not dependencies._is_owner(device):
        raise HTTPException(403, {"code": "not_owner"})
    row = user_profile.lookup(username)
    if row is None:
        raise HTTPException(404, {"code": "profile_not_found"})
    return row["owner"]


def _energy_with_builds(device: str) -> dict:  # --- ai-guardrails ---
    """energy.status plus the daily AI-build budget: `builds_left` and
    `builds_max` (owner sees a full budget)."""
    snap = energy.status(device, dependencies._is_owner(device))
    used = 0 if dependencies._is_owner(device) else store.count_builds_today_kinds(device, guardrails.BUILD_KINDS)
    snap["builds_max"] = guardrails.USER_AI_BUILDS
    snap["builds_left"] = max(0, guardrails.USER_AI_BUILDS - used)
    return snap


@router.get("/shadow/energy")
async def energy_get(
    username: str = Query(""),
    authorization: str | None = Header(None),
    x_shadow_device: str = Header(""),
) -> dict:
    """Own status, or `?username=` for another user's (owner only)."""
    dependencies.require_token(authorization)
    device = dependencies._require_device(x_shadow_device)
    if username:
        target = await asyncio.to_thread(_energy_target, device, username)
        if not energy.ON:
            return {"on": False}
        return await asyncio.to_thread(_energy_with_builds, target)
    if not energy.ON:
        return {"on": False}
    return await asyncio.to_thread(_energy_with_builds, device)


@router.post("/shadow/energy/grant")
async def energy_grant(
    username: str = Form(...),
    amount: int = Form(...),
    note: str = Form(""),
    authorization: str | None = Header(None),
    x_shadow_device: str = Header(""),
) -> dict:
    """Owner only: adds `amount` to the user's grant balance and returns
    their status. Logged with the granter, the handle and the note."""
    dependencies.require_token(authorization)
    device = dependencies._require_device(x_shadow_device)
    target = await asyncio.to_thread(_energy_target, device, username)
    if not energy.ON:
        return {"on": False}
    note = note.strip()[:200]
    return await asyncio.to_thread(
        energy.grant, device, target, username, amount, note, dependencies._is_owner(target)
    )


@router.get("/shadow/leaderboard/weekly")
async def leaderboard_weekly(
    language: str = Query("ja"),
    limit: int = Query(progression_board.LEADERBOARD_MAX),
    authorization: str | None = Header(None),
    x_shadow_device: str = Header(""),
) -> dict:
    dependencies.require_token(authorization)
    device = dependencies._require_device(x_shadow_device)
    return await asyncio.to_thread(stats.weekly_league, device, language, limit, _all_handles)


# --- streak-freeze ---


class DevCoinsBody(BaseModel):
    amount: int = Field(ge=1, le=1_000_000)
    clear_freezes: bool = False


@router.post("/shadow/dev/coins")
async def dev_coins(
    body: DevCoinsBody,
    authorization: str | None = Header(None),
    x_shadow_device: str = Header(""),
) -> dict:
    """Dev only: grants coins to the calling device. 404 in prod."""
    if not dev_review.enabled():
        raise HTTPException(404, "not found")
    dependencies.require_token(authorization)
    device = dependencies._require_device(x_shadow_device)
    return await asyncio.to_thread(progression_shop.grant_coins, device, body.amount, body.clear_freezes)

_PURCHASE_ID = re.compile(r"[A-Za-z0-9-]{8,64}")


@router.post("/shadow/streak/freeze/buy")
async def streak_freeze_buy(
    purchase_id: str = Form(...),
    authorization: str | None = Header(None),
    x_shadow_device: str = Header(""),
) -> dict:
    dependencies.require_token(authorization)
    device = dependencies._require_device(x_shadow_device)
    if not _PURCHASE_ID.fullmatch(purchase_id):
        raise HTTPException(422, {"code": "bad_purchase_id"})
    return await asyncio.to_thread(progression_shop.buy_freeze, device, purchase_id)


# --- bl72-known-words ---
@router.get("/shadow/catch/words")
async def catch_collection(
    language: str = "ja",
    authorization: str | None = Header(None),
    x_shadow_device: str = Header(""),
) -> dict:
    """The device's caught words, with Known/Learning counts. Read only."""
    dependencies.require_token(authorization)
    device = dependencies._require_device(x_shadow_device)
    return await asyncio.to_thread(catch.collection, device, language)
# --- end bl72-known-words ---
