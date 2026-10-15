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
from datetime import date, datetime, timedelta, timezone
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

# Every repeatable source (take, minute, practiced, day, streak, quality,
# mastery) is clamped to this much XP per UTC day. Milestones are exempt.
DAILY_XP_CAP = 120
QUALITY_GOOD = 0.5
QUALITY_GREAT = 0.8
QUALITY_MIN_WORDS = 3
QUALITY_XP, QUALITY_COINS = 5, 1
MASTERY_XP, MASTERY_COINS = 60, 20
# (minimum streak days, xp, coins), longest first.
STREAK_TIERS = ((30, 30, 8), (7, 20, 5), (3, 10, 3))
MILESTONES = {
    "first_take": (40, 10),
    "first_island": (40, 10),
    "perfect_take": (60, 15),
    "full_speed": (60, 15),
    "first_mastery": (80, 20),
    "streak_7": (60, 15),
    "streak_30": (150, 40),
    # Level milestones pay coins only: XP for a level would feed itself.
    "level_5": (0, 30),
    "level_10": (0, 60),
    "level_20": (0, 100),
}

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
CREATE TABLE IF NOT EXISTS day_xp (
  owner TEXT NOT NULL,
  day TEXT NOT NULL,
  xp INTEGER NOT NULL,
  PRIMARY KEY(owner, day)
);
CREATE TABLE IF NOT EXISTS line_best (
  owner TEXT NOT NULL,
  island_id TEXT NOT NULL,
  idx INTEGER NOT NULL,
  best REAL NOT NULL,
  updated_at TEXT,
  PRIMARY KEY(owner, island_id, idx)
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
    today = _today()
    used = conn.execute("SELECT xp FROM day_xp WHERE owner=? AND day=?", (owner, today)).fetchone()
    days = _day_keys(conn, owner)
    end = date.fromisoformat(today)
    if today not in days:
        end -= timedelta(days=1)
    streak = 0
    while end.isoformat() in days:
        streak += 1
        end -= timedelta(days=1)
    return {
        "xp": xp,
        "xp_today": used["xp"] if used else 0,
        "xp_today_cap": DAILY_XP_CAP,
        "streak_days": streak,
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


def stats(owner: str) -> dict:
    """Public counters for the profile screen, all derived from the ledger."""
    conn = connect()
    days = sorted(_day_keys(conn, owner))
    longest = run = 0
    prev = None
    for d in days:
        cur = date.fromisoformat(d)
        run = run + 1 if prev is not None and cur - prev == timedelta(days=1) else 1
        longest = max(longest, run)
        prev = cur
    xp_row = conn.execute("SELECT MAX(xp) AS m FROM day_xp WHERE owner=?", (owner,)).fetchone()
    cap_days = conn.execute(
        "SELECT COUNT(*) AS n FROM day_xp WHERE owner=? AND xp >= ?", (owner, DAILY_XP_CAP)
    ).fetchone()["n"]
    mastered = conn.execute(
        "SELECT COUNT(*) AS n FROM awards WHERE owner=? AND key LIKE 'mastery:%'", (owner,)
    ).fetchone()["n"]
    lines = set()
    for r in conn.execute("SELECT key FROM awards WHERE owner=? AND key LIKE 'take:%'", (owner,)):
        parts = r["key"].split(":")
        if len(parts) >= 4:
            lines.add((":".join(parts[1:-2]), parts[-2]))
    lb = conn.execute(
        "SELECT COUNT(CASE WHEN best >= ? THEN 1 END) AS great, AVG(best) AS avg"
        " FROM line_best WHERE owner=?",
        (QUALITY_GREAT, owner),
    ).fetchone()
    milestones = [
        r["key"][3:]
        for r in conn.execute(
            "SELECT key FROM awards WHERE owner=? AND key LIKE 'ms:%' ORDER BY key", (owner,)
        )
    ]
    return {
        "longest_streak": longest,
        "days_active": len(days),
        "best_xp_day": int(xp_row["m"] or 0),
        "cap_days": cap_days,
        "islands_mastered": mastered,
        "lines_practiced": len(lines),
        "lines_mastered": lb["great"] or 0,
        "average_accuracy": float(lb["avg"]) if lb["avg"] is not None else None,
        "milestones": milestones,
    }


# --- awards ---


def _apply(
    conn: sqlite3.Connection, owner: str, key: str, xp: int, coins: int, day: str, capped: bool,
    defer_if_capped: bool = False,
) -> tuple[bool, int, int]:
    """Pays one ledger key inside the caller's open transaction. Returns
    (paid, xp granted, coins granted), level-up coins included. `paid` is False
    for a replayed key, which changes nothing. When `capped` the XP is clamped
    to what is left of DAILY_XP_CAP for `day`; the row keeps the XP actually
    granted, so progress.xp always equals the sum of the owner's ledger.

    Coins track the XP actually granted: when the cap clamps the grant to 0 the
    key pays 0 coins too, so coins stop at the cap. With `defer_if_capped`, a
    grant the cap clamps to 0 is not recorded at all (returns False), so a
    non-repeatable source such as island mastery pays on a later day with room
    instead of being consumed at the cap and lost."""
    granted = xp
    coins_granted = coins
    if capped and xp > 0:
        row = conn.execute(
            "SELECT xp FROM day_xp WHERE owner=? AND day=?", (owner, day)
        ).fetchone()
        used = row["xp"] if row else 0
        granted = max(0, min(xp, DAILY_XP_CAP - used))
        if granted == 0:
            coins_granted = 0
            if defer_if_capped:
                return False, 0, 0
    cur = conn.execute(
        "INSERT OR IGNORE INTO awards (owner, key, xp, coins, created_at) VALUES (?, ?, ?, ?, ?)",
        (owner, key, granted, coins_granted, _now()),
    )
    if cur.rowcount != 1:
        return False, 0, 0
    if capped and xp > 0:
        conn.execute(
            "INSERT INTO day_xp (owner, day, xp) VALUES (?, ?, ?)"
            " ON CONFLICT(owner, day) DO UPDATE SET xp = xp + excluded.xp",
            (owner, day, granted),
        )
    conn.execute(
        "INSERT OR IGNORE INTO progress (owner, xp, coins, updated_at) VALUES (?, 0, 0, ?)",
        (owner, _now()),
    )
    old_xp = conn.execute("SELECT xp FROM progress WHERE owner=?", (owner,)).fetchone()["xp"]
    gained = max(0, level_for(old_xp + granted) - level_for(old_xp))
    bonus = gained * LEVEL_UP_COINS
    conn.execute(
        "UPDATE progress SET xp = xp + ?, coins = coins + ?, updated_at = ? WHERE owner=?",
        (granted, coins_granted + bonus, _now(), owner),
    )
    return True, granted, coins_granted + bonus


def _day_keys(conn: sqlite3.Connection, owner: str) -> set[str]:
    return {
        r["key"][4:]
        for r in conn.execute("SELECT key FROM awards WHERE owner=? AND key LIKE 'day:%'", (owner,))
    }


def _streak_days(conn: sqlite3.Connection, owner: str, end_day: str) -> int:
    """Consecutive paid `day:` keys ending at `end_day`."""
    days = _day_keys(conn, owner)
    cur = date.fromisoformat(end_day)
    n = 0
    while cur.isoformat() in days:
        n += 1
        cur -= timedelta(days=1)
    return n


def _ok_ratio(score) -> tuple[float, int] | None:
    """(ok ratio, scoreable word count) of a take score, or None when the
    score carries no scoreable words. Same rule as scoredTier on the client:
    `none` words are excluded."""
    if not isinstance(score, dict) or not isinstance(score.get("words"), list):
        return None
    scored = [w for w in score["words"] if w != "none"]
    if not scored:
        return None
    return sum(1 for w in scored if w == "ok") / len(scored), len(scored)


def _milestones(conn: sqlite3.Connection, owner: str, day: str, ctx: dict) -> tuple[int, int, list[str]]:
    """Pays the one-time milestones whose condition holds. Uncapped: they
    neither use up daily room nor count in xp_today."""
    got_xp = got_coins = 0
    names: list[str] = []

    def pay(name: str) -> None:
        nonlocal got_xp, got_coins
        xp, coins = MILESTONES[name]
        paid, gx, gc = _apply(conn, owner, f"ms:{name}", xp, coins, day, False)
        if paid:
            got_xp += gx
            got_coins += gc
            names.append(name)

    streak = ctx.get("streak") or 0
    for name, hit in (
        ("first_take", ctx.get("take")),
        ("first_island", ctx.get("practiced")),
        ("perfect_take", ctx.get("perfect")),
        ("full_speed", ctx.get("full_speed")),
        ("first_mastery", ctx.get("mastered")),
        ("streak_7", streak >= 7),
        ("streak_30", streak >= 30),
    ):
        if hit:
            pay(name)
    for level, name in ((5, "level_5"), (10, "level_10"), (20, "level_20")):
        row = conn.execute("SELECT xp FROM progress WHERE owner=?", (owner,)).fetchone()
        if level_for(row["xp"] if row else 0) >= level:
            pay(name)
    return got_xp, got_coins, names


def _run_awards(
    owner: str,
    entries: list[tuple[str, int, int]],
    day: str,
    take_cap: bool = False,
    prepare=None,
    ctx: dict | None = None,
) -> dict:
    """Pays the given (key, xp, coins) entries in one transaction, every one
    clamped to the daily cap. When any of them pays and the day bonus is still
    unpaid, the day bonus is added, then the streak bonus and the milestones.
    `prepare(conn)` runs first inside the transaction and returns more entries."""
    ctx = dict(ctx or {})
    conn = connect()
    conn.execute("BEGIN IMMEDIATE")
    try:
        before = conn.execute("SELECT xp FROM progress WHERE owner=?", (owner,)).fetchone()
        old_level = level_for(before["xp"] if before else 0)
        got_xp = got_coins = 0
        any_paid = False
        take_blocked = False
        entries = list(entries)
        if prepare is not None:
            entries += prepare(conn)
        for key, xp, coins in entries:
            if take_cap and key.startswith("take:"):
                n = conn.execute(
                    "SELECT COUNT(*) AS n FROM awards WHERE owner=? AND key LIKE ?",
                    (owner, f"take:%:{day}"),
                ).fetchone()["n"]
                if n >= TAKES_PER_DAY:
                    take_blocked = True
                    continue
            if take_blocked and key.startswith("quality:"):
                continue
            # Mastery counts toward the daily cap like every other repeatable
            # source, but it is once per island (not day-scoped), so defer it
            # when the cap leaves no room: it stays unrecorded and pays on a
            # later day instead of being lost at the cap.
            is_mastery = key.startswith("mastery:")
            paid, gx, gc = _apply(conn, owner, key, xp, coins, day, True, defer_if_capped=is_mastery)
            if paid:
                any_paid = True
                got_xp += gx
                got_coins += gc
                if key.startswith("take:"):
                    ctx["take_paid"] = True
                elif key.startswith("practiced:"):
                    ctx["practiced"] = True
                elif key.startswith("mastery:"):
                    ctx["mastered"] = True
        if take_blocked:
            ctx["perfect"] = ctx["full_speed"] = False
        ctx["take"] = ctx.pop("take_paid", False)
        if any_paid:
            paid, gx, gc = _apply(conn, owner, f"day:{day}", DAY_XP, DAY_COINS, day, True)
            got_xp += gx
            got_coins += gc
            if paid:
                streak = _streak_days(conn, owner, day)
                ctx["streak"] = streak
                for min_days, sxp, scoins in STREAK_TIERS:
                    if streak >= min_days:
                        _, gx, gc = _apply(conn, owner, f"streak:{day}", sxp, scoins, day, True)
                        got_xp += gx
                        got_coins += gc
                        break
        mx, mc, names = _milestones(conn, owner, day, ctx)
        got_xp += mx
        got_coins += mc
        after = conn.execute("SELECT xp FROM progress WHERE owner=?", (owner,)).fetchone()
        level = level_for(after["xp"] if after else 0)
        used = conn.execute(
            "SELECT xp FROM day_xp WHERE owner=? AND day=?", (owner, day)
        ).fetchone()
        conn.commit()
    except BaseException:
        conn.rollback()
        raise
    return {
        "xp": got_xp,
        "coins": got_coins,
        "level": level,
        "leveled_up": level > old_level,
        "milestones": names,
        "capped": bool(used and used["xp"] >= DAILY_XP_CAP),
    }


def award(owner: str, key: str, xp: int, coins: int) -> dict:
    """The primitive: pays `key` once. Replays return zeros. It is uncapped and
    skips the day, streak and milestone rules: for tests and seeds only."""
    return _run_awards_plain(owner, key, xp, coins)


def _run_awards_plain(owner: str, key: str, xp: int, coins: int) -> dict:
    conn = connect()
    conn.execute("BEGIN IMMEDIATE")
    try:
        before = conn.execute("SELECT xp FROM progress WHERE owner=?", (owner,)).fetchone()
        old_level = level_for(before["xp"] if before else 0)
        _, gx, gc = _apply(conn, owner, key, xp, coins, _today(), False)
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


def award_take(
    owner: str,
    island_id: str,
    idx: int,
    score=None,
    speed: float = 1.0,
    whole_line: bool = True,
    line_idxs=(),
) -> dict:
    """The base take award plus the quality tiers (whole-line takes with at
    least QUALITY_MIN_WORDS scoreable words), the line_best record and the
    island mastery bonus, all in one transaction."""
    day = _today()
    entries = [(f"take:{island_id}:{idx}:{day}", TAKE_XP, TAKE_COINS)]
    ctx: dict = {}
    ratio = _ok_ratio(score) if whole_line else None
    if ratio is not None and ratio[1] >= QUALITY_MIN_WORDS:
        r = ratio[0]
        if r >= QUALITY_GOOD:
            entries.append((f"quality:{island_id}:{idx}:{day}:good", QUALITY_XP, QUALITY_COINS))
            ctx["full_speed"] = speed >= 1.0
        if r >= QUALITY_GREAT:
            entries.append((f"quality:{island_id}:{idx}:{day}:great", QUALITY_XP, QUALITY_COINS))
        ctx["perfect"] = r >= 1.0

    def prepare(conn: sqlite3.Connection) -> list[tuple[str, int, int]]:
        if ratio is None:
            return []
        conn.execute(
            "INSERT INTO line_best (owner, island_id, idx, best, updated_at) VALUES (?, ?, ?, ?, ?)"
            " ON CONFLICT(owner, island_id, idx) DO UPDATE SET"
            " best = MAX(best, excluded.best), updated_at = excluded.updated_at",
            (owner, island_id, idx, ratio[0], _now()),
        )
        idxs = list(line_idxs)
        if not idxs:
            return []
        best = {
            r["idx"]: r["best"]
            for r in conn.execute(
                "SELECT idx, best FROM line_best WHERE owner=? AND island_id=?", (owner, island_id)
            )
        }
        if all(best.get(i, 0.0) >= QUALITY_GREAT for i in idxs):
            return [(f"mastery:{island_id}", MASTERY_XP, MASTERY_COINS)]
        return []

    return _run_awards(owner, entries, day, take_cap=True, prepare=prepare if whole_line else None, ctx=ctx)


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
        for table in ("progress", "awards", "owned", "equipped", "day_xp", "line_best"):
            conn.execute(f"DELETE FROM {table} WHERE owner=?", (owner,))


# --- leaderboard ---

LEADERBOARD_MAX = 50


def leaderboard(owner: str, limit: int, handles) -> dict:
    """Top cats by xp then level. `handles` returns {owner: handle} for every
    named owner, so a user with a handle but no XP yet still appears (level 1,
    nothing equipped).

    Owners without a handle are hidden and take no rank. An entry carries only
    username, level and equipped; nothing that identifies the owner."""
    limit = max(1, min(int(limit), LEADERBOARD_MAX))
    conn = connect()
    names = handles()
    rows = conn.execute("SELECT owner, xp, updated_at FROM progress").fetchall()
    xp_by = {r["owner"]: r["xp"] for r in rows}
    upd_by = {r["owner"]: r["updated_at"] for r in rows}
    # Every named owner, left-joined to progress: no progress row means 0 XP
    # (level 1). xp desc, then the progress tiebreak (updated_at asc, owner asc).
    # A 0-XP user has no updated_at, so these level-1 users sort to the bottom.
    ranked = sorted(
        ((o, xp_by.get(o, 0)) for o in names),
        key=lambda t: (-t[1], upd_by.get(t[0], ""), t[0]),
    )
    top = ranked[:limit]
    slots: dict[str, dict] = {o: {slot: None for slot in SLOTS} for o, _ in top}
    if top:
        marks = ",".join("?" * len(top))
        for r in conn.execute(
            f"SELECT owner, slot, item_id FROM equipped WHERE owner IN ({marks})",
            [o for o, _ in top],
        ):
            if r["slot"] in slots[r["owner"]]:
                slots[r["owner"]][r["slot"]] = r["item_id"]
    entries = [
        {"username": names[o], "level": level_for(xp), "equipped": slots[o]}
        for o, xp in top
    ]
    own = conn.execute("SELECT xp FROM progress WHERE owner=?", (owner,)).fetchone()
    rank = next((i + 1 for i, (o, _) in enumerate(ranked) if o == owner), None)
    return {
        "entries": entries,
        "me": {
            "rank": rank,
            "level": level_for(own["xp"] if own else 0),
            "username": names.get(owner),
        },
    }
