"""XP, level, coins and cosmetics per owner.

Kept in its own sqlite file (progression.db) beside schedule.db and modeled on
schedule.py: its own connect/init and the UTC day as "today". It has no
FastAPI routes (main.py owns them), so schedule.py can import it for practice
awards without an import cycle.

The level is never stored: it is derived from total XP. Every award is a
ledger row keyed by (owner, key), so a replayed request pays nothing.
"""

import json
import logging
import os
import sqlite3
import threading
from datetime import datetime, timezone
from pathlib import Path

from fastapi import HTTPException

import spacing

log = logging.getLogger("shadow.progression")

DATA_DIR = Path(os.getenv("SHADOW_DATA_DIR", Path(__file__).parent / "data"))
DB_PATH = DATA_DIR / "progression.db"
CATALOG_PATH = Path(__file__).parent / "cosmetics_catalog.json"

MAX_LEVEL = 50
CATALOG_VERSION = 1
LEVEL_UP_COINS = 25

DAY_XP, DAY_COINS = 20, 5
PRACTICED_XP, PRACTICED_COINS = 30, 10
MINUTE_XP, MINUTE_COINS = 5, 1
MINUTE_CAP = 20
TAKE_XP, TAKE_COINS = 10, 2
TAKES_PER_DAY = 60

SCHEMA = """
CREATE TABLE IF NOT EXISTS progress (
  owner TEXT PRIMARY KEY,
  xp INTEGER NOT NULL DEFAULT 0,
  coins INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS awards (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  owner TEXT NOT NULL,
  key TEXT NOT NULL,
  xp INTEGER NOT NULL,
  coins INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE(owner, key)
);
CREATE TABLE IF NOT EXISTS owned (
  owner TEXT NOT NULL,
  item_id TEXT NOT NULL,
  bought_at TEXT NOT NULL,
  PRIMARY KEY(owner, item_id)
);
CREATE TABLE IF NOT EXISTS equipped (
  owner TEXT NOT NULL,
  slot TEXT NOT NULL,
  item_id TEXT NOT NULL,
  PRIMARY KEY(owner, slot)
);
"""


def _now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def _today() -> str:
    """The UTC day, the same day schedule.py and the build limit use."""
    return datetime.now(timezone.utc).date().isoformat()


_local = threading.local()


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


# --- the curve ---


def xp_to_next(level: int) -> int:
    """XP needed to go from `level` to `level + 1`."""
    return round(60 * level ** 1.3)


def _split(xp: int) -> tuple[int, int, int]:
    """(level, xp into that level, xp to the next level; 0 at the cap)."""
    level, left = 1, max(0, int(xp))
    while level < MAX_LEVEL:
        need = xp_to_next(level)
        if left < need:
            return level, left, need
        left -= need
        level += 1
    return level, left, 0


def level_for(xp: int) -> int:
    return _split(xp)[0]


# --- the catalog ---

with open(CATALOG_PATH, encoding="utf-8") as _f:
    _CATALOG = json.load(_f)
_ITEMS = {item["id"]: item for item in _CATALOG["items"]}
SLOTS = list(_CATALOG["slots"])


def _pick(entry: dict, field: str, suffix: str) -> str | None:
    if suffix:
        translated = entry.get(f"{field}{suffix}")
        if translated:
            return translated
    return entry.get(field)


def catalog(ui: str = "en") -> dict:
    suffix = "He" if ui == "he" else ""
    items = []
    for item in _CATALOG["items"]:
        items.append(
            {
                "id": item["id"],
                "slot": item["slot"],
                "name": _pick(item, "name", suffix),
                "level_req": item["level_req"],
                "price": item["price"],
                "art": item["art"],
            }
        )
    return {
        "version": CATALOG_VERSION,
        "slots": SLOTS,
        "shapes": _CATALOG["shapes"],
        "items": items,
    }


# --- reading ---


