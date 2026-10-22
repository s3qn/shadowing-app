"""Tests for the cat leaderboard: ranking, the privacy whitelist, the cap,
hidden owners and the caller's own rank. Handles come from a dict-backed fake."""

import asyncio
import json
import uuid

import pytest
from fastapi import HTTPException

import main
import progression
import store

AUTH = f"Bearer {main.SHADOW_TOKEN}"


@pytest.fixture(autouse=True)
def _init_db():
    store.init()
    progression.init()


def _owner():
    return f"user_{uuid.uuid4().hex}"


def _seed(xp):
    o = _owner()
    progression.award(o, f"seed:{uuid.uuid4().hex}", xp, 0)
    return o


def _call(monkeypatch, names, owner, limit=50):
    monkeypatch.setattr(main, "_all_handles", lambda: dict(names))
    return asyncio.run(main.leaderboard(limit=limit, authorization=AUTH, x_shadow_device=owner))


def _named(xps, prefix="cat"):
    owners = [_seed(x) for x in xps]
    return owners, {o: f"{prefix}_{i}_{uuid.uuid4().hex[:6]}" for i, o in enumerate(owners)}


def test_ranking_order(monkeypatch):
    owners, names = _named([59, 1000, 60, 500])
    res = _call(monkeypatch, names, owners[0])
    got = [e["username"] for e in res["entries"]]
    want = [names[owners[i]] for i in (1, 3, 2, 0)]
    assert got == want
    levels = [e["level"] for e in res["entries"]]
    assert levels == sorted(levels, reverse=True)


def test_whitelist(monkeypatch):
    owners, names = _named([1000, 500, 60])
    res = _call(monkeypatch, names, owners[0])
    for e in res["entries"]:
        assert set(e) == {"username", "level", "equipped", "streak_days"}
        assert set(e["equipped"]) == set(progression.SLOTS)
    assert set(res["me"]) == {"rank", "level", "username"}
    blob = json.dumps(res)
    for bad in (*owners, "xp", "coins", "email", "@"):
        assert bad not in blob


def test_cap(monkeypatch):
    owners, names = _named([i for i in range(55)])
    assert len(_call(monkeypatch, names, owners[0])["entries"]) == 50
    assert len(_call(monkeypatch, names, owners[0], limit=200)["entries"]) == 50
    assert len(_call(monkeypatch, names, owners[0], limit=5)["entries"]) == 5


def test_unnamed_hidden(monkeypatch):
    owners, names = _named([1000, 500, 60])
    del names[owners[1]]
    res = _call(monkeypatch, names, owners[2])
    assert [e["username"] for e in res["entries"]] == [names[owners[0]], names[owners[2]]]
    assert res["me"]["rank"] == 2


def test_me(monkeypatch):
    owners, names = _named([1000, 500, 60])
    res = _call(monkeypatch, names, owners[1])
    assert res["me"]["rank"] == 2 and res["me"]["username"] == names[owners[1]]
    res = _call(monkeypatch, names, owners[2], limit=2)
    assert len(res["entries"]) == 2
    assert res["me"]["rank"] == 3
    fresh = _owner()
    res = _call(monkeypatch, names, fresh)
    assert res["me"] == {"rank": None, "level": 1, "username": None}


def test_equipped_shown(monkeypatch):
    owners, names = _named([1000])
    item = progression.catalog()["items"][0]
    with progression.connect() as conn:
        conn.execute(
            "INSERT INTO equipped (owner, slot, item_id) VALUES (?, ?, ?)",
            (owners[0], progression.SLOTS[0], item["id"]),
        )
    res = _call(monkeypatch, names, owners[0])
    assert res["entries"][0]["equipped"][progression.SLOTS[0]] == item["id"]


def test_empty_when_no_handles(monkeypatch):
    o = _seed(100)
    res = _call(monkeypatch, {}, o)
    assert res["entries"] == []
    assert res["me"]["rank"] is None


def test_named_without_progress(monkeypatch):
    # A user who set a @handle but never earned XP has no progress row.
    owners, names = _named([1000, 500])
    fresh = _owner()
    names[fresh] = f"newbie_{uuid.uuid4().hex[:6]}"
    res = _call(monkeypatch, names, fresh)
    assert [e["username"] for e in res["entries"]] == [
        names[owners[0]],
        names[owners[1]],
        names[fresh],
    ]
    last = res["entries"][-1]
    assert last["username"] == names[fresh]
    assert last["level"] == 1
    assert last["equipped"] == {slot: None for slot in progression.SLOTS}
    # The 0-XP user still gets a real rank, below everyone with XP.
    assert res["me"] == {"rank": 3, "level": 1, "username": names[fresh]}
    # The privacy whitelist still holds: no owner id or xp leaks.
    for e in res["entries"]:
        assert set(e) == {"username", "level", "equipped", "streak_days"}
    blob = json.dumps(res)
    for bad in (*owners, fresh, "xp", "coins", "email"):
        assert bad not in blob


def test_requires_device(monkeypatch):
    with pytest.raises(HTTPException) as exc:
        asyncio.run(main.leaderboard(limit=5, authorization=AUTH, x_shadow_device=""))
    assert exc.value.status_code in (400, 401)


# --- weekly league ---

import schedule  # noqa: E402
import stats  # noqa: E402
from datetime import datetime, timezone  # noqa: E402

MONDAY = datetime(2030, 1, 7, tzinfo=timezone.utc)  # a Monday


