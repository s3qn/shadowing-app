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

import dbconn
import progression_data
import spacing

log = logging.getLogger("shadow.progression")

DATA_DIR = Path(os.getenv("SHADOW_DATA_DIR", Path(__file__).parent / "data"))
DB_PATH = DATA_DIR / "progression.db"
# The constants live in progression_data.py. They are bound here by name so a
# patch of progression.<NAME> still changes what this module reads.
CATALOG_PATH = progression_data.CATALOG_PATH
MAX_LEVEL = progression_data.MAX_LEVEL
CATALOG_VERSION = progression_data.CATALOG_VERSION
LEVEL_UP_COINS = progression_data.LEVEL_UP_COINS
DAY_XP, DAY_COINS = progression_data.DAY_XP, progression_data.DAY_COINS
PRACTICED_XP, PRACTICED_COINS = progression_data.PRACTICED_XP, progression_data.PRACTICED_COINS
MINUTE_XP = progression_data.MINUTE_XP
MINUTE_XP_SLOW = progression_data.MINUTE_XP_SLOW
MINUTE_COINS = progression_data.MINUTE_COINS
DAILY_MINUTES_MAX = progression_data.DAILY_MINUTES_MAX
TAKE_XP, TAKE_COINS = progression_data.TAKE_XP, progression_data.TAKE_COINS
TAKES_PER_DAY = progression_data.TAKES_PER_DAY
REP_XP_BASE = progression_data.REP_XP_BASE
REP_XP_STEP = progression_data.REP_XP_STEP
REP_XP_MAX = progression_data.REP_XP_MAX
DAILY_XP_CAP = progression_data.DAILY_XP_CAP
SLOW_DIVISOR = progression_data.SLOW_DIVISOR
QUALITY_GOOD = progression_data.QUALITY_GOOD
QUALITY_GREAT = progression_data.QUALITY_GREAT
QUALITY_MIN_WORDS = progression_data.QUALITY_MIN_WORDS
QUALITY_XP, QUALITY_COINS = progression_data.QUALITY_XP, progression_data.QUALITY_COINS
MASTERY_XP, MASTERY_COINS = progression_data.MASTERY_XP, progression_data.MASTERY_COINS
KNOWN_XP, KNOWN_COINS = progression_data.KNOWN_XP, progression_data.KNOWN_COINS
STREAK_TIERS = progression_data.STREAK_TIERS
FREEZE_PRICE = progression_data.FREEZE_PRICE
FREEZE_CAP = progression_data.FREEZE_CAP
MILESTONES = progression_data.MILESTONES
HOURS_RUNGS = progression_data.HOURS_RUNGS
HOURS_ITEMS = progression_data.HOURS_ITEMS
STREAK_ITEMS = progression_data.STREAK_ITEMS
STREAK_RUNGS = progression_data.STREAK_RUNGS
SECRET_AWARDS = progression_data.SECRET_AWARDS
RARITY_MIN_USERS = progression_data.RARITY_MIN_USERS
ACHIEVEMENTS = progression_data.ACHIEVEMENTS
REVIEW_MIN_SENTENCES = progression_data.REVIEW_MIN_SENTENCES
REVIEW_SECONDS_PER_SENTENCE = progression_data.REVIEW_SECONDS_PER_SENTENCE
REVIEW_MAX_COUNTED = progression_data.REVIEW_MAX_COUNTED
REVIEW_XP_PER_SENTENCE = progression_data.REVIEW_XP_PER_SENTENCE
REVIEW_NEUTRAL_SCORE = progression_data.REVIEW_NEUTRAL_SCORE
REVIEW_REPEAT_FACTORS = progression_data.REVIEW_REPEAT_FACTORS
REVIEW_MAX_PAID_PER_DAY = progression_data.REVIEW_MAX_PAID_PER_DAY
REVIEW_FIRST_BONUS = progression_data.REVIEW_FIRST_BONUS
REVIEW_STREAK_BONUS_PER_DAY = progression_data.REVIEW_STREAK_BONUS_PER_DAY
REVIEW_STREAK_BONUS_DAYS = progression_data.REVIEW_STREAK_BONUS_DAYS

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
  slow INTEGER NOT NULL DEFAULT 0,
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
CREATE TABLE IF NOT EXISTS streak_freezes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  owner TEXT NOT NULL,
  purchase_id TEXT NOT NULL,
  bought_on TEXT NOT NULL,
  used_on TEXT,
  created_at TEXT NOT NULL,
  UNIQUE(owner, purchase_id),
  UNIQUE(owner, used_on)
);
"""


def _now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def _today() -> str:
    """The UTC day, the same day schedule.py and the build limit use."""
    return datetime.now(timezone.utc).date().isoformat()


_local = threading.local()


def connect() -> sqlite3.Connection:
    return dbconn.thread_conn(
        _local, DB_PATH, "journal_mode = WAL", "busy_timeout = 5000",
        setup=lambda conn: conn.executescript(SCHEMA), mkdir=True,
    )


def init() -> None:
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    with connect() as conn:
        conn.executescript(SCHEMA)
        # Databases from before the slow tail lack its per-day column.
        cols = {r["name"] for r in conn.execute("PRAGMA table_info(day_xp)")}
        if "slow" not in cols:
            conn.execute("ALTER TABLE day_xp ADD COLUMN slow INTEGER NOT NULL DEFAULT 0")


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


def rarity() -> dict[str, int | None]:
    """{hours item id: percent of users who own it}, every value None while
    fewer than RARITY_MIN_USERS users exist."""
    ids = [i["id"] for i in _CATALOG["items"] if "hours_req" in i]
    if not ids:
        return {}
    conn = connect()
    users = conn.execute("SELECT COUNT(DISTINCT owner) AS n FROM progress").fetchone()["n"]
    if users < RARITY_MIN_USERS:
        return {i: None for i in ids}
    marks = ",".join("?" * len(ids))
    counts = {
        r["item_id"]: r["n"]
        for r in conn.execute(
            f"SELECT item_id, COUNT(*) AS n FROM owned WHERE item_id IN ({marks}) GROUP BY item_id",
            ids,
        )
    }
    return {i: round(100 * counts.get(i, 0) / users) for i in ids}


# Requirement copy per unlock source: (short caption, sentence, profile group).
# The server owns every string, so a new source needs no client release.
# `grant` has no group: the profile never lists it.
_UNLOCK_COPY = {
    "en": {
        "level": ("Lv {n}", "Reach level {n}", "By level"),
        "hours": ("{n} h", "Listen for {n} hours", "By listening hours"),
        "hours_one": "Listen for 1 hour",
        "achievement": ("{name}", "Earn: {name}", "By achievement"),
        "grant": ("Beta", "Given to beta testers", ""),
    },
    "he": {
        "level": ("רמה {n}", "הגיעו לרמה {n}", "לפי רמה"),
        "hours": ("{n} ש׳", "האזינו {n} שעות", "לפי שעות האזנה"),
        "hours_one": "האזינו שעה אחת",
        "achievement": ("{name}", "השיגו: {name}", "לפי הישג"),
        "grant": ("בטא", "ניתן לבודקי בטא", ""),
    },
}
UNLOCK_SOURCES = ("level", "hours", "achievement", "grant")


def unlock_source(item: dict) -> tuple[str, int | str]:
    """(source, need) of a catalog item. One source per item, precedence
    grant_only > achievement_req > hours_req > level_req."""
    if item.get("grant_only"):
        return "grant", "beta"
    if "achievement_req" in item:
        return "achievement", item["achievement_req"]
    if "hours_req" in item:
        return "hours", item["hours_req"]
    return "level", item["level_req"]


def unlock_of(item: dict, ui: str = "en") -> dict:
    """How an item unlocks: the source, what it needs, and the caption,
    sentence and profile group the client shows verbatim."""
    lang = "he" if ui == "he" else "en"
    copy = _UNLOCK_COPY[lang]
    source, need = unlock_source(item)
    short, text, group = copy[source]
    if source == "achievement":
        name = ACHIEVEMENTS[need][lang]
        short, text = name, text.format(name=name)
    elif source == "hours" and need == 1:
        short, text = short.format(n=need), copy["hours_one"]
    else:
        short, text = short.format(n=need), text.format(n=need)
    return {"source": source, "need": need, "short": short, "text": text, "group": group}


def unlock_met(item: dict, level: int, hours: float, earned: set[str]) -> bool:
    """Whether the owner meets the item's one requirement. A grant item is
    never met here: it is owned or it is not."""
    source, need = unlock_source(item)
    if source == "grant":
        return False
    if source == "achievement":
        return need in earned
    if source == "hours":
        return hours >= need
    return level >= need


def catalog(ui: str = "en", with_rarity: bool = True) -> dict:
    suffix = "He" if ui == "he" else ""
    pct = rarity() if with_rarity else {}
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
                "unlock": unlock_of(item, ui),
                **({"grant_only": True} if item.get("grant_only") else {}),
                **(
                    {"hours_req": item["hours_req"], "owned_pct": pct.get(item["id"])}
                    if "hours_req" in item else {}
                ),
            }
        )
    return {
        "version": CATALOG_VERSION,
        "slots": SLOTS,
        "shapes": _CATALOG["shapes"],
        "items": items,
    }


# --- reading ---


def _earned(conn: sqlite3.Connection, owner: str) -> list[str]:
    """Achievement ids in the owner's ledger, sorted."""
    return sorted(
        r["key"][3:]
        for r in conn.execute("SELECT key FROM awards WHERE owner=? AND key LIKE 'ms:%'", (owner,))
    )