def _read(conn: sqlite3.Connection, owner: str) -> dict:
    row = conn.execute("SELECT xp, coins FROM progress WHERE owner=?", (owner,)).fetchone()
    xp, coins = (row["xp"], row["coins"]) if row else (0, 0)
    level, into, to_next = _split(xp)
    owned = [
        r["item_id"]
        for r in conn.execute(
            "SELECT item_id FROM owned WHERE owner=? ORDER BY bought_at, item_id", (owner,)
        )
    ]
    equipped = {slot: None for slot in SLOTS}
    for r in conn.execute("SELECT slot, item_id FROM equipped WHERE owner=?", (owner,)):
        if r["slot"] in equipped:
            equipped[r["slot"]] = r["item_id"]
    return {
        "xp": xp,
        "level": level,
        "coins": coins,
        "xp_into_level": into,
        "xp_to_next": to_next,
        "owned": owned,
        "equipped": equipped,
        "catalog_version": CATALOG_VERSION,
    }


def snapshot(owner: str) -> dict:
    return _read(connect(), owner)


# --- awards ---


def _apply(conn: sqlite3.Connection, owner: str, key: str, xp: int, coins: int) -> tuple[int, int]:
    """Pays one ledger key inside the caller's open transaction. Returns the
    (xp, coins) actually granted, level-up coins included; (0, 0) when the key
    was already paid."""
    cur = conn.execute(
        "INSERT OR IGNORE INTO awards (owner, key, xp, coins, created_at) VALUES (?, ?, ?, ?, ?)",
        (owner, key, xp, coins, _now()),
    )
    if cur.rowcount != 1:
        return 0, 0
    conn.execute(
        "INSERT OR IGNORE INTO progress (owner, xp, coins, updated_at) VALUES (?, 0, 0, ?)",
        (owner, _now()),
    )
    old_xp = conn.execute("SELECT xp FROM progress WHERE owner=?", (owner,)).fetchone()["xp"]
    gained = max(0, level_for(old_xp + xp) - level_for(old_xp))
    bonus = gained * LEVEL_UP_COINS
    conn.execute(
        "UPDATE progress SET xp = xp + ?, coins = coins + ?, updated_at = ? WHERE owner=?",
        (xp, coins + bonus, _now(), owner),
    )
    return xp, coins + bonus


def _run_awards(owner: str, entries: list[tuple[str, int, int]], day: str, take_cap: bool = False) -> dict:
    """Pays the given (key, xp, coins) entries in one transaction. When any of
    them pays and the day bonus is still unpaid, the day bonus is added."""
    conn = connect()
    conn.execute("BEGIN IMMEDIATE")
    try:
        before = conn.execute("SELECT xp FROM progress WHERE owner=?", (owner,)).fetchone()
        old_level = level_for(before["xp"] if before else 0)
        got_xp = got_coins = 0
        paid = False
        for key, xp, coins in entries:
            if take_cap and key.startswith("take:"):
                n = conn.execute(
                    "SELECT COUNT(*) AS n FROM awards WHERE owner=? AND key LIKE ?",
                    (owner, f"take:%:{day}"),
                ).fetchone()["n"]
                if n >= TAKES_PER_DAY:
                    continue
            gx, gc = _apply(conn, owner, key, xp, coins)
            if gx or gc:
                paid = True
            got_xp += gx
            got_coins += gc
        if paid:
            gx, gc = _apply(conn, owner, f"day:{day}", DAY_XP, DAY_COINS)
            got_xp += gx
            got_coins += gc
        after = conn.execute("SELECT xp FROM progress WHERE owner=?", (owner,)).fetchone()
        level = level_for(after["xp"] if after else 0)
        conn.commit()
    except BaseException:
        conn.rollback()
        raise
    return {"xp": got_xp, "coins": got_coins, "level": level, "leveled_up": level > old_level}


def award(owner: str, key: str, xp: int, coins: int) -> dict:
    """The primitive: pays `key` once. Replays return zeros."""
    return _run_awards_plain(owner, key, xp, coins)


def _run_awards_plain(owner: str, key: str, xp: int, coins: int) -> dict:
    conn = connect()
    conn.execute("BEGIN IMMEDIATE")
    try:
        before = conn.execute("SELECT xp FROM progress WHERE owner=?", (owner,)).fetchone()
        old_level = level_for(before["xp"] if before else 0)
        gx, gc = _apply(conn, owner, key, xp, coins)
        after = conn.execute("SELECT xp FROM progress WHERE owner=?", (owner,)).fetchone()
        level = level_for(after["xp"] if after else 0)
        conn.commit()
    except BaseException:
        conn.rollback()
        raise
    return {"xp": gx, "coins": gc, "level": level, "leveled_up": level > old_level}


