"""ASGI middleware and the access-log filter, moved out of main.py."""

import asyncio
import logging
import os
import re
from urllib.parse import parse_qs

from fastapi import HTTPException
from fastapi.responses import JSONResponse

import access
import accounts
import admin_devices
import config
import dependencies
import dev_upload
import guardrails  # --- ai-guardrails ---


class RedactAccessLog(logging.Filter):
    """Blanks the `user=` (a Supabase JWT), `token=` and `device=` query
    values in uvicorn's access log lines, so the log never holds a usable
    credential or a device id."""

    _SECRET = re.compile(r"([?&](?:user|token|device)=)[^&\s\"]*")

    def filter(self, record: logging.LogRecord) -> bool:
        if isinstance(record.args, tuple):
            record.args = tuple(
                self._SECRET.sub(r"\1REDACTED", a) if isinstance(a, str) else a
                for a in record.args
            )
        if isinstance(record.msg, str):
            record.msg = self._SECRET.sub(r"\1REDACTED", record.msg)
        return True


def _signin_required(raw: str | None) -> bool:
    """On unless SHADOW_REQUIRE_SIGNIN is set to 0, false or off."""
    return (raw or "1").strip().lower() not in ("0", "false", "off")


# When on, every non-public /shadow/* request needs a verified x-shadow-user
# JWT; the raw device id is no longer an owner. On by default. Set
# SHADOW_REQUIRE_SIGNIN=0 to accept device-only requests again.
REQUIRE_SIGNIN = _signin_required(config.REQUIRE_SIGNIN_RAW)

PUBLIC_PATHS = (
    "/health", "/shadow/health", "/shadow", "/shadow/", "/shadow/privacy", "/shadow/app/latest",
    # support-packs: Apple posts here with no bearer; the JWS signature is the proof.
    "/shadow/iap/notifications",
)


# device-scope: middleware
class DeviceGuard:
    """Pure ASGI middleware, not BaseHTTPMiddleware: background tasks and
    FileResponse must keep working, which BaseHTTPMiddleware's
    request/response buffering does not reliably preserve. Runs before the
    bearer check; a request with no token still ends up 401 either way, just
    from a different check."""

    def __init__(self, app) -> None:
        self.app = app

    async def __call__(self, scope, receive, send) -> None:
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return
        if scope["method"] == "OPTIONS" or scope["path"] in PUBLIC_PATHS:
            await self.app(scope, receive, send)
            return
        # Dev upload page and API: opened in a plain browser, no device id or
        # sign-in; every API call still needs the bearer token (dev_upload).
        if dev_upload.enabled() and (
            scope["path"] == "/shadow/dev/upload" or scope["path"].startswith("/shadow/dev/upload/")
        ):
            await self.app(scope, receive, send)
            return
        headers = dict(scope["headers"])
        query = parse_qs(scope["query_string"].decode("latin-1"))
        device = headers.get(b"x-shadow-device", b"").decode("latin-1")
        if not device:
            device = (query.get("device") or [""])[0]
        # --- sign-in: a user principal comes only from a verified JWT ---
        sent = [v.decode("latin-1") for k, v in scope["headers"] if k == b"x-shadow-device"]
        sent += query.get("device", [])
        if any(d.lower().startswith(accounts.USER_PREFIX) for d in sent):
            response = JSONResponse({"detail": "bad device id"}, status_code=401)
            await response(scope, receive, send)
            return
        user_token = headers.get(b"x-shadow-user", b"").decode("latin-1")
        if not user_token:
            user_token = (query.get("user") or [""])[0]
        if user_token:
            try:
                sub = await asyncio.to_thread(accounts.verify, user_token)
            except accounts.BadToken:
                response = JSONResponse({"detail": "bad user token"}, status_code=401)
                await response(scope, receive, send)
                return
            # --- ai-guardrails ---
            principal = accounts.principal(sub)
            try:
                known = await asyncio.to_thread(dependencies._principal_known, principal)
                guardrails.check_signup(principal, known)
            except HTTPException as exc:
                response = JSONResponse({"detail": exc.detail}, status_code=exc.status_code)
                await response(scope, receive, send)
                return
            # --- end ai-guardrails ---
            kept = [(k, v) for k, v in scope["headers"] if k != b"x-shadow-device"]
            kept.append((b"x-shadow-device", principal.encode()))
            scope["headers"] = kept
        # --- end sign-in ---
        elif REQUIRE_SIGNIN:
            response = JSONResponse({"detail": "sign-in required"}, status_code=401)
            await response(scope, receive, send)
            return
        elif not dependencies.DEVICE_ID_RE.match(device):
            response = JSONResponse({"detail": "missing device id"}, status_code=401)
            await response(scope, receive, send)
            return
        # --- admin-device-bound ---
        # The admin routes trust x-shadow-admin-key only from here: a client
        # copy is dropped, and the header is set when a signed X-Shadow-Proof
        # from an approved key of this very principal checks out.
        kept = [(k, v) for k, v in scope["headers"] if k != b"x-shadow-admin-key"]
        proof = headers.get(b"x-shadow-proof", b"").decode("latin-1")
        if user_token and proof:
            path = scope["path"]
            if path.startswith("/shadow/"):
                path = path[len("/shadow"):]
            # The proof signs the body too: read it here and replay it to the
            # route, which then sees the same bytes as if nothing had read them.
            body, receive = await _buffer_body(receive)
            key_id = body is not None and await asyncio.to_thread(
                admin_devices.verify, proof, principal, scope["method"], path, body
            )
            if key_id:
                kept.append((b"x-shadow-admin-key", key_id.encode()))
        scope["headers"] = kept
        # --- end admin-device-bound ---
        # --- launch-basics: beta gate (BETA_PATHS and _beta_denied at file end) ---
        # Only for a request with the shared token: without it the route's own
        # check answers 401, so a probe cannot tell gated paths from open ones.
        who = principal if user_token else device
        if access._shared_token_ok(headers, query) and await access._beta_denied(scope["path"], who):
            await JSONResponse({"detail": {"code": "not_beta"}}, status_code=403)(scope, receive, send)
            return
        # --- end launch-basics ---
        await self.app(scope, receive, send)


