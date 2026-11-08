# Shared route dependencies: the bearer token check, device and owner scope,
# daily build and use slots. Moved out of main.py unchanged.

import asyncio
import functools
import logging
import os
import re
import secrets

from fastapi import HTTPException

import accounts
import config
import energy
import guardrails  # --- ai-guardrails ---
import schedule
import store
import user_profile

log = logging.getLogger("shadow")


def require_token(authorization: str | None) -> None:
    """Reject anything without the bearer token. Fails closed: an unset
    SHADOW_TOKEN refuses every request rather than opening the service up."""
    if not config.SHADOW_TOKEN:
        raise HTTPException(503, "SHADOW_TOKEN is not configured")
    prefix = "Bearer "
    if not authorization or not authorization.startswith(prefix):
        raise HTTPException(401, "missing bearer token")
    if not secrets.compare_digest(
        authorization[len(prefix):].encode("utf-8"), config.SHADOW_TOKEN.encode("utf-8")
    ):
        raise HTTPException(401, "bad token")


def _token_or_header(token: str, authorization: str | None) -> None:
    """Media routes are fetched by players and Image views that cannot set a
    header, so the token is accepted as a query parameter there as well."""
    if token:
        require_token(f"Bearer {token}")
    else:
        require_token(authorization)


# device-scope: helpers
#
# Every phone gets an anonymous id (client-side, src/lib/device.ts) and sends
# it as the X-Shadow-Device header, or a `device` query param for the few
# media routes a player or Image view fetches without headers. These two
# helpers are what a route checks: `_require_device` reads the id, and
# `_own_island` refuses another device's island with a plain 404, never a
# 403, so a stranger cannot even learn an id exists.
DEVICE_ID_RE = re.compile(r"^[0-9a-f-]{8,64}$")


def _require_device(x_shadow_device: str, device_q: str = "") -> str:
    """Returns the device id from the header, falling back to the query
    param media routes use. Raises 401 when both are empty or the id is
    malformed: this is the route-level check direct-call tests exercise,
    separate from the middleware below, and it checks the value the route
    actually uses (a repeated header can differ from the one the middleware
    saw)."""
    device = x_shadow_device or device_q
    if not device:
        raise HTTPException(401, "missing device id")
    if not (DEVICE_ID_RE.match(device) or accounts.USER_RE.match(device)):
        raise HTTPException(401, "bad device id")
    return device


def _require_owner(island_id: str, device: str) -> None:
    """404 unless `device` owns the island. Reads one column, no lines, for
    routes that only need the check. `device == ''` never matches, even
    against an unclaimed island (also device=''): an empty id must never be
    treated as a valid owner."""
    owner = store.island_device(island_id)
    if owner is None or not device or owner != device:
        raise HTTPException(404, "no such island")


def _own_island(island_id: str, device: str) -> dict:
    """The island with its lines, only if `device` owns it (see `_require_owner`)."""
    island = store.get_island(island_id)
    if island is None or not device or island["device"] != device:
        raise HTTPException(404, "no such island")
    return island


# device-scope: owner claim and daily limit
#
# SHADOW_OWNER_DEVICE names Sean's own phone. Set, the islands and practice
# rows left on device='' from before this feature (or from any request that
# somehow reached storage without a device) become his, rather than staying
# invisible to everyone. DAILY_CREATES and DAILY_REWORKS cap how many builds
# (claude CLI, whisper, VOICEVOX) one device can start per UTC calendar day;
# module-level constants, not inlined os.getenv calls, so a test can
# monkeypatch them without touching the environment.
OWNER_DEVICE = os.getenv("SHADOW_OWNER_DEVICE", "")
# Sean's other device ids (a reinstall mints a new one): exempt from the daily
# caps like OWNER_DEVICE, but never used to claim unowned rows.
OWNER_ALIASES = frozenset(
    d.strip() for d in os.getenv("SHADOW_OWNER_ALIASES", "").split(",") if d.strip()
)
DAILY_CREATES = int(os.getenv("SHADOW_DAILY_CREATES", "5"))
DAILY_REWORKS = int(os.getenv("SHADOW_DAILY_REWORKS", "3"))


def _is_owner(device: str) -> bool:
    return bool(device) and (device == OWNER_DEVICE or device in OWNER_ALIASES)


def _claim_owner() -> None:
    """Idempotent, safe to run on every startup: rows already claimed have a
    non-empty device and are left alone."""
    if not OWNER_DEVICE:
        return
    n_islands = store.claim_unowned(OWNER_DEVICE)
    n_practice = schedule.claim_unowned(OWNER_DEVICE)
    if n_islands or n_practice:
        log.info(
            "device-scope: claimed %d island(s) and %d practice event(s) for the owner device",
            n_islands, n_practice,
        )


DAILY_CAPS = {
    name: int(os.getenv(f"SHADOW_DAILY_{name.upper()}", str(default)))
    for name, default in (
        ("explain", 100), ("explain_word", 100), ("word_audio", 400),
        ("podcast_search", 60), ("take", 200), ("pick_sentences", 20),
        ("hosted_tts", 60),
    )
}