# Every owner the weekly tests wrote 2030 rows for. The fixture deletes those
# rows after each test, so they never leak into a real-clock weekly read.
_WEEKLY_OWNERS: set[str] = set()


@pytest.fixture
def week(monkeypatch):
    schedule.init()
    assert MONDAY.weekday() == 0
    monkeypatch.setattr(stats, "_now", lambda: MONDAY.replace(day=9, hour=12))
    lang = f"t{uuid.uuid4().hex[:8]}"
    yield lang
    owners = list(_WEEKLY_OWNERS)
    _WEEKLY_OWNERS.clear()
    if not owners:
        return
    marks = ",".join("?" * len(owners))
    with schedule.connect() as conn:
        conn.execute(f"DELETE FROM practice_events WHERE device IN ({marks})", owners)
    with store.connect() as conn:
        conn.execute(f"DELETE FROM islands WHERE device IN ({marks})", owners)
    with progression.connect() as conn:
        conn.execute(f"DELETE FROM awards WHERE owner IN ({marks}) AND key LIKE 'take:%'", owners)


def _listen(owner, lang, day, seconds, hour=12):
    _WEEKLY_OWNERS.add(owner)
    with schedule.connect() as conn:
        conn.execute(
            "INSERT INTO practice_events (island_id, seconds, created_at, device, language)"
            " VALUES ('x', ?, ?, ?, ?)",
            (seconds, f"{day}T{hour:02d}:00:00+00:00", owner, lang),
        )


def _lines(owner, lang, n, day="2030-01-08"):
    _WEEKLY_OWNERS.add(owner)
    isl = uuid.uuid4().hex
    with store.connect() as conn:
        conn.execute(
            "INSERT INTO islands (id, status, created_at, device, language)"
            " VALUES (?, 'ready', '2026-01-01T00:00:00+00:00', ?, ?)",
            (isl, owner, lang),
        )
    with progression.connect() as conn:
        for i in range(n):
            conn.execute(
                "INSERT INTO awards (owner, key, xp, coins, created_at) VALUES (?, ?, 15, 2, ?)",
                (owner, f"take:{isl}:{i}:{day}", f"{day}T10:00:00+00:00"),
            )


def _weekly(names, owner, lang):
    return stats.weekly_league(owner, lang, 50, lambda: dict(names))


def test_weekly_ranks_by_minutes_plus_lines(week):
    a, b, c = _owner(), _owner(), _owner()
    _listen(a, week, "2030-01-08", 600)  # 10 minutes
    _lines(b, week, 12)  # 12 lines
    _listen(c, week, "2030-01-08", 300)
    _lines(c, week, 2)  # 5 + 2
    out = _weekly({a: "ann", b: "bob", c: "cy"}, c, week)
    assert out["week_start"] == "2030-01-07" and out["language"] == week
    assert [e["username"] for e in out["entries"]] == ["bob", "ann", "cy"]
    assert [e["score"] for e in out["entries"]] == [12, 10, 7]
    for e in out["entries"]:
        assert set(e) == {"username", "level", "equipped", "streak_days", "minutes", "lines", "score"}
    me = out["me"]
    assert (me["rank"], me["minutes"], me["lines"], me["score"], me["top_pct"]) == (3, 5, 2, 7, 100)
    assert _weekly({a: "ann", b: "bob", c: "cy"}, b, week)["me"]["top_pct"] == 34


def test_weekly_filters_by_language(week):
    a = _owner()
    _listen(a, f"other-{week}", "2030-01-08", 600)
    _lines(a, f"other-{week}", 3)
    out = _weekly({a: "ann"}, a, week)
    assert out["entries"] == []
    assert out["me"]["rank"] is None and out["me"]["top_pct"] is None and out["me"]["score"] == 0


def test_weekly_starts_on_monday_utc(week):
    a = _owner()
    _listen(a, week, "2030-01-06", 6000, hour=23)  # Sunday, last week
    _lines(a, week, 4, day="2030-01-06")
    _listen(a, week, "2030-01-07", 120, hour=0)  # Monday 00:00
    out = _weekly({a: "ann"}, a, week)
    assert out["entries"][0]["minutes"] == 2 and out["entries"][0]["lines"] == 0


def test_weekly_applies_the_daily_max(week):
    a = _owner()
    _listen(a, week, "2030-01-07", 3600 * 4)  # 4 h counts as 3 h
    _listen(a, week, "2030-01-08", 90)
    assert _weekly({a: "ann"}, a, week)["entries"][0]["minutes"] == 180 + 1


def test_weekly_hides_zero_scores_and_unnamed_owners(week):
    a, b, hidden = _owner(), _owner(), _owner()
    _listen(a, week, "2030-01-08", 120)
    _listen(hidden, week, "2030-01-08", 6000)
    out = _weekly({a: "ann", b: "bob"}, b, week)
    assert [e["username"] for e in out["entries"]] == ["ann"]
    assert out["me"]["rank"] is None and out["me"]["username"] == "bob"


def test_weekly_route(week, monkeypatch):
    a = _owner()
    _listen(a, week, "2030-01-08", 120)
    monkeypatch.setattr(main, "_all_handles", lambda: {a: "ann"})
    out = asyncio.run(main.leaderboard_weekly(
        language=week, limit=50, authorization=AUTH, x_shadow_device=a,
    ))
    assert out["me"]["rank"] == 1 and out["entries"][0]["score"] == 2