# --- admin-device-bound ---
# An admin body is a few dozen bytes; past this the proof is not checked.
PROOF_BODY_MAX = 64 * 1024


async def _buffer_body(receive):
    """Reads the request body from `receive` and returns it (None when it
    passes PROOF_BODY_MAX or the client left early) with a receive callable
    that replays every message read, then defers to the original. The route
    sees the same messages as if nothing had read them."""
    read: list[dict] = []
    size = 0
    complete = False
    while size <= PROOF_BODY_MAX:
        message = await receive()
        read.append(message)
        if message["type"] != "http.request":
            break
        size += len(message.get("body", b""))
        if not message.get("more_body", False):
            complete = True
            break
    body = b"".join(m.get("body", b"") for m in read) if complete and size <= PROOF_BODY_MAX else None

    async def replay():
        if read:
            return read.pop(0)
        return await receive()

    return body, replay
# --- end admin-device-bound ---


# --- security headers ---
_HTML_CSP = (
    b"default-src 'none'; style-src 'unsafe-inline'; img-src 'self' data:; "
    b"base-uri 'none'; form-action 'none'; frame-ancestors 'none'"
)
# The dev upload page is one inline script plus inline style that calls its own API.
_UPLOAD_CSP = (
    b"default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; "
    b"connect-src 'self'; img-src 'self' data:; "
    b"base-uri 'none'; form-action 'none'; frame-ancestors 'none'"
)


class SecurityHeaders:
    """Pure ASGI, for the same reason as DeviceGuard. Added last so it is
    outermost and also decorates the 401s DeviceGuard sends itself."""

    def __init__(self, app) -> None:
        self.app = app

    async def __call__(self, scope, receive, send) -> None:
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return

        async def wrapped(message) -> None:
            if message["type"] == "http.response.start":
                headers = list(message.get("headers", []))
                headers.append((b"x-content-type-options", b"nosniff"))
                headers.append((b"referrer-policy", b"no-referrer"))
                ctype = next((v for k, v in headers if k.lower() == b"content-type"), b"")
                if ctype.lower().startswith(b"text/html"):
                    upload = dev_upload.enabled() and scope["path"] == "/shadow/dev/upload"
                    headers.append((b"content-security-policy", _UPLOAD_CSP if upload else _HTML_CSP))
                message = {**message, "headers": headers}
            await send(message)

        await self.app(scope, receive, wrapped)
