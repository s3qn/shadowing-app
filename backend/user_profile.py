"""Public @handle per owner, in its own sqlite file (profile.db).

Named user_profile because `profile` is a stdlib module. The unique index on
LOWER(username) is the arbiter for races: set_username writes and maps the
IntegrityError to UsernameTaken, it never checks first.
"""

import os
import re
import sqlite3
import threading
from datetime import datetime, timezone
from pathlib import Path

DATA_DIR = Path(os.getenv("SHADOW_DATA_DIR", Path(__file__).parent / "data"))
DB_PATH = DATA_DIR / "profile.db"

USERNAME_RE = re.compile(r"^[a-z0-9_]{3,20}$")
RESERVED = frozenset(
    {
        "admin",
        "support",
        "moderator",
        "kageneko",
        "shadow",
        "shadowing",
        "staff",
        "null",
        "everyone",
    }
)

SCHEMA = """
CREATE TABLE IF NOT EXISTS profiles (
  owner TEXT PRIMARY KEY,
  username TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS profiles_username_ci ON profiles(LOWER(username));
"""

_local = threading.local()


class UsernameInvalid(ValueError):
    pass


class UsernameTaken(ValueError):
    pass


def connect() -> sqlite3.Connection:
    conn = getattr(_local, "conn", None)
    if conn is None or getattr(_local, "path", None) != DB_PATH:
        DATA_DIR.mkdir(parents=True, exist_ok=True)
        conn = sqlite3.connect(DB_PATH)
        conn.row_factory = sqlite3.Row
        conn.execute("PRAGMA journal_mode = WAL")
        conn.execute("PRAGMA busy_timeout = 5000")
        conn.executescript(SCHEMA)
        _local.conn = conn
        _local.path = DB_PATH
    return conn


def init() -> None:
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    with connect() as conn:
        conn.executescript(SCHEMA)


def normalize(name: str) -> str | None:
    """The stored form of `name`, or None when it is not a valid handle."""
    n = (name or "").strip().lower()
    if not USERNAME_RE.match(n) or n in RESERVED:
        return None
    return n


def get_username(owner: str) -> str | None:
    row = connect().execute(
        "SELECT username FROM profiles WHERE owner=?", (owner,)
    ).fetchone()
    return row["username"] if row else None


def usernames(owners: list[str]) -> dict[str, str]:
    """Batch lookup. Owners without a row are absent."""
    owners = list(dict.fromkeys(owners))
    out: dict[str, str] = {}
    conn = connect()
    for i in range(0, len(owners), 500):
        chunk = owners[i : i + 500]
        marks = ",".join("?" * len(chunk))
        for row in conn.execute(
            f"SELECT owner, username FROM profiles WHERE owner IN ({marks})", chunk
        ):
            out[row["owner"]] = row["username"]
    return out


def check(owner: str, name: str) -> dict:
    n = normalize(name)
    if n is None:
        return {"valid": False, "available": False, "reason": "invalid"}
    row = connect().execute(
        "SELECT owner FROM profiles WHERE LOWER(username)=?", (n,)
    ).fetchone()
    if row and row["owner"] != owner:
        return {"valid": True, "available": False, "reason": "taken"}
    return {"valid": True, "available": True, "reason": None}


def set_username(owner: str, name: str) -> str:
    n = normalize(name)
    if n is None:
        raise UsernameInvalid(name)
    now = datetime.now(timezone.utc).isoformat()
    conn = connect()
    try:
        with conn:
            conn.execute(
                "INSERT INTO profiles(owner, username, created_at, updated_at)"
                " VALUES(?,?,?,?)"
                " ON CONFLICT(owner) DO UPDATE SET username=excluded.username,"
                " updated_at=excluded.updated_at",
                (owner, n, now, now),
            )
    except sqlite3.IntegrityError:
        raise UsernameTaken(n) from None
    return n


def delete_owner(owner: str) -> None:
    with connect() as conn:
        conn.execute("DELETE FROM profiles WHERE owner=?", (owner,))
