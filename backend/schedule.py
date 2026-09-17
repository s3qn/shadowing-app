"""Spaced repetition groundwork: log practice events per island and tell the
client which islands are due.

Modeled directly on store.py's connection handling, but kept in its own
sqlite file (schedule.db) and its own module. It never queries store.islands,
so it stays decoupled from store.py: an island only appears in due-today once
it has posted at least one practice event here.
"""

import os
import secrets
import sqlite3
import threading
from datetime import datetime, timezone
from pathlib import Path

from fastapi import APIRouter, Form, Header, HTTPException

import spacing

DATA_DIR = Path(os.getenv("SHADOW_DATA_DIR", Path(__file__).parent / "data"))
DB_PATH = DATA_DIR / "schedule.db"

SHADOW_TOKEN = os.getenv("SHADOW_TOKEN", "")

SCHEMA = """
CREATE TABLE IF NOT EXISTS practice_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  island_id TEXT NOT NULL,
  seconds REAL NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS schedule_state (
  island_id TEXT PRIMARY KEY,
  level INTEGER NOT NULL DEFAULT 0,
  due_on TEXT NOT NULL,
  last_practiced_on TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
"""


def _now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def _today() -> str:
    return datetime.now(timezone.utc).date().isoformat()


# Same reasoning as store.py's _local: routes hop onto asyncio.to_thread's
# reused worker threads, so one connection per thread is a real cache, not a
# one-shot open-and-close.
_local = threading.local()


def _make_dirs() -> None:
    DATA_DIR.mkdir(parents=True, exist_ok=True)


def connect() -> sqlite3.Connection:
    conn = getattr(_local, "conn", None)
    if conn is None:
        conn = sqlite3.connect(DB_PATH)
        conn.row_factory = sqlite3.Row
        conn.execute("PRAGMA foreign_keys = ON")
        conn.execute("PRAGMA journal_mode = WAL")
        _local.conn = conn
    return conn


def init() -> None:
    _make_dirs()
    with connect() as conn:
        conn.executescript(SCHEMA)


def require_token(authorization: str | None) -> None:
    """Copied from main.py's require_token: main imports this module, so this
    module cannot import main back without a cycle."""
    if not SHADOW_TOKEN:
        raise HTTPException(503, "SHADOW_TOKEN is not configured")
    prefix = "Bearer "
    if not authorization or not authorization.startswith(prefix):
        raise HTTPException(401, "missing bearer token")
    if not secrets.compare_digest(authorization[len(prefix):], SHADOW_TOKEN):
        raise HTTPException(401, "bad token")


router = APIRouter(prefix="/shadow/schedule")


@router.post("/practice")
async def log_practice(
    island_id: str = Form(...),
    seconds: float = Form(...),
    authorization: str | None = Header(None),
) -> dict:
    require_token(authorization)
    if seconds <= 0:
        raise HTTPException(400, "seconds must be positive")

    today = _today()
    with connect() as conn:
        conn.execute(
            "INSERT INTO practice_events (island_id, seconds, created_at) VALUES (?, ?, ?)",
            (island_id, seconds, _now()),
        )
        row = conn.execute(
            "SELECT level FROM schedule_state WHERE island_id = ?", (island_id,)
        ).fetchone()
        level = spacing.next_level(row["level"] if row else 0)
        due_on = spacing.due_date(datetime.now(timezone.utc).date(), level).isoformat()
        conn.execute(
            "INSERT INTO schedule_state (island_id, level, due_on, last_practiced_on, updated_at)"
            " VALUES (?, ?, ?, ?, ?)"
            " ON CONFLICT(island_id) DO UPDATE SET"
            " level = excluded.level, due_on = excluded.due_on,"
            " last_practiced_on = excluded.last_practiced_on, updated_at = excluded.updated_at",
            (island_id, level, due_on, today, _now()),
        )

    return {"island_id": island_id, "level": level, "due_on": due_on}


@router.get("/due-today")
async def due_today(authorization: str | None = Header(None)) -> list[dict]:
    require_token(authorization)
    today = _today()
    with connect() as conn:
        rows = conn.execute(
            "SELECT island_id, level, due_on, last_practiced_on FROM schedule_state"
            " WHERE due_on <= ? ORDER BY due_on ASC, island_id ASC",
            (today,),
        ).fetchall()
    return [
        {
            "island_id": row["island_id"],
            "level": row["level"],
            "due_on": row["due_on"],
            "last_practiced_on": row["last_practiced_on"],
        }
        for row in rows
    ]
