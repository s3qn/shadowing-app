"""Admin-controlled beta flag per owner, in its own sqlite file (beta.db).

The key is the principal string (a user id or a bare device id), so one table
serves both. islands.db is never touched.
"""

import os
import sqlite3
import threading
from datetime import datetime, timezone
from pathlib import Path
from typing import Optional

import dbconn

DATA_DIR = Path(os.getenv("SHADOW_DATA_DIR", Path(__file__).parent / "data"))
DB_PATH = DATA_DIR / "beta.db"

SCHEMA = """
CREATE TABLE IF NOT EXISTS beta_flags (
  owner TEXT PRIMARY KEY,
  enabled INTEGER NOT NULL,
  updated_at TEXT NOT NULL,
  updated_by TEXT NOT NULL
);
"""

_local = threading.local()


def _setup(conn: sqlite3.Connection) -> None:
    conn.executescript(SCHEMA)


def connect() -> sqlite3.Connection:
    return dbconn.thread_conn(
        _local, DB_PATH, "journal_mode = WAL", "busy_timeout = 5000", setup=_setup, mkdir=True,
    )


def init() -> None:
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    with connect() as conn:
        conn.executescript(SCHEMA)


def flag(owner: str) -> Optional[bool]:
    """The stored switch, or None when nobody has set one for this owner.
    main._beta_on turns None into the default (admins on, everyone else off)."""
    row = connect().execute("SELECT enabled FROM beta_flags WHERE owner=?", (owner,)).fetchone()
    return None if row is None else bool(row["enabled"])


def is_enabled(owner: str) -> bool:
    return bool(flag(owner))


def set_flag(owner: str, enabled: bool, by: str) -> None:
    now = datetime.now(timezone.utc).isoformat()
    with connect() as conn:
        conn.execute(
            "INSERT INTO beta_flags(owner, enabled, updated_at, updated_by) VALUES(?,?,?,?)"
            " ON CONFLICT(owner) DO UPDATE SET enabled=excluded.enabled,"
            " updated_at=excluded.updated_at, updated_by=excluded.updated_by",
            (owner, 1 if enabled else 0, now, by),
        )


def list_flags() -> dict[str, bool]:
    return {
        row["owner"]: bool(row["enabled"])
        for row in connect().execute("SELECT owner, enabled FROM beta_flags")
    }


def delete_owner(owner: str) -> None:
    with connect() as conn:
        conn.execute("DELETE FROM beta_flags WHERE owner=?", (owner,))
