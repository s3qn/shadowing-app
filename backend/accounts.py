"""Signed-in accounts: Supabase JWT verification and account deletion.

A user principal (`user_<sub>`) comes only from a Supabase access token whose
signature, exp, iss and aud verified against the project's JWKS. Nothing else
may produce one: main.DeviceGuard rejects any client-sent id with the prefix.
"""

import os
import re
import threading
import time

import httpx
import jwt
from fastapi import HTTPException

SUPABASE_URL = os.getenv("SUPABASE_URL", "https://kfwsutiwvvoegiwhyeej.supabase.co")
JWKS_URL = SUPABASE_URL + "/auth/v1/.well-known/jwks.json"
ISSUER = SUPABASE_URL + "/auth/v1"
AUDIENCE = "authenticated"
USER_PREFIX = "user_"
USER_RE = re.compile(r"^user_[0-9a-f-]{8,64}$")

JWKS_TTL = 3600.0
REFETCH_MIN_INTERVAL = 60.0
# After a failed JWKS fetch, requests do not refetch (under the lock) for this long.
JWKS_FAIL_BACKOFF = 30.0


class BadToken(Exception):
    """The token is missing, malformed, expired, or does not verify."""


_lock = threading.Lock()
_cache: dict = {"keys": {}, "fetched_at": 0.0, "failed_at": 0.0}


def _fetch_jwks() -> dict:
    resp = httpx.get(JWKS_URL, timeout=5)
    resp.raise_for_status()
    return resp.json()


def _refresh() -> None:
    try:
        data = _fetch_jwks()
    except Exception:
        _cache["failed_at"] = time.monotonic()
        raise
    _cache["keys"] = {k["kid"]: k for k in data.get("keys", []) if "kid" in k}
    _cache["fetched_at"] = time.monotonic()
    _cache["failed_at"] = 0.0


def _key_for(kid: str):
    with _lock:
        now = time.monotonic()
        age = now - _cache["fetched_at"]
        backing_off = bool(_cache["failed_at"]) and now - _cache["failed_at"] < JWKS_FAIL_BACKOFF
        if backing_off:
            # The last fetch failed moments ago: use whatever keys are cached.
            pass
        elif not _cache["fetched_at"] or age > JWKS_TTL:
            _refresh()
        elif kid not in _cache["keys"] and age >= REFETCH_MIN_INTERVAL:
            _refresh()
        jwk = _cache["keys"].get(kid)
    if jwk is None:
        raise BadToken("unknown key id")
    return jwt.PyJWK(jwk).key


def verify(token: str) -> str:
    """The token's `sub`, or BadToken."""
    try:
        kid = jwt.get_unverified_header(token).get("kid")
        if not kid:
            raise BadToken("no key id")
        key = _key_for(kid)
        claims = jwt.decode(
            token,
            key,
            algorithms=["ES256", "RS256"],
            audience=AUDIENCE,
            issuer=ISSUER,
            options={"require": ["exp", "sub"]},
        )
        sub = str(claims["sub"])
    except BadToken:
        raise
    except (jwt.PyJWTError, KeyError, ValueError, TypeError, httpx.HTTPError) as exc:
        raise BadToken(str(exc)) from exc
    if not USER_RE.match(principal(sub)):
        raise BadToken("bad sub")
    return sub


def principal(sub: str) -> str:
    return USER_PREFIX + sub


def is_user(owner: str) -> bool:
    return bool(USER_RE.match(owner))


def sub_of(owner: str) -> str:
    return owner[len(USER_PREFIX):]


def require_delete_configured() -> None:
    if not os.getenv("SUPABASE_SERVICE_ROLE_KEY", ""):
        raise HTTPException(503, {"code": "account_delete_unavailable"})


def delete_auth_user(sub: str) -> None:
    key = os.getenv("SUPABASE_SERVICE_ROLE_KEY", "")
    try:
        resp = httpx.delete(
            f"{SUPABASE_URL}/auth/v1/admin/users/{sub}",
            headers={"apikey": key, "Authorization": f"Bearer {key}"},
            timeout=10,
        )
    except httpx.HTTPError:
        raise HTTPException(502, {"code": "account_delete_failed"})
    if not (200 <= resp.status_code < 300 or resp.status_code == 404):
        raise HTTPException(502, {"code": "account_delete_failed"})
