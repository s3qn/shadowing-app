"""The leaderboard entries carry each owner's current `day:` streak."""

import uuid
from datetime import date, timedelta

import pytest

import progression
import store


@pytest.fixture(autouse=True)
def _init_db():
    store.init()
    progression.init()


def _owner():
    return f"user_{uuid.uuid4().hex}"


def _pay_days(owner, offsets):
    today = date.fromisoformat(progression._today())
    with progression.connect() as conn:
        for off in offsets:
            day = (today - timedelta(days=off)).isoformat()
            conn.execute(
                "INSERT INTO awards (owner, key, xp, coins, created_at) VALUES (?, ?, 0, 0, ?)",
                (owner, f"day:{day}", day),
            )


def _board(owners):
    names = {o: f"cat{i}" for i, o in enumerate(owners)}
    res = progression.leaderboard(owners[0], 50, lambda: dict(names))
    return {e["username"]: e["streak_days"] for e in res["entries"]}, names


def test_six_days_ending_yesterday():
    a = _owner()
    _pay_days(a, range(1, 7))
    got, names = _board([a])
    assert got[names[a]] == 6


def test_today_counts():
    a = _owner()
    _pay_days(a, range(0, 3))
    got, names = _board([a])
    assert got[names[a]] == 3


def test_gap_resets():
    a, b = _owner(), _owner()
    _pay_days(a, [1, 2, 4, 5])
    _pay_days(b, [3, 4])
    got, names = _board([a, b])
    assert got[names[a]] == 2
    assert got[names[b]] == 0


def test_weekly_entries_carry_streak():
    a = _owner()
    _pay_days(a, range(0, 4))
    names = {a: "weekly_cat"}
    out = progression.weekly_leaderboard(a, 50, lambda: dict(names), "2030-01-07T00:00:00+00:00", {a: 5}, {}, "xx")
    assert out["entries"][0]["streak_days"] == 4


def test_owner_without_handle_stays_hidden():
    a, hidden = _owner(), _owner()
    _pay_days(hidden, range(0, 5))
    res = progression.leaderboard(a, 50, lambda: {a: "named"})
    assert [e["username"] for e in res["entries"]] == ["named"]