AI_USE_KINDS = frozenset({"explain", "explain_word", "pick_sentences"})  # --- ai-guardrails ---
guardrails.set_owner_check(_is_owner)  # --- ai-guardrails ---


def _ai_paused() -> bool:
    """The ai_jobs kill switch, read by llm.complete before every call so a
    flip also stops queued repair, translation and catch refills."""
    return guardrails._off("ai_jobs", "ai")


def _take_use_slot(device: str, kind: str, charge: str = "") -> None:
    """Per-owner daily cap for the cheap-but-not-free routes, counted in the
    same builds table. Same rules as `_take_build_slot`: owner device exempt,
    called after validation, and only on a cache miss where there is a cache.
    `charge` names the energy price (a key of `energy.PRICES`) the call
    spends, between the cap check and the slot write: a refused charge never
    burns a slot and a cap 429 never burns energy."""
    if _is_owner(device):
        return
    # --- ai-guardrails ---
    if kind in AI_USE_KINDS:
        guardrails.check_switch(kind)
    # --- end ai-guardrails ---
    limit = DAILY_CAPS[kind]
    if store.count_builds_today(device, kind) >= limit:
        raise HTTPException(
            429, {"code": "daily_limit", "limit": limit, "kind": kind}
        )
    if charge:
        energy.charge(device, charge, False)
    store.log_build(device, kind)


def _principal_known(principal: str) -> bool:  # --- ai-guardrails ---
    """Only asked while signups are off, so the normal path pays nothing."""
    if not guardrails._off("signups", "signups"):
        return True
    if store.user_known(principal):
        return True
    return user_profile.connect().execute(
        "SELECT 1 FROM profiles WHERE owner=?", (principal,)
    ).fetchone() is not None


def _refund_use_slot(device: str, kind: str, charge: str) -> None:
    """Undoes `_take_use_slot` for a call whose AI step failed and cached
    nothing: the energy and the cap slot both come back, so a failed call
    costs nothing. Only when a charge was refunded, so with SHADOW_ENERGY off
    the routes behave as before."""
    if energy.refund(device, charge, _is_owner(device)):
        store.unlog_build(device, kind)


def _refund_build_slot(device: str, kind: str, charge: str) -> None:
    """Undoes `_take_build_slot` for a build that failed before it made any
    line: the energy (when SHADOW_ENERGY is on) and the build slot, which is
    also the daily AI-build budget, both come back. Owner exempt, as the
    take was."""
    if _is_owner(device):
        return
    if charge:
        energy.refund(device, charge, False)
    store.unlog_build(device, kind)
    log.info("build slot %s/%s refunded to %s", kind, charge, device)


def _refunding(job, island_id: str, device: str, kind: str, charge: str):
    """`job` wrapped for background.add_task: once it ends, an island left
    failed with no lines gets its build slot and energy back. `__wrapped__`
    keeps the job reachable for tests."""
    @functools.wraps(job)
    async def run(*args, **kwargs) -> None:
        try:
            await job(*args, **kwargs)
        finally:
            island = await asyncio.to_thread(store.get_island, island_id)
            if island is not None and island["status"] == "failed" and not island["lines"]:
                await asyncio.to_thread(_refund_build_slot, device, kind, charge)
    return run


def _take_build_slot(device: str, kind: str, charge: str = "") -> None:
    """Called immediately before the first write of a build, so a 400 on bad
    input never consumes a slot. The owner device is exempt. `kind` is
    "create" (record, file import, podcast import) or "rework" (regenerate,
    re-voice); each has its own daily cap. `charge` as in `_take_use_slot`."""
    if _is_owner(device):
        return
    # --- ai-guardrails ---
    # Order: switch, per-kind cap, daily AI-build budget, energy, then the
    # slot row. The llm-api dollar cap sits inside llm.complete, so it runs
    # after all of these by construction.
    guardrails.check_switch(kind, imports=charge == "import")
    # --- end ai-guardrails ---
    limit = DAILY_CREATES if kind == "create" else DAILY_REWORKS
    if store.count_builds_today(device, kind) >= limit:
        raise HTTPException(
            429, {"code": "daily_limit", "limit": limit, "kind": kind}
        )
    guardrails.check_budget(device)  # --- ai-guardrails ---
    if charge:
        energy.charge(device, charge, False)
    store.log_build(device, kind)


# --- say-it ---
def _take_say_slot(device: str) -> None:
    """`_take_build_slot` for one said sentence: the switch, its own daily
    cap, one energy unit, then the slot row. "say" is not in
    guardrails.BUILD_KINDS, so it never eats the daily AI build budget.
    Owner exempt, refunded by `_refund_build_slot(device, "say", "say")`."""
    if _is_owner(device):
        return
    guardrails.check_switch("say")
    if store.count_builds_today(device, "say") >= config.DAILY_SAYS:
        raise HTTPException(429, {"code": "daily_limit", "limit": config.DAILY_SAYS, "kind": "say"})
    energy.charge(device, "say", False)
    store.log_build(device, "say")
