# Admin and beta access: who is an admin, the beta switch and the paths it gates.
# Moved out of main.py unchanged.

import asyncio
import os
import re
import secrets

from fastapi import HTTPException
from pydantic import BaseModel

import accounts
import beta
import config
import dependencies
import store
import user_profile


# --- launch-basics: beta routes ---
# Admins are the owner devices plus the user ids in SHADOW_ADMIN_USERS (comma
# list, read at import so a test can monkeypatch the constant). One switch per
# principal (`beta`) turns on everything that is not shadowing: content
# sources (youtube, podcast, import), the cat and XP layer, streaks and the
# social screens. `admin` only says who may open the Admin screen.
def _parse_admin_users(raw: str | None) -> frozenset[str]:
    return frozenset(u.strip() for u in (raw or "").split(",") if u.strip())


ADMIN_USERS = _parse_admin_users(os.getenv("SHADOW_ADMIN_USERS"))


def _is_admin(principal: str) -> bool:
    return bool(principal) and (principal in ADMIN_USERS or dependencies._is_owner(principal))


def _require_admin(principal: str) -> None:
    if not _is_admin(principal):
        raise HTTPException(403, {"code": "not_admin"})


def _beta_on(principal: str) -> bool:
    """The effective switch: a stored flag wins; with no row an admin is on
    and everyone else is off. An admin who flips himself off really is off."""
    flag = beta.flag(principal)
    return flag if flag is not None else _is_admin(principal)


# Routes the switch gates: DeviceGuard answers 403 not_beta when it is off.
# Every other route is core shadowing and stays open: islands CRUD, line
# audio, takes, regenerate, revoice, export, lines/{idx}/known, word audio,
# gloss and explain, phrases, grammar, starter, review/due and
# review/session, energy, username, account, speakers, health, privacy, dev,
# llm/spend, beta and admin/beta. A new beta route must be added here or it
# is open to everyone (test_beta.py has a row per family).
BETA_PATHS = tuple(
    re.compile(p)
    for p in (
        r"^/shadow/islands/import$",
        r"^/shadow/podcasts(/.*)?$",
        r"^/shadow/youtube/.*$",
        r"^/shadow/videos$",
        r"^/shadow/islands/[^/]+/(video|video-audio|captions-timing|episode|repair|ai-picks)$",
        r"^/shadow/catch/.*$",
        r"^/shadow/progress$",
        r"^/shadow/leaderboard(/.*)?$",
        r"^/shadow/cosmetics/.*$",
        r"^/shadow/profile/.*$",
        r"^/shadow/streak/.*$",
        r"^/shadow/review/cards(/.*)?$",
    )
)


def _shared_token_ok(headers: dict, query: dict) -> bool:
    """The bearer header or the media `token` query matches SHADOW_TOKEN,
    the same two ways require_token and _token_or_header accept it."""
    if not config.SHADOW_TOKEN:
        return False
    want = config.SHADOW_TOKEN.encode("utf-8")
    auth = headers.get(b"authorization", b"")
    sent = [auth[len(b"Bearer "):]] if auth.startswith(b"Bearer ") else []
    sent += [t.encode("utf-8") for t in query.get("token", [])]
    return any(secrets.compare_digest(t, want) for t in sent)


async def _beta_denied(path: str, principal: str) -> bool:
    """True when the path is beta-only and the principal's switch is off.
    Core routes return at once without touching sqlite."""
    if not any(p.match(path) for p in BETA_PATHS):
        return False
    return not await asyncio.to_thread(_beta_on, principal)


def _beta_people(me: str) -> list[dict]:
    flags = beta.list_flags()
    handles = user_profile.all_usernames()
    with store.connect() as conn:
        devices = {
            r[0]
            for r in conn.execute("SELECT DISTINCT device FROM islands WHERE device != ''")
            if dependencies.DEVICE_ID_RE.match(r[0]) and not accounts.USER_RE.match(r[0])
        }
    owners = set(handles) | devices | set(flags) | {me}
    people = [
        {
            "owner": o,
            "handle": handles.get(o),
            "kind": "user" if o in handles or accounts.USER_RE.match(o) else "device",
            "enabled": flags.get(o, _is_admin(o)),
            "me": o == me,
        }
        for o in owners
    ]
    people.sort(key=lambda p: (not p["me"], p["handle"] is None, p["handle"] or p["owner"]))
    return people


class BetaBody(BaseModel):
    owner: str
    enabled: bool
