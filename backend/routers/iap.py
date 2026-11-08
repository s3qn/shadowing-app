# support-packs: the purchase verify route, Apple's notification hook and
# the admin purchases card. Behaviour lives in iap.py.
import asyncio
import json

from fastapi import APIRouter, Header, HTTPException, Request
from pydantic import BaseModel

import access
import dependencies
import iap
from routers import progress as progress_r

router = APIRouter()

# A notification is a few KB of JWS; past this the body is not read further.
NOTIFICATION_BODY_MAX = 64 * 1024


class VerifyBody(BaseModel):
    jws: str


@router.post("/shadow/iap/verify")
async def iap_verify(
    body: VerifyBody,
    authorization: str | None = Header(None),
    x_shadow_device: str = Header(""),
) -> dict:
    """Grants the pack a StoreKit 2 transaction JWS proves, once. The energy
    status rides along so the phone needs no second fetch. `code` is
    "sandbox_limit" when a prod Sandbox purchase over the daily allowance was
    recorded with 0 ⚡ (the phone still finishes the transaction)."""
    dependencies.require_token(authorization)
    principal = dependencies._require_device(x_shadow_device)
    granted, duplicate, code = await asyncio.to_thread(iap.verify, principal, body.jws)
    snap = await asyncio.to_thread(progress_r._energy_with_builds, principal)
    out = {"granted": granted, "duplicate": duplicate, "energy": snap}
    if code:
        out["code"] = code
    return out


@router.post("/shadow/iap/notifications")
async def iap_notifications(request: Request) -> dict:
    """App Store Server Notifications V2. Public (middleware.PUBLIC_PATHS):
    the signature on `signedPayload` is the whole proof, so a body that does
    not verify is 401 and Apple retries nothing it should not."""
    length = request.headers.get("content-length")
    if length and length.isdigit() and int(length) > NOTIFICATION_BODY_MAX:
        raise HTTPException(413, {"code": "too_large"})
    raw = await request.body()
    if len(raw) > NOTIFICATION_BODY_MAX:
        raise HTTPException(413, {"code": "too_large"})
    try:
        payload = json.loads(raw.decode("utf-8"))
        signed = payload["signedPayload"]
    except (ValueError, KeyError, TypeError, AttributeError):
        raise HTTPException(401, {"code": "bad_jws"}) from None
    try:
        kind = await asyncio.to_thread(iap.handle_notification, signed)
    except iap.Unavailable:
        raise HTTPException(503, {"code": "iap_unavailable"}) from None
    except iap.BadJws:
        raise HTTPException(401, {"code": "bad_jws"}) from None
    return {"ok": True, "type": kind}


@router.get("/shadow/admin/purchases")
async def admin_purchases(
    authorization: str | None = Header(None),
    x_shadow_device: str = Header(""),
    x_shadow_admin_key: str = Header(""),
) -> dict:
    dependencies.require_token(authorization)
    device = dependencies._require_device(x_shadow_device)
    access._require_admin(device, x_shadow_admin_key)
    return await asyncio.to_thread(iap.summary)
