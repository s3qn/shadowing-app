"""The "Suggest a feature" route: a text box in Settings posts an idea here.

Keeps its own table in the same sqlite file as islands (`store.DB_PATH`)
rather than adding to `store.SCHEMA`, and its own bearer check rather than
importing `main.require_token`, since `main` imports this module and a
back-import would be circular.
"""

import json
import logging
import os
import secrets
import sqlite3
import urllib.request
import uuid
from datetime import datetime, timezone

from fastapi import APIRouter, BackgroundTasks, Header, HTTPException
from pydantic import BaseModel

from store import DB_PATH

log = logging.getLogger("shadow")

router = APIRouter()

SCHEMA = """
CREATE TABLE IF NOT EXISTS suggestions (
  id          TEXT PRIMARY KEY,
  text        TEXT NOT NULL,
  created_at  TEXT NOT NULL
);
"""


class SuggestBody(BaseModel):
    text: str


def _require_token(authorization: str | None) -> None:
    """Same shape as `main.require_token`, duplicated to avoid a circular
    import (`main` imports `suggest`)."""
    token = os.getenv("SHADOW_TOKEN", "")
    if not token:
        raise HTTPException(503, "SHADOW_TOKEN is not configured")
    prefix = "Bearer "
    if not authorization or not authorization.startswith(prefix):
        raise HTTPException(401, "missing bearer token")
    if not secrets.compare_digest(authorization[len(prefix):], token):
        raise HTTPException(401, "bad token")


def _relay_to_discord(text: str) -> None:
    webhook = os.getenv("SHADOW_DISCORD_WEBHOOK")
    if not webhook:
        return
    try:
        req = urllib.request.Request(
            webhook,
            data=json.dumps({"content": f"Feature suggestion: {text}"}).encode(),
            headers={"Content-Type": "application/json"},
        )
        urllib.request.urlopen(req, timeout=5)
    except Exception:
        log.warning("could not relay feature suggestion to Discord", exc_info=True)


@router.post("/shadow/suggestions")
async def suggest_feature(
    body: SuggestBody,
    background: BackgroundTasks,
    authorization: str | None = Header(None),
) -> dict:
    _require_token(authorization)
    text = body.text.strip()
    if not text:
        raise HTTPException(400, "empty suggestion")

    conn = sqlite3.connect(DB_PATH)
    try:
        conn.execute(SCHEMA)
        conn.execute(
            "INSERT INTO suggestions (id, text, created_at) VALUES (?, ?, ?)",
            (str(uuid.uuid4()), text, datetime.now(timezone.utc).isoformat()),
        )
        conn.commit()
    finally:
        conn.close()

    background.add_task(_relay_to_discord, text)
    return {"ok": True}