def award_practice(owner: str, island_id: str, seconds_today: float) -> dict:
    """Milestones for one island's playback today: the practiced bonus once
    seconds_today reaches the spacing threshold, and 5 XP per full minute up
    to 20. The day bonus rides along with the first paid key of the day."""
    day = _today()
    entries: list[tuple[str, int, int]] = []
    if seconds_today >= spacing.PRACTICED_MIN_SECONDS:
        entries.append((f"practiced:{island_id}:{day}", PRACTICED_XP, PRACTICED_COINS))
    for m in range(1, min(MINUTE_CAP, int(seconds_today // 60)) + 1):
        entries.append((f"minute:{island_id}:{day}:{m}", MINUTE_XP, MINUTE_COINS))
    if not entries:
        return {"xp": 0, "coins": 0, "level": level_for(snapshot(owner)["xp"]), "leveled_up": False}
    return _run_awards(owner, entries, day)


def award_take(owner: str, island_id: str, idx: int) -> dict:
    day = _today()
    return _run_awards(
        owner, [(f"take:{island_id}:{idx}:{day}", TAKE_XP, TAKE_COINS)], day, take_cap=True
    )


# --- shop ---


def _err(status: int, **body) -> HTTPException:
    return HTTPException(status, body)


def buy(owner: str, item_id: str) -> dict:
    item = _ITEMS.get(item_id)
    if item is None:
        raise _err(404, code="unknown_item")
    conn = connect()
    conn.execute("BEGIN IMMEDIATE")
    try:
        if conn.execute(
            "SELECT 1 FROM owned WHERE owner=? AND item_id=?", (owner, item_id)
        ).fetchone():
            conn.rollback()
            return snapshot(owner)
        conn.execute(
            "INSERT OR IGNORE INTO progress (owner, xp, coins, updated_at) VALUES (?, 0, 0, ?)",
            (owner, _now()),
        )
        row = conn.execute("SELECT xp, coins FROM progress WHERE owner=?", (owner,)).fetchone()
        if level_for(row["xp"]) < item["level_req"]:
            conn.rollback()
            raise _err(400, code="level_locked", level_req=item["level_req"])
        price = item["price"]
        cur = conn.execute(
            "UPDATE progress SET coins = coins - ?, updated_at = ? WHERE owner=? AND coins >= ?",
            (price, _now(), owner, price),
        )
        if cur.rowcount != 1:
            conn.rollback()
            raise _err(400, code="not_enough_coins", price=price, coins=row["coins"])
        conn.execute(
            "INSERT OR IGNORE INTO owned (owner, item_id, bought_at) VALUES (?, ?, ?)",
            (owner, item_id, _now()),
        )
        conn.execute(
            "INSERT INTO equipped (owner, slot, item_id) VALUES (?, ?, ?)"
            " ON CONFLICT(owner, slot) DO UPDATE SET item_id = excluded.item_id",
            (owner, item["slot"], item_id),
        )
        conn.commit()
    except HTTPException:
        raise
    except BaseException:
        conn.rollback()
        raise
    return snapshot(owner)


def equip(owner: str, slot: str, item_id: str) -> dict:
    if slot not in SLOTS:
        raise _err(400, code="bad_slot")
    conn = connect()
    with conn:
        if not item_id:
            conn.execute("DELETE FROM equipped WHERE owner=? AND slot=?", (owner, slot))
        else:
            item = _ITEMS.get(item_id)
            if item is None:
                raise _err(400, code="not_owned")
            if item["slot"] != slot:
                raise _err(400, code="wrong_slot")
            if not conn.execute(
                "SELECT 1 FROM owned WHERE owner=? AND item_id=?", (owner, item_id)
            ).fetchone():
                raise _err(400, code="not_owned")
            conn.execute(
                "INSERT INTO equipped (owner, slot, item_id) VALUES (?, ?, ?)"
                " ON CONFLICT(owner, slot) DO UPDATE SET item_id = excluded.item_id",
                (owner, slot, item_id),
            )
    return snapshot(owner)


def delete_owner(owner: str) -> None:
    with connect() as conn:
        for table in ("progress", "awards", "owned", "equipped"):
            conn.execute(f"DELETE FROM {table} WHERE owner=?", (owner,))
