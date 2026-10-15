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
  updated_at TEXT NOT NULL,
  serial INTEGER
);
CREATE UNIQUE INDEX IF NOT EXISTS profiles_username_ci ON profiles(LOWER(username));
CREATE TABLE IF NOT EXISTS serial_counter (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  next INTEGER NOT NULL
);
"""


def _migrate(conn: sqlite3.Connection) -> None:
    """Adds the serial column to older databases, then numbers rows that have
    none by creation order. Idempotent: rows with a serial are never touched."""
    cols = {row[1] for row in conn.execute("PRAGMA table_info(profiles)")}
    if "serial" not in cols:
        conn.execute("ALTER TABLE profiles ADD COLUMN serial INTEGER")
    conn.execute("CREATE UNIQUE INDEX IF NOT EXISTS profiles_serial ON profiles(serial)")
    missing = conn.execute(
        "SELECT rowid FROM profiles WHERE serial IS NULL ORDER BY created_at ASC, rowid ASC"
    ).fetchall()
    if missing:
        nxt = conn.execute("SELECT COALESCE(MAX(serial), 0) FROM profiles").fetchone()[0] + 1
        for row in missing:
            conn.execute("UPDATE profiles SET serial=? WHERE rowid=?", (nxt, row[0]))
            nxt += 1
    # One-row monotonic counter, seeded once from the current MAX so a deleted
    # newest account never hands its number to the next signup.
    conn.execute(
        "INSERT OR IGNORE INTO serial_counter(id, next)"
        " VALUES(1, (SELECT COALESCE(MAX(serial), 0) + 1 FROM profiles))"
    )
    # Numbers handed out by the backfill above must never be issued again.
    conn.execute(
        "UPDATE serial_counter SET next=MAX(next, (SELECT COALESCE(MAX(serial), 0) + 1 FROM profiles))"
    )
    conn.commit()

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
        _migrate(conn)
        _local.conn = conn
        _local.path = DB_PATH
    return conn


def init() -> None:
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    with connect() as conn:
        conn.executescript(SCHEMA)
        _migrate(conn)


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


def all_usernames() -> dict[str, str]:
    """Every (owner, username) pair. The leaderboard uses it so every named
    user shows up, even one who has not earned any XP yet."""
    conn = connect()
    return {
        row["owner"]: row["username"]
        for row in conn.execute("SELECT owner, username FROM profiles")
    }


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
            exists = conn.execute(
                "SELECT 1 FROM profiles WHERE owner=?", (owner,)
            ).fetchone()
            if exists:
                conn.execute(
                    "UPDATE profiles SET username=?, updated_at=? WHERE owner=?",
                    (n, now, owner),
                )
            else:
                # Take the number and bump the counter in the same transaction
                # as the insert, so a failed insert hands the number back.
                serial = conn.execute("SELECT next FROM serial_counter WHERE id=1").fetchone()[0]
                conn.execute("UPDATE serial_counter SET next=next+1 WHERE id=1")
                conn.execute(
                    "INSERT INTO profiles(owner, username, created_at, updated_at, serial)"
                    " VALUES(?,?,?,?,?)",
                    (owner, n, now, now, serial),
                )
    except sqlite3.IntegrityError:
        raise UsernameTaken(n) from None
    return n


def lookup(username: str) -> dict | None:
    """A profile by handle, case-insensitive: owner, username, serial, created_at."""
    row = connect().execute(
        "SELECT owner, username, serial, created_at FROM profiles WHERE LOWER(username)=?",
        ((username or "").strip().lower(),),
    ).fetchone()
    return dict(row) if row else None


def delete_owner(owner: str) -> None:
    with connect() as conn:
        conn.execute("DELETE FROM profiles WHERE owner=?", (owner,))
