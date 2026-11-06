# Routes for admin, moved out of main.py.
import asyncio

from fastapi import APIRouter, Header, HTTPException

import access
import accounts
import beta
import dependencies
import llm
import store

router = APIRouter()


@router.get("/shadow/llm/spend")
async def llm_spend(
    authorization: str | None = Header(None),
    x_shadow_device: str = Header(""),
) -> dict:
    """This month's LLM bill: backend, cap, calls and USD by tag. Owner only."""
    dependencies.require_token(authorization)
    device = dependencies._require_device(x_shadow_device)
    if not dependencies._is_owner(device):
        raise HTTPException(403, {"code": "not_owner"})
    summary = await asyncio.to_thread(store.llm_spend_summary)
    return {"backend": llm.backend(), "cap_usd": llm.MONTHLY_USD, **summary}


@router.get("/shadow/beta")
async def beta_get(
    authorization: str | None = Header(None),
    x_shadow_device: str = Header(""),
):
    dependencies.require_token(authorization)
    device = dependencies._require_device(x_shadow_device)
    admin = access._is_admin(device)
    on = await asyncio.to_thread(access._beta_on, device)
    return {"admin": admin, "beta": on, "youtube": on, "podcast": on, "import": on}


@router.get("/shadow/admin/beta")
async def admin_beta_list(
    authorization: str | None = Header(None),
    x_shadow_device: str = Header(""),
):
    dependencies.require_token(authorization)
    device = dependencies._require_device(x_shadow_device)
    access._require_admin(device)
    return {"people": await asyncio.to_thread(access._beta_people, device)}


@router.put("/shadow/admin/beta")
async def admin_beta_set(
    body: access.BetaBody,
    authorization: str | None = Header(None),
    x_shadow_device: str = Header(""),
):
    dependencies.require_token(authorization)
    device = dependencies._require_device(x_shadow_device)
    access._require_admin(device)
    if not (dependencies.DEVICE_ID_RE.match(body.owner) or accounts.USER_RE.match(body.owner)):
        raise HTTPException(400, {"code": "bad_owner"})
    await asyncio.to_thread(beta.set_flag, body.owner, body.enabled, device)
    return {"owner": body.owner, "enabled": body.enabled}