def _read(conn: sqlite3.Connection, owner: str) -> dict:
    """The snapshot. May write (settles freezes, heals streak items) without
    committing: snapshot() commits, a caller inside a transaction does."""
    today = _today()
    _settle_freezes(conn, owner, today)
    earned = _earned(conn, owner)
    _heal_streak_items(conn, owner, earned, [
        r["item_id"] for r in conn.execute("SELECT item_id FROM owned WHERE owner=?", (owner,))
    ])
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
    used = conn.execute(
        "SELECT xp, slow FROM day_xp WHERE owner=? AND day=?", (owner, today)
    ).fetchone()
    days = _day_keys(conn, owner)
    frozen = _frozen_days(conn, owner)
    end = date.fromisoformat(today)
    if today not in days:
        end -= timedelta(days=1)
    streak = _run_back(days, frozen, end)
    review_days = _review_days(conn, owner)
    rend = date.fromisoformat(today)
    if today not in review_days:
        rend -= timedelta(days=1)
    review_streak = 0
    while rend.isoformat() in review_days:
        review_streak += 1
        rend -= timedelta(days=1)
    return {
        "xp": xp,
        "xp_today": used["xp"] if used else 0,
        "xp_today_slow": used["slow"] if used else 0,
        "xp_today_cap": DAILY_XP_CAP,
        "streak_days": streak,
        "review_streak_days": review_streak,
        "level": level,
        "coins": coins,
        "xp_into_level": into,
        "xp_to_next": to_next,
        "owned": owned,
        "equipped": equipped,
        "earned": earned,
        "catalog_version": CATALOG_VERSION,
        "freezes_held": _held(conn, owner),
        "freeze_price": FREEZE_PRICE,
        "freeze_cap": FREEZE_CAP,
        "frozen_days": sorted(frozen),
        # When each held freeze was bought and the day this answer settled:
        # the client covers a missed yesterday offline only with a freeze
        # bought on or before it, and only until a snapshot settled it.
        "freezes_bought": [
            r["bought_on"]
            for r in conn.execute(
                "SELECT bought_on FROM streak_freezes WHERE owner=? AND used_on IS NULL ORDER BY bought_on, id",
                (owner,),
            )
        ],
        "server_day": today,
        "longest_streak": _longest(days, frozen),
        # Highest streak rung ever paid (the ms:streak_N ledger row), 0 when
        # none. A rung re-reached after a break pays nothing twice.
        "streak_rung_best": max(
            (rung for rung in STREAK_RUNGS if f"streak_{rung}" in earned), default=0
        ),
    }


