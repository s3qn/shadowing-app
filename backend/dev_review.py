"""Dev-only review tour: Sean writes a tour JSON, the app walks him through it
and posts a verdict per step. Mounted only when SHADOW_ENV is not "prod" (see
`enabled`), so prod answers 404. Own bearer check, as in suggest.py, to avoid
a circular import with `main`.
"""

import json
import os
import re
import secrets
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Literal

from fastapi import APIRouter, File, Form, Header, HTTPException, UploadFile
from pydantic import BaseModel, Field

router = APIRouter()


def enabled() -> bool:
    return os.getenv("SHADOW_ENV", "dev") != "prod"


def _tour_file() -> Path:
    env = os.getenv("SHADOW_REVIEW_FILE")
    if env:
        return Path(env)
    return Path.home() / ".local" / "state" / "shadow-review" / "current.json"


def _verdicts_file() -> Path:
    return _tour_file().parent / "verdicts.jsonl"


def _require_token(authorization: str | None) -> None:
    token = os.getenv("SHADOW_TOKEN", "")
    if not token:
        raise HTTPException(503, "SHADOW_TOKEN is not configured")
    prefix = "Bearer "
    if not authorization or not authorization.startswith(prefix):
        raise HTTPException(401, "missing bearer token")
    if not secrets.compare_digest(
        authorization[len(prefix):].encode("utf-8"), token.encode("utf-8")
    ):
        raise HTTPException(401, "bad token")


class VerdictBody(BaseModel):
    wave: str
    id: str
    verdict: Literal["accept", "fix", "remove"]
    chips: list[str] = Field(default_factory=list, max_length=10)
    note: str | None = Field(default=None, max_length=500)


def _last_verdicts(wave: str) -> dict[str, dict]:
    out: dict[str, dict] = {}
    path = _verdicts_file()
    if not path.exists():
        return out
    for line in path.read_text(encoding="utf-8").splitlines():
        try:
            row = json.loads(line)
        except ValueError:
            continue
        if row.get("wave") == wave and row.get("verdict"):
            out[row.get("id")] = row
    return out


@router.get("/shadow/dev/review")
def get_review(authorization: str | None = Header(None)):
    _require_token(authorization)
    path = _tour_file()
    if not path.exists():
        raise HTTPException(404, "no review")
    try:
        tour = json.loads(path.read_text(encoding="utf-8"))
    except ValueError:
        raise HTTPException(404, "no review")
    seen = _last_verdicts(str(tour.get("wave", "")))
    for step in tour.get("steps", []):
        row = seen.get(step.get("id"))
        step["verdict"] = row["verdict"] if row else None
        step["vchips"] = row.get("chips", []) if row else []
        step["vnote"] = row.get("note") if row else None
    return tour


@router.post("/shadow/dev/review/verdict")
def post_verdict(body: VerdictBody, authorization: str | None = Header(None)):
    _require_token(authorization)
    path = _verdicts_file()
    path.parent.mkdir(parents=True, exist_ok=True)
    row = body.model_dump()
    row["ts"] = datetime.now(timezone.utc).isoformat()
    with path.open("a", encoding="utf-8") as f:
        f.write(json.dumps(row, ensure_ascii=False) + "\n")
    return {"ok": True}


MAX_VOICE_BYTES = 10 * 1024 * 1024


def _slug(value: str) -> str:
    return re.sub(r"[^a-z0-9-]", "-", value.lower())[:60] or "x"


@router.post("/shadow/dev/review/voice")
async def post_voice(
    wave: str = Form(...),
    id: str = Form(...),
    file: UploadFile = File(...),
    authorization: str | None = Header(None),
):
    _require_token(authorization)
    data = await file.read(MAX_VOICE_BYTES + 1)
    if len(data) > MAX_VOICE_BYTES:
        raise HTTPException(413, "voice note too large")
    dest = _tour_file().parent / "voice"
    dest.mkdir(parents=True, exist_ok=True)
    name = f"{_slug(wave)}-{_slug(id)}-{int(time.time())}.m4a"
    (dest / name).write_bytes(data)
    with _verdicts_file().open("a", encoding="utf-8") as f:
        f.write(json.dumps({"wave": wave, "id": id, "voice": name}) + "\n")
    return {"ok": True, "voice": name}


@router.post("/shadow/dev/review/shot")
async def post_shot(
    wave: str = Form(...),
    id: str = Form(...),
    file: UploadFile = File(...),
    authorization: str | None = Header(None),
):
    _require_token(authorization)
    data = await file.read(MAX_VOICE_BYTES + 1)
    if len(data) > MAX_VOICE_BYTES:
        raise HTTPException(413, "screenshot too large")
    dest = _tour_file().parent / "shots"
    dest.mkdir(parents=True, exist_ok=True)
    name = f"{_slug(wave)}-{_slug(id)}-{int(time.time())}.jpg"
    (dest / name).write_bytes(data)
    with _verdicts_file().open("a", encoding="utf-8") as f:
        f.write(json.dumps({"wave": wave, "id": id, "shot": name}) + "\n")
    return {"ok": True, "shot": name}


class DoneBody(BaseModel):
    wave: str = Field(max_length=200)


@router.post("/shadow/dev/review/done")
def post_done(body: DoneBody, authorization: str | None = Header(None)):
    """Marks the tour as sent. Each press appends one line; the merge skips it."""
    _require_token(authorization)
    path = _verdicts_file()
    path.parent.mkdir(parents=True, exist_ok=True)
    row = {"wave": _slug(body.wave), "done": True, "ts": datetime.now(timezone.utc).isoformat()}
    with path.open("a", encoding="utf-8") as f:
        f.write(json.dumps(row, ensure_ascii=False) + "\n")
    return {"ok": True}
