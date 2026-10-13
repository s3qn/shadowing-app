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
from datetime import date, datetime, timezone
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
  updated_at TEXT NOT NULL,
  moved_on TEXT NOT NULL DEFAULT ''
);
"""


def _now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def _today() -> str:
    """The day everything here is measured in: the UTC day, the same day
    store.count_builds_today uses for the daily build limit. One rule for
    both, so a phone never sees two different notions of today."""
    return datetime.now(timezone.utc).date().isoformat()


def _as_date(value: str, fallback: date) -> date:
    """A stored YYYY-MM-DD as a date, falling back for anything unparseable
    (an empty or hand-edited column) so one bad row cannot 500 a practice."""
    try:
        return date.fromisoformat(value)
    except ValueError:
        return fallback


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
        # device-scope: databases created before per-device islands existed
        # lack the column that scopes a practice event or schedule row to
        # the phone that logged it.
        events_cols = {row["name"] for row in conn.execute("PRAGMA table_info(practice_events)")}
        if "device" not in events_cols:
            conn.execute("ALTER TABLE practice_events ADD COLUMN device TEXT NOT NULL DEFAULT ''")
        state_cols = {row["name"] for row in conn.execute("PRAGMA table_info(schedule_state)")}
        if "device" not in state_cols:
            conn.execute("ALTER TABLE schedule_state ADD COLUMN device TEXT NOT NULL DEFAULT ''")
        # The day a row's level last moved. Rows written before the once-a-day
        # rule existed get '', which is no day, so the next practice with
        # enough seconds moves them once and then the row holds for the day.
        if "moved_on" not in state_cols:
            conn.execute("ALTER TABLE schedule_state ADD COLUMN moved_on TEXT NOT NULL DEFAULT ''")


def require_token(authorization: str | None) -> None:
    """Copied from main.py's require_token: main imports this module, so this
    module cannot import main back without a cycle."""
    if not SHADOW_TOKEN:
        raise HTTPException(503, "SHADOW_TOKEN is not configured")
    prefix = "Bearer "
    if not authorization or not authorization.startswith(prefix):
        raise HTTPException(401, "missing bearer token")
    if not secrets.compare_digest(
        authorization[len(prefix):].encode("utf-8"), SHADOW_TOKEN.encode("utf-8")
    ):
        raise HTTPException(401, "bad token")


def _require_device(x_shadow_device: str) -> str:
    """Copied from main.py's `_require_device`: main imports this module, so
    this module cannot import main back without a cycle."""
    if not x_shadow_device:
        raise HTTPException(401, "missing device id")
    return x_shadow_device


def claim_unowned(device: str) -> int:
    """Gives every unowned practice row to `device`, the schedule half of
    store.claim_unowned. Idempotent: rows already claimed have device != ''
    and are left alone."""
    with connect() as conn:
        n = conn.execute(
            "UPDATE practice_events SET device=? WHERE device=''", (device,)
        ).rowcount
        conn.execute("UPDATE schedule_state SET device=? WHERE device=''", (device,))
        return n


def delete_owner(device: str) -> None:
    with connect() as conn:
        conn.execute("DELETE FROM practice_events WHERE device=?", (device,))
        conn.execute("DELETE FROM schedule_state WHERE device=?", (device,))


router = APIRouter(prefix="/shadow/schedule")


@router.post("/practice")
async def log_practice(
    island_id: str = Form(...),
    seconds: float = Form(...),
    authorization: str | None = Header(None),
    x_shadow_device: str = Header(""),
) -> dict:
    require_token(authorization)
    device = _require_device(x_shadow_device)
    if seconds <= 0:
        raise HTTPException(400, "seconds must be positive")

    today = _today()
    today_date = date.fromisoformat(today)
    with connect() as conn:
        conn.execute(
            "INSERT INTO practice_events (island_id, seconds, created_at, device)"
            " VALUES (?, ?, ?, ?)",
            (island_id, seconds, _now(), device),
        )
        # Every second this phone has posted for this island today, this post
        # included. The client only counts line playback (usePracticeClock),
        # so these are seconds heard, not seconds of screen open.
        seconds_today = conn.execute(
            "SELECT COALESCE(SUM(seconds), 0) AS total FROM practice_events"
            " WHERE island_id = ? AND device = ? AND substr(created_at, 1, 10) = ?",
            (island_id, device, today),
        ).fetchone()["total"]
        row = conn.execute(
            "SELECT level, due_on, moved_on FROM schedule_state"
            " WHERE island_id = ? AND device = ?",
            (island_id, device),
        ).fetchone()
        level = row["level"] if row else 0
        # A new island sits at level 0, due today: it stays in due-today until
        # a day's playback is long enough to count as a practice.
        due_on = row["due_on"] if row else today
        moved_on = row["moved_on"] if row else ""

        if seconds_today >= spacing.PRACTICED_MIN_SECONDS and moved_on != today:
            days_late = max(0, (today_date - _as_date(due_on, today_date)).days)
            level = spacing.next_level(level, days_late)
            due_on = spacing.due_date(today_date, level).isoformat()
            moved_on = today

        conn.execute(
            "INSERT INTO schedule_state"
            " (island_id, level, due_on, last_practiced_on, updated_at, device, moved_on)"
            " VALUES (?, ?, ?, ?, ?, ?, ?)"
            " ON CONFLICT(island_id) DO UPDATE SET"
            " level = excluded.level, due_on = excluded.due_on,"
            " last_practiced_on = excluded.last_practiced_on, updated_at = excluded.updated_at,"
            " moved_on = excluded.moved_on"
            # Only the device that owns the row moves it: a post from another
            # phone for a known island id leaves the owner's due marker alone.
            " WHERE schedule_state.device = excluded.device",
            (island_id, level, due_on, today, _now(), device, moved_on),
        )

    return {
        "island_id": island_id,
        "level": level,
        "due_on": due_on,
        "seconds_today": seconds_today,
    }


@router.get("/due-today")
async def due_today(
    authorization: str | None = Header(None),
    x_shadow_device: str = Header(""),
) -> list[dict]:
    require_token(authorization)
    device = _require_device(x_shadow_device)
    today = _today()
    with connect() as conn:
        rows = conn.execute(
            "SELECT island_id, level, due_on, last_practiced_on FROM schedule_state"
            " WHERE due_on <= ? AND device = ? ORDER BY due_on ASC, island_id ASC",
            (today, device),
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