BETA_HAT = "head.beta_tester_hat"


def _grant_beta(conn: sqlite3.Connection, owner: str) -> None:
    """While SHADOW_BETA_GRANT=1, every account owns the beta hat. The row is
    permanent: turning the flag off stops new grants, it never revokes."""
    if os.environ.get("SHADOW_BETA_GRANT") != "1" or BETA_HAT not in _ITEMS:
        return
    conn.execute(
        "INSERT OR IGNORE INTO owned (owner, item_id, bought_at) VALUES (?, ?, ?)",
        (owner, BETA_HAT, _now()),
    )
    conn.commit()


STARTER_ITEM = "face.blush_pink"


def grant_starter(owner: str) -> dict:
    """The first-win gift. Owned for good; equipped only on the first grant,
    so a replay never overrides what the user wears since. A level 1 owner
    is also topped up to level 2 once (key `first_run`), so the finish screen
    always reads 1 to 2; replays pay 0."""
    item = _ITEMS[STARTER_ITEM]
    snap = snapshot(owner)
    if snap["level"] == 1:
        award(owner, "first_run", max(0, xp_to_next(1) - snap["xp"]), 0)
    conn = connect()
    with conn:
        cur = conn.execute(
            "INSERT OR IGNORE INTO owned (owner, item_id, bought_at) VALUES (?, ?, ?)",
            (owner, STARTER_ITEM, _now()),
        )
        if cur.rowcount == 1:
            conn.execute(
                "INSERT INTO equipped (owner, slot, item_id) VALUES (?, ?, ?)"
                " ON CONFLICT(owner, slot) DO UPDATE SET item_id = excluded.item_id",
                (owner, item["slot"], STARTER_ITEM),
            )
    return snapshot(owner)


