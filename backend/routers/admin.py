# Routes for admin, moved out of main.py.
import asyncio

from fastapi import APIRouter, Header, HTTPException
from pydantic import BaseModel

import access
import accounts
import admin_devices
import beta
import config
import dependencies
import languages
import llm
import store_llm
import voices

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
    summary = await asyncio.to_thread(store_llm.llm_spend_summary)
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
    # The learning languages this device may pick, each with its first voice.
    langs = [{"id": code, "speaker": voices.default_speaker(code)}
             for code in languages.available_for(on)]
    return {"admin": admin, "beta": on, "youtube": on, "podcast": on, "import": on,
            "languages": langs}


@router.get("/shadow/admin/beta")
async def admin_beta_list(
    authorization: str | None = Header(None),
    x_shadow_device: str = Header(""),
    x_shadow_admin_key: str = Header(""),
):
    dependencies.require_token(authorization)
    device = dependencies._require_device(x_shadow_device)
    access._require_admin(device, x_shadow_admin_key)
    people = await asyncio.to_thread(access._beta_people, device)
    # admin-device-bound: "approved" only when DeviceGuard checked this phone's proof.
    return {"people": people, "device": "approved" if x_shadow_admin_key else None}


@router.put("/shadow/admin/beta")
async def admin_beta_set(
    body: access.BetaBody,
    authorization: str | None = Header(None),
    x_shadow_device: str = Header(""),
    x_shadow_admin_key: str = Header(""),
):
    dependencies.require_token(authorization)
    device = dependencies._require_device(x_shadow_device)
    access._require_admin(device, x_shadow_admin_key)
    if not (dependencies.DEVICE_ID_RE.match(body.owner) or accounts.USER_RE.match(body.owner)):
        raise HTTPException(400, {"code": "bad_owner"})
    await asyncio.to_thread(beta.set_flag, body.owner, body.enabled, device)
    return {"owner": body.owner, "enabled": body.enabled}


@router.post("/shadow/admin/device")
async def admin_device_enrol(
    body: access.DeviceBody,
    authorization: str | None = Header(None),
    x_shadow_device: str = Header(""),
):
    """Register this phone's admin key for a listed account. The key starts
    `pending`; tools/admin-device.py on the server box approves it, or the
    passcode route below while SHADOW_ADMIN_PASSCODE is set."""
    dependencies.require_token(authorization)
    device = dependencies._require_device(x_shadow_device)
    access._require_admin_listed(device)
    status = await asyncio.to_thread(
        admin_devices.enrol, device, body.key_id, body.public_key, body.name.strip()[:64]
    )
    return {"status": status}


class ApproveBody(BaseModel):
    """The phone's own pending key id and the passcode Sean set on the box."""

    key_id: str
    passcode: str


@router.post("/shadow/admin/device/approve")
async def admin_device_approve(
    body: ApproveBody,
    authorization: str | None = Header(None),
    x_shadow_device: str = Header(""),
):
    """Until launch: approve this account's own pending phone key with the
    passcode in SHADOW_ADMIN_PASSCODE. 404 while that is unset. Wrong codes
    are capped per account (admin_devices.approve_with_passcode)."""
    dependencies.require_token(authorization)
    if not config.ADMIN_PASSCODE:
        raise HTTPException(404, "Not Found")
    device = dependencies._require_device(x_shadow_device)
    access._require_admin_listed(device)
    status = await asyncio.to_thread(
        admin_devices.approve_with_passcode, device, body.key_id[:64], body.passcode[:64], config.ADMIN_PASSCODE
    )
    return {"status": status}
