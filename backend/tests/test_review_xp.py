"""Tests for progression.award_review: the daily review XP (BL-51)."""

import uuid
from datetime import datetime, timedelta, timezone

import pytest
from fastapi import HTTPException

import progression
import store


@pytest.fixture(autouse=True)
def _init_db():
    store.init()
    progression.init()


@pytest.fixture
def owner():
    return f"user_{uuid.uuid4().hex}"


def _day(offset=0):
    return (datetime.now(timezone.utc).date() + timedelta(days=offset)).isoformat()


def _go(owner, n=10, seconds=100, score=None, day=None, sid=None):
    return progression.award_review(owner, sid or uuid.uuid4().hex, n, seconds, score, day or _day())


def test_under_three_sentences_pays_nothing(owner):
    r = _go(owner, n=2)
    assert r["xp"] == 0 and r["streak"] == 0
    assert progression.snapshot(owner)["xp"] == 0


def test_seconds_guard(owner):
    assert _go(owner, n=10, seconds=8)["xp"] == 0  # 8 // 3 = 2
    r = _go(owner, n=10, seconds=9)  # 3 counted
    assert r["xp"] == 12 + 40 + 5


def test_first_session_example(owner):
    r = _go(owner)
    assert r["xp"] == 85 and r["first_of_day"] and r["streak"] == 1
    assert r["coins"] >= 8


def test_repeat_factors_and_cap(owner):
    got = [_go(owner)["xp"] for _ in range(12)]
    assert got[0] == 85
    assert got[1:5] == [16, 8, 4, 4]
    assert got[5:10] == [4] * 5
    assert got[10:] == [0, 0]


def test_score_levels(owner):
    d = _day(-1)
    assert _go(owner, n=10, score=0, day=d)["xp"] == 20 + 40 + 5
    assert _go(owner, n=10, score=100, day=_day())["xp"] == 60 + 40 + 10
    assert _go(owner, n=10, score="x", day=_day())["xp"] == 16 * 1  # neutral, repeat


def test_max_counted_and_seven_day_streak(owner):
    for i in range(1, 7):
        progression.award(owner, f"reviewday:{_day(-i)}", 0, 0)
    r = _go(owner, n=40, seconds=500, score=90)
    assert r["streak"] == 7
    assert r["xp"] == 168 + 40 + 35


def test_replay_pays_zero(owner):
    first = _go(owner, sid="s1")
    again = _go(owner, sid="s1")
    assert first["xp"] > 0 and again["xp"] == 0
    assert progression.snapshot(owner)["xp"] == first["xp"]


def test_outside_daily_cap(owner):
    day = _day()
    for i in range(5):
        progression._run_awards(owner, [(f"take:x:{i}:{day}", 40, 0)], day)
    before = progression.snapshot(owner)
    assert before["xp_today"] == progression.DAILY_XP_CAP
    r = _go(owner)
    after = progression.snapshot(owner)
    assert r["xp"] == 85
    assert after["xp_today"] == before["xp_today"]
    assert after["xp"] == before["xp"] + 85


def test_streak_and_gap(owner):
    _go(owner, day=_day(-1))
    assert _go(owner, day=_day())["streak"] == 2
    assert progression.snapshot(owner)["review_streak_days"] == 2
    # a gap: a day with a hole before it does not extend the run
    solo = f"user_{uuid.uuid4().hex}"
    assert _go(solo, day=_day(1))["streak"] == 1
    assert _go(solo, day=_day(-1))["streak"] == 1


def test_local_day_out_of_range(owner):
    for bad in (_day(2), _day(-2), "nope"):
        with pytest.raises(HTTPException) as e:
            _go(owner, day=bad)
        assert e.value.status_code == 422


def test_level_up_coins(owner):
    r = _go(owner)  # 85 xp crosses level 2 (60)
    assert r["leveled_up"] and r["level"] >= 2
    assert r["coins"] >= 8 + progression.LEVEL_UP_COINS