def snapshot(owner: str) -> dict:
    conn = connect()
    _grant_beta(conn, owner)
    try:
        snap = _read(conn, owner)
        conn.commit()
    except BaseException:
        conn.rollback()
        raise
    return snap


def stats(owner: str) -> dict:
    """Public counters for the profile screen, all derived from the ledger."""
    conn = connect()
    days = _day_keys(conn, owner)
    longest = _longest(days, _frozen_days(conn, owner))
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
    milestones = _earned(conn, owner)
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
    defer_if_capped: bool = False, slow_xp: int | None = None,
) -> tuple[bool, int, int]:
    """Pays one ledger key inside the caller's open transaction. Returns
    (paid, xp granted, coins granted), level-up coins included. `paid` is False
    for a replayed key, which changes nothing. When `capped` the XP pays in the
    day's bands: the part that fits in what is left of DAILY_XP_CAP for `day`
    (fast), and the rest at 1 / SLOW_DIVISOR (slow), or `slow_xp` flat when the
    fast band is already full. The row keeps the XP actually granted, so
    progress.xp always equals the sum of the owner's ledger.

    Coins pay only with fast XP, so coins stop at the fast band. With
    `defer_if_capped`, a grant with no fast room is not recorded at all
    (returns False) and pays no slow XP, so a non-repeatable source such as
    island mastery pays on a later day with room instead of being lost."""
    fast, slow = xp, 0
    coins_granted = coins
    if capped and xp > 0:
        row = conn.execute(
            "SELECT xp FROM day_xp WHERE owner=? AND day=?", (owner, day)
        ).fetchone()
        used = row["xp"] if row else 0
        fast = max(0, min(xp, DAILY_XP_CAP - used))
        if fast == 0:
            coins_granted = 0
            if defer_if_capped:
                return False, 0, 0
            slow = slow_xp if slow_xp is not None else xp // SLOW_DIVISOR
        elif not defer_if_capped:
            slow = (xp - fast) // SLOW_DIVISOR
    granted = fast + slow
    cur = conn.execute(
        "INSERT OR IGNORE INTO awards (owner, key, xp, coins, created_at) VALUES (?, ?, ?, ?, ?)",
        (owner, key, granted, coins_granted, _now()),
    )
    if cur.rowcount != 1:
        return False, 0, 0
    if capped and xp > 0:
        conn.execute(
            "INSERT INTO day_xp (owner, day, xp, slow) VALUES (?, ?, ?, ?)"
            " ON CONFLICT(owner, day) DO UPDATE SET"
            " xp = xp + excluded.xp, slow = slow + excluded.slow",
            (owner, day, fast, slow),
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


def _review_days(conn: sqlite3.Connection, owner: str) -> set[str]:
    return {
        r["key"][10:]
        for r in conn.execute(
            "SELECT key FROM awards WHERE owner=? AND key LIKE 'reviewday:%'", (owner,)
        )
    }


def _review_streak(conn: sqlite3.Connection, owner: str, end_day: str) -> int:
    """Consecutive `reviewday:` keys ending at `end_day`."""
    days = _review_days(conn, owner)
    cur = date.fromisoformat(end_day)
    n = 0
    while cur.isoformat() in days:
        n += 1
        cur -= timedelta(days=1)
    return n


def _run_back(days: set[str], frozen: set[str], end: date) -> int:
    """The run ending at `end`: real days count, frozen days bridge."""
    n = 0
    while (d := end.isoformat()) in days or d in frozen:
        n += d in days
        end -= timedelta(days=1)
    return n


def _longest(days: set[str], frozen: set[str]) -> int:
    """The longest run over real and frozen days; only real days count."""
    longest = run = 0
    prev = None
    for d in sorted(days | frozen):
        cur = date.fromisoformat(d)
        if prev is None or cur - prev != timedelta(days=1):
            run = 0
        run += d in days
        longest = max(longest, run)
        prev = cur
    return longest


def _streak_days(conn: sqlite3.Connection, owner: str, end_day: str) -> int:
    """The run of paid `day:` keys ending at `end_day`, frozen days bridging."""
    return _run_back(_day_keys(conn, owner), _frozen_days(conn, owner), date.fromisoformat(end_day))


# --- streak freeze ---


def _frozen_days(conn: sqlite3.Connection, owner: str) -> set[str]:
    return {
        r["used_on"]
        for r in conn.execute(
            "SELECT used_on FROM streak_freezes WHERE owner=? AND used_on IS NOT NULL", (owner,)
        )
    }


def _held(conn: sqlite3.Connection, owner: str) -> int:
    return conn.execute(
        "SELECT COUNT(*) AS n FROM streak_freezes WHERE owner=? AND used_on IS NULL", (owner,)
    ).fetchone()["n"]


def _plan_freezes(conn: sqlite3.Connection, owner: str, today: str) -> list[tuple[int, str]]:
    """(freeze id, day) pairs that bridge the gap ending yesterday, or [] when
    nothing should be used: yesterday counts already, the gap is longer than
    FREEZE_CAP, no run sits before it, or some day has no freeze bought on or
    before it (all or nothing: never burn a freeze on a streak that breaks)."""
    q = _day_keys(conn, owner) | _frozen_days(conn, owner)
    cur = date.fromisoformat(today) - timedelta(days=1)
    gap: list[str] = []
    while cur.isoformat() not in q and len(gap) < FREEZE_CAP:
        gap.append(cur.isoformat())
        cur -= timedelta(days=1)
    if not gap or cur.isoformat() not in q:
        return []
    held = [
        (r["id"], r["bought_on"])
        for r in conn.execute(
            "SELECT id, bought_on FROM streak_freezes WHERE owner=? AND used_on IS NULL"
            " ORDER BY bought_on, id",
            (owner,),
        )
    ]
    plan = []
    for day in reversed(gap):
        pick = next((f for f in held if f[1] <= day), None)
        if pick is None:
            return []
        held.remove(pick)
        plan.append((pick[0], day))
    return plan


def _settle_freezes(conn: sqlite3.Connection, owner: str, today: str) -> None:
    """Uses held freezes on the missed days before `today` (never today
    itself). Takes the write lock only when there is work; the caller commits."""
    if not _plan_freezes(conn, owner, today):
        return
    if not conn.in_transaction:
        conn.execute("BEGIN IMMEDIATE")
    for fid, day in _plan_freezes(conn, owner, today):
        conn.execute("UPDATE streak_freezes SET used_on=? WHERE id=?", (day, fid))


def _heal_streak_items(conn: sqlite3.Connection, owner: str, earned: list[str], owned: list[str]) -> None:
    """Owns the item of every streak milestone already earned (milestones paid
    before the items existed). The caller commits."""
    for rung, item_id in STREAK_ITEMS.items():
        if f"streak_{rung}" in earned and item_id in _ITEMS and item_id not in owned:
            _grant_item(conn, owner, item_id)


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


def rep_xp(score) -> int:
    """XP for a repeat take: REP_XP_BASE, plus 1 per REP_XP_STEP points of the
    score's total (0-100), at most REP_XP_MAX. No usable total pays the base."""
    total = score.get("total") if isinstance(score, dict) else None
    if isinstance(total, bool) or not isinstance(total, (int, float)) or total != total:
        return REP_XP_BASE
    return min(REP_XP_MAX, REP_XP_BASE + int(max(0.0, min(100.0, float(total))) // REP_XP_STEP))


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
    ):
        if hit:
            pay(name)
    for rung in STREAK_RUNGS:
        if streak < rung:
            break
        pay(f"streak_{rung}")
        _grant_item(conn, owner, STREAK_ITEMS.get(rung))
    hours = ctx.get("hours") or 0
    for rung in HOURS_RUNGS:
        if hours < rung:
            break
        pay(f"hours_{rung}")
        _grant_item(conn, owner, HOURS_ITEMS.get(rung))
    for name in SECRET_AWARDS:
        if ctx.get(name):
            pay(name)
    for level, name in ((5, "level_5"), (10, "level_10"), (20, "level_20")):
        row = conn.execute("SELECT xp FROM progress WHERE owner=?", (owner,)).fetchone()
        if level_for(row["xp"] if row else 0) >= level:
            pay(name)
    return got_xp, got_coins, names


def _grant_item(conn: sqlite3.Connection, owner: str, item_id: str | None) -> None:
    """Owns a milestone's item for good (never equipped), like the beta hat."""
    if item_id in _ITEMS:
        conn.execute(
            "INSERT OR IGNORE INTO owned (owner, item_id, bought_at) VALUES (?, ?, ?)",
            (owner, item_id, _now()),
        )


def grant_hours(owner: str, total_seconds: float) -> None:
    """Heals the hours rungs on read from `total_seconds` (the counted
    lifetime, schedule.counted_seconds, never the uncapped sum): pays every reached rung not yet in the
    ledger and owns its item, so hours from before the ladder count. Writes
    nothing when the owner already has every reached rung and item."""
    hours = max(0.0, float(total_seconds)) / 3600
    reached = [r for r in HOURS_RUNGS if hours >= r]
    if not reached:
        return
    conn = connect()
    paid = {
        r["key"]
        for r in conn.execute("SELECT key FROM awards WHERE owner=? AND key LIKE 'ms:hours_%'", (owner,))
    }
    owned = {r["item_id"] for r in conn.execute("SELECT item_id FROM owned WHERE owner=?", (owner,))}
    if all(
        f"ms:hours_{r}" in paid and (HOURS_ITEMS[r] in owned or HOURS_ITEMS[r] not in _ITEMS)
        for r in reached
    ):
        return
    _run_awards(owner, [], _today(), ctx={"hours": hours})


def earned_milestones(owner: str) -> set[str]:
    return set(_earned(connect(), owner))


def achievements(owner: str, ui: str = "en") -> list[dict]:
    """Every achievement in MILESTONES order with its earn time. A secret one
    not yet earned has no name."""
    lang = "he" if ui == "he" else "en"
    earned = {
        r["key"][3:]: r["created_at"]
        for r in connect().execute(
            "SELECT key, created_at FROM awards WHERE owner=? AND key LIKE 'ms:%'", (owner,)
        )
    }
    out = []
    for name in MILESTONES:
        meta = ACHIEVEMENTS[name]
        at = earned.get(name)
        out.append({
            "id": name,
            "secret": meta["secret"],
            "name": None if meta["secret"] and at is None else meta[lang],
            "earned_at": at,
        })
    return out


def hours_next(total_seconds: float) -> dict | None:
    """The next hours rung above `total_seconds` (the counted lifetime, each
    day capped), or None past the last."""
    for rung in HOURS_RUNGS:
        if total_seconds < rung * 3600:
            return {
                "hours": rung,
                "item_id": HOURS_ITEMS[rung],
                "seconds_left": rung * 3600 - total_seconds,
            }
    return None


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
        used_before = conn.execute(
            "SELECT xp FROM day_xp WHERE owner=? AND day=?", (owner, day)
        ).fetchone()
        full_before = bool(used_before and used_before["xp"] >= DAILY_XP_CAP)
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
            slow_xp = MINUTE_XP_SLOW if key.startswith("minute:") else None
            paid, gx, gc = _apply(
                conn, owner, key, xp, coins, day, True, defer_if_capped=is_mastery, slow_xp=slow_xp
            )
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
                _settle_freezes(conn, owner, day)
                streak = _streak_days(conn, owner, day)
                ctx["streak"] = streak
                for min_days, sxp, scoins in STREAK_TIERS:
                    if streak >= min_days:
                        _, gx, gc = _apply(conn, owner, f"streak:{day}", sxp, scoins, day, True)
                        got_xp += gx
                        got_coins += gc
                        break
        note_cap = ctx.pop("note_cap", False)
        mx, mc, names = _milestones(conn, owner, day, ctx)
        got_xp += mx
        got_coins += mc
        after = conn.execute("SELECT xp FROM progress WHERE owner=?", (owner,)).fetchone()
        level = level_for(after["xp"] if after else 0)
        used = conn.execute(
            "SELECT xp FROM day_xp WHERE owner=? AND day=?", (owner, day)
        ).fetchone()
        capped = bool(used and used["xp"] >= DAILY_XP_CAP)
        # The first take after the fast band filled says so, once a day (its
        # slow XP may be above 0): the zero-XP capnote key records the note.
        cap_note = False
        if note_cap and full_before:
            cap_note = _apply(conn, owner, f"capnote:{day}", 0, 0, day, False)[0]
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
        "capped": capped,
        "cap_note": cap_note,
    }


def award(owner: str, key: str, xp: int, coins: int) -> dict:
    """The primitive: pays `key` once. Replays return zeros. It is uncapped and
    skips the day, streak and milestone rules: for tests and seeds only."""
    return _run_awards_plain(owner, key, xp, coins)


def award_known(owner: str, island_id: str, idx: int) -> dict:
    """Pays the "Easy for me" mark on a line once. Replays return zeros.
    Outside the daily cap; to count it inside the cap instead, return
    `_run_awards(owner, [(key, KNOWN_XP, KNOWN_COINS)], _today())`."""
    key = f"known:{island_id}:{idx}"
    return _run_awards_plain(owner, key, KNOWN_XP, KNOWN_COINS)


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


def award_practice(
    owner: str,
    island_id: str,
    seconds_today: float,
    owner_seconds_today: float | None = None,
    total_seconds: float | None = None,
    secrets: dict | None = None,
) -> dict:
    """Awards for playback today: the practiced bonus once this island's
    seconds_today reaches the spacing threshold, and one `minute:{day}:{m}` key
    per counted minute across every island (owner_seconds_today; this island's
    seconds when not given), at most DAILY_MINUTES_MAX. The day bonus rides
    along with the first paid key of the day. `total_seconds` (lifetime, each
    day capped at the daily max) pays the hours rungs and `secrets` the secret awards whose flag is true."""
    day = _today()
    entries: list[tuple[str, int, int]] = []
    if seconds_today >= spacing.PRACTICED_MIN_SECONDS:
        entries.append((f"practiced:{island_id}:{day}", PRACTICED_XP, PRACTICED_COINS))
    counted = seconds_today if owner_seconds_today is None else owner_seconds_today
    minutes = min(DAILY_MINUTES_MAX, int(max(0.0, counted) // 60))
    ctx: dict = dict(secrets or {})
    if total_seconds is not None:
        ctx["hours"] = total_seconds / 3600
    if minutes:
        ctx["note_cap"] = True

    def prepare(conn: sqlite3.Connection) -> list[tuple[str, int, int]]:
        # Minute keys are paid in order, so only the ones past the count are new.
        paid = conn.execute(
            "SELECT COUNT(*) AS n FROM awards WHERE owner=? AND key LIKE ?",
            (owner, f"minute:{day}:%"),
        ).fetchone()["n"]
        return [(f"minute:{day}:{m}", MINUTE_XP, MINUTE_COINS) for m in range(paid + 1, minutes + 1)]

    if not entries and not minutes and not _has_milestone_work(ctx):
        return {"xp": 0, "coins": 0, "level": level_for(snapshot(owner)["xp"]), "leveled_up": False}
    return _run_awards(owner, entries, day, prepare=prepare, ctx=ctx)


def _has_milestone_work(ctx: dict) -> bool:
    return (ctx.get("hours") or 0) >= HOURS_RUNGS[0] or any(ctx.get(n) for n in SECRET_AWARDS)


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
    island mastery bonus, all in one transaction. A line whose base award is
    already paid today pays the small repeat award (rep_xp) instead."""
    day = _today()
    take_key = f"take:{island_id}:{idx}:{day}"
    entries = [(take_key, TAKE_XP, TAKE_COINS)]
    ctx: dict = {"note_cap": True}
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
        out: list[tuple[str, int, int]] = []
        if conn.execute("SELECT 1 FROM awards WHERE owner=? AND key=?", (owner, take_key)).fetchone():
            n = conn.execute(
                "SELECT COUNT(*) AS n FROM awards WHERE owner=? AND key LIKE ?",
                (owner, f"rep:{island_id}:{idx}:{day}:%"),
            ).fetchone()["n"]
            out.append((f"rep:{island_id}:{idx}:{day}:{n}", rep_xp(score), 0))
        if ratio is None or not whole_line:
            return out
        conn.execute(
            "INSERT INTO line_best (owner, island_id, idx, best, updated_at) VALUES (?, ?, ?, ?, ?)"
            " ON CONFLICT(owner, island_id, idx) DO UPDATE SET"
            " best = MAX(best, excluded.best), updated_at = excluded.updated_at",
            (owner, island_id, idx, ratio[0], _now()),
        )
        idxs = list(line_idxs)
        if not idxs:
            return out
        best = {
            r["idx"]: r["best"]
            for r in conn.execute(
                "SELECT idx, best FROM line_best WHERE owner=? AND island_id=?", (owner, island_id)
            )
        }
        if all(best.get(i, 0.0) >= QUALITY_GREAT for i in idxs):
            out.append((f"mastery:{island_id}", MASTERY_XP, MASTERY_COINS))
        return out

    return _run_awards(owner, entries, day, take_cap=True, prepare=prepare, ctx=ctx)


def _check_local_day(local_day: str) -> str:
    """The client's calendar date, accepted only within UTC date +-1 day."""
    try:
        d = date.fromisoformat(str(local_day))
    except ValueError:
        raise _err(422, code="bad_local_day")
    if abs((d - date.fromisoformat(_today())).days) > 1:
        raise _err(422, code="bad_local_day")
    return d.isoformat()


def award_review(
    owner: str, session_id: str, sentences: int, seconds: float, avg_score, local_day: str
) -> dict:
    """XP for finishing a daily review. Outside the daily cap. Pays 0 (and
    writes nothing) for a short or too-fast run, a replayed session_id, or the
    11th session of a day."""
    day = _check_local_day(local_day)
    conn = connect()
    conn.execute("BEGIN IMMEDIATE")
    try:
        before = conn.execute("SELECT xp FROM progress WHERE owner=?", (owner,)).fetchone()
        old_level = level_for(before["xp"] if before else 0)
        gx = gc = 0
        first = False
        parts = {"sentences": 0, "score": 0, "first": 0, "streak": 0}
        key = f"review:{day}:{session_id}"
        n = min(int(sentences), int(max(0, seconds) // REVIEW_SECONDS_PER_SENTENCE), REVIEW_MAX_COUNTED)
        replay = conn.execute(
            "SELECT 1 FROM awards WHERE owner=? AND key=?", (owner, key)
        ).fetchone()
        k = conn.execute(
            "SELECT COUNT(*) AS n FROM awards WHERE owner=? AND key LIKE ?",
            (owner, f"review:{day}:%"),
        ).fetchone()["n"]
        if not replay and int(sentences) >= REVIEW_MIN_SENTENCES and n >= REVIEW_MIN_SENTENCES \
                and k < REVIEW_MAX_PAID_PER_DAY:
            try:
                score = float(avg_score)
                if score != score:
                    score = REVIEW_NEUTRAL_SCORE
            except (TypeError, ValueError):
                score = REVIEW_NEUTRAL_SCORE
            score = max(0.0, min(100.0, score))
            f = REVIEW_REPEAT_FACTORS[min(k, len(REVIEW_REPEAT_FACTORS) - 1)]
            xp = max(1, round(REVIEW_XP_PER_SENTENCE * n * (0.5 + score / 100) * f))
            # The summary's rows: the flat per-sentence part, then what the score added.
            parts["sentences"] = min(xp, round(REVIEW_XP_PER_SENTENCE * n * f))
            parts["score"] = xp - parts["sentences"]
            first = k == 0
            if first:
                _apply(conn, owner, f"reviewday:{day}", 0, 0, day, False)
                streak = _review_streak(conn, owner, day)
                parts["first"] = REVIEW_FIRST_BONUS
                parts["streak"] = REVIEW_STREAK_BONUS_PER_DAY * min(streak, REVIEW_STREAK_BONUS_DAYS)
                xp += parts["first"] + parts["streak"]
            _, gx, gc = _apply(conn, owner, key, xp, xp // 10, day, False)
        after = conn.execute("SELECT xp FROM progress WHERE owner=?", (owner,)).fetchone()
        level = level_for(after["xp"] if after else 0)
        progress = _read(conn, owner)
        prev = (date.fromisoformat(day) - timedelta(days=1)).isoformat()
        streak = _review_streak(conn, owner, day) or _review_streak(conn, owner, prev)
        conn.commit()
    except BaseException:
        conn.rollback()
        raise
    return {
        "xp": gx,
        "coins": gc,
        "level": level,
        "leveled_up": level > old_level,
        "streak": streak,
        "first_of_day": first and gx > 0,
        "breakdown": parts if gx > 0 else {"sentences": 0, "score": 0, "first": 0, "streak": 0},
        "progress": progress,
    }


# Shop functions (buy, buy_freeze, grant_coins, equip, delete_owner) live in
# progression_shop.py.


def _err(status: int, **body) -> HTTPException:
    return HTTPException(status, body)


def _streaks_for(conn: sqlite3.Connection, owners: list[str]) -> dict[str, int]:
    """Current `day:` streak per owner in one query. Counts back from today,
    or from yesterday when today is not paid yet (same rule as the snapshot)."""
    out = {o: 0 for o in owners}
    if not owners:
        return out
    marks = ",".join("?" * len(owners))
    days: dict[str, set[str]] = {o: set() for o in owners}
    for r in conn.execute(
        f"SELECT owner, key FROM awards WHERE key LIKE 'day:%' AND owner IN ({marks})", owners
    ):
        days[r["owner"]].add(r["key"][4:])
    today = _today()
    for o in owners:
        end = date.fromisoformat(today)
        if today not in days[o]:
            end -= timedelta(days=1)
        n = 0
        while end.isoformat() in days[o]:
            n += 1
            end -= timedelta(days=1)
        out[o] = n
    return out
