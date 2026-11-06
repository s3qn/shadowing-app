# Routes for account, moved out of main.py.
import asyncio

from fastapi import APIRouter, Header, HTTPException

import accounts
import beta
import dependencies
import progression_shop
import review_deck
import schedule
import store
import store_energy
import user_profile
from services import line_audio as line_audio_svc

router = APIRouter()


def _erase_owner(owner: str) -> None:
    for island in store.list_islands(owner):
        store.delete_island(island["id"])
    store_energy.delete_owner_rows(owner)
    schedule.delete_owner(owner)
    progression_shop.delete_owner(owner)
    user_profile.delete_owner(owner)
    beta.delete_owner(owner)
    review_deck.delete_owner(owner)
    import aec

    (aec.AEC_DIR / f"{line_audio_svc._take_profile_name(owner)}.npz").unlink(missing_ok=True)


@router.delete("/shadow/account")
async def delete_account(
    authorization: str = Header(default=""),
    x_shadow_device: str = Header(default=""),
):
    dependencies.require_token(authorization)
    principal = dependencies._require_device(x_shadow_device)
    if not accounts.is_user(principal):
        raise HTTPException(401, "sign-in required")
    accounts.require_delete_configured()
    await asyncio.to_thread(_erase_owner, principal)
    await asyncio.to_thread(accounts.delete_auth_user, accounts.sub_of(principal))
    return {"ok": True}
