"""Spaced repetition groundwork: log practice events per island and tell the
client which islands are due.

Modeled directly on store.py's connection handling, but kept in its own
sqlite file (schedule.db) and its own module. The only thing it reads from
store is ownership: a practice post is accepted and awarded only for an island
the caller owns (see _own_island). An island still appears in due-today only
once it has posted at least one practice event here.
"""

import asyncio
import logging
import math
import os
import secrets
import sqlite3
import threading
from datetime import date, datetime, timezone
from pathlib import Path

from fastapi import APIRouter, Form, Header, HTTPException

import dbconn
import progression
import spacing
import store

log = logging.getLogger("shadow.schedule")

# The most playback one post may claim. A real client flushes a few seconds at
# a time; anything past an hour in a single post is a forged award, not a
# sitting, so it is refused rather than paid.
MAX_PRACTICE_SECONDS = 3600.0

DATA_DIR = Path(os.getenv("SHADOW_DATA_DIR", Path(__file__).parent / "data"))
DB_PATH = DATA_DIR / "schedule.db"

# Sources whose practice never touches the spaced-repetition schedule.
NO_SCHEDULE_SOURCES = frozenset({"youtube", "podcast"})

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


# One connection per thread, see dbconn.
_local = threading.local()


def _make_dirs() -> None:
    DATA_DIR.mkdir(parents=True, exist_ok=True)


def connect() -> sqlite3.Connection:
    return dbconn.thread_conn(_local, DB_PATH, "foreign_keys = ON", "journal_mode = WAL")


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
        # Where the practiced island's audio came from, stamped at insert so
        # the split survives the island being deleted.
        if "source" not in events_cols:
            conn.execute("ALTER TABLE practice_events ADD COLUMN source TEXT NOT NULL DEFAULT ''")
        for (island_id,) in conn.execute(
            "SELECT DISTINCT island_id FROM practice_events WHERE source=''"
        ).fetchall():
            src = store.island_source(island_id)
            if src:
                conn.execute(
                    "UPDATE practice_events SET source=? WHERE island_id=? AND source=''",
                    (src, island_id),
                )
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


def _own_island(island_id: str, device: str) -> None:
    """Refuse a practice post for an island `device` does not own. Mirrors
    main._own_island (which this module cannot import without a cycle): an
    empty device never matches, so an unclaimed island (device='') is not
    owned by a blank caller, and an unknown island id pays nothing."""
    owner = store.island_device(island_id)
    if owner is None or not device or owner != device:
        raise HTTPException(404, "no such island")


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


def immersion(device: str) -> dict:
    """Total practice seconds for `device` and the split by island source."""
    with connect() as conn:
        rows = conn.execute(
            "SELECT source, COALESCE(SUM(seconds), 0) AS s FROM practice_events"
            " WHERE device=? GROUP BY source",
            (device,),
        ).fetchall()
    by_source = {r["source"]: float(r["s"]) for r in rows}
    return {"total": sum(by_source.values()), "by_source": by_source}


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
    # The sqlite work and the award are blocking, so the body runs on a worker
    # thread and never stalls the event loop.
    return await asyncio.to_thread(
        _log_practice_sync, island_id, seconds, authorization, x_shadow_device
    )


def _log_practice_sync(
    island_id: str, seconds: float, authorization: str | None, x_shadow_device: str
) -> dict:
    require_token(authorization)
    device = _require_device(x_shadow_device)
    if not math.isfinite(seconds) or seconds <= 0:
        raise HTTPException(400, "seconds must be a positive finite number")
    if seconds > MAX_PRACTICE_SECONDS:
        raise HTTPException(400, "seconds too large")
    # Ownership first: a post for an island the caller does not own (or a made
    # up id) is refused before anything is written or awarded, so a forged
    # island_id cannot earn coins or XP.
    _own_island(island_id, device)

    today = _today()
    today_date = date.fromisoformat(today)
    source = store.island_source(island_id) or ""
    with connect() as conn:
        conn.execute(
            "INSERT INTO practice_events (island_id, seconds, created_at, device, source)"
            " VALUES (?, ?, ?, ?, ?)",
            (island_id, seconds, _now(), device, source),
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

        # YouTube and podcast islands are not part of the due-today loop, so
        # their practice counts minutes and XP but never moves a due date.
        if source not in NO_SCHEDULE_SOURCES:
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

    result = {
        "island_id": island_id,
        "level": level,
        "due_on": due_on,
        "seconds_today": seconds_today,
    }
    try:
        result["award"] = progression.award_practice(device, island_id, seconds_today)
    except Exception:
        log.exception("practice award failed")
    return result


@router.get("/due-today")
async def due_today(
    authorization: str | None = Header(None),
    x_shadow_device: str = Header(""),
) -> list[dict]:
    require_token(authorization)
    device = _require_device(x_shadow_device)
    today = _today()
    # Long media is watched or listened to, not drilled wholesale: its
    # sentences are reviewed through the saved-sentence deck instead.
    excluded = {
        i["id"] for i in store.list_islands(device) if i["source"] in ("podcast", "youtube")
    }
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
        if row["island_id"] not in excluded
    ]
