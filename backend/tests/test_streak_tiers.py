"""Streak tier rungs: STREAK_RUNGS pays ms:streak_N once per rung and grants
the rung's item on the day's first payment; the ledger row is the record, so
a rung re-reached after a break pays nothing twice. The snapshot reports
the highest rung ever paid as streak_rung_best."""

import uuid
from datetime import timedelta

import pytest
from test_streak_freeze import D, _d, _days, _freeze

import progression
import schedule
import store

RUNGS = (7, 14, 30, 60, 100, 180, 365, 500, 1000)
STREAK_IDS = [f"streak_{n}" for n in RUNGS]


@pytest.fixture(autouse=True)
def _init_db(monkeypatch):
    store.init()
    progression.init()
    schedule.init()
    monkeypatch.setattr(progression, "_today", lambda: D.isoformat())
    monkeypatch.setattr(progression, "DAILY_XP_CAP", 1000)


@pytest.fixture
def owner():
    return f"user_{uuid.uuid4().hex}"


def _seed_run(owner, days, end=D):
    """`days` consecutive day keys ending the day before `end`."""
    for n in range(days, 0, -1):
        progression.award(owner, f"day:{(end - timedelta(days=n)).isoformat()}", 0, 0)


def _ms_rows(owner, name):
    return progression.connect().execute(
        "SELECT COUNT(*) AS n FROM awards WHERE owner=? AND key=?", (owner, f"ms:{name}")
    ).fetchone()["n"]


def _owned_rows(owner, item_id):
    return progression.connect().execute(
        "SELECT COUNT(*) AS n FROM owned WHERE owner=? AND item_id=?", (owner, item_id)
    ).fetchone()["n"]


# --- the tables agree ---


def test_rungs_items_milestones_and_names_line_up():
    assert progression.STREAK_RUNGS == RUNGS
    assert tuple(progression.STREAK_ITEMS) == RUNGS
    for rung in RUNGS:
        assert f"streak_{rung}" in progression.MILESTONES
        assert progression.ACHIEVEMENTS[f"streak_{rung}"]["en"] == f"{rung} day streak"
        assert progression.ACHIEVEMENTS[f"streak_{rung}"]["he"] == f"רצף של {rung} ימים"
        assert progression.STREAK_ITEMS[rung] in progression._ITEMS
    rewards = [progression.MILESTONES[name] for name in STREAK_IDS]
    assert rewards == sorted(rewards)


# --- reaching a rung ---


def test_the_fourteenth_day_pays_the_rung_and_its_item(owner):
    _seed_run(owner, 13)
    got = progression.award_take(owner, "isl", 0)
    assert "streak_14" in got["milestones"]
    snap = progression.snapshot(owner)
    assert snap["streak_days"] == 14
    assert "face.streak_14" in snap["owned"]
    assert "streak_14" in snap["earned"]
    assert snap["streak_rung_best"] == 14


def test_a_rung_pays_once_across_the_day_and_the_next(owner, monkeypatch):
    _seed_run(owner, 13)
    progression.award_take(owner, "isl", 0)
    got = progression.award_take(owner, "isl", 1)
    assert "streak_14" not in got["milestones"]
    monkeypatch.setattr(progression, "_today", lambda: _d(-1))
    got = progression.award_take(owner, "isl", 2)
    assert "streak_14" not in got["milestones"]
    assert _ms_rows(owner, "streak_14") == 1
    assert _owned_rows(owner, "face.streak_14") == 1
    assert progression.snapshot(owner)["streak_rung_best"] == 14


def test_a_thousand_day_run_pays_every_rung_in_one_take(owner):
    conn = progression.connect()
    with conn:
        conn.execute(
            "INSERT OR IGNORE INTO progress (owner, xp, coins, updated_at) VALUES (?, 0, 0, ?)",
            (owner, progression._now()),
        )
        conn.executemany(
            "INSERT OR IGNORE INTO awards (owner, key, xp, coins, created_at) VALUES (?, ?, 0, 0, ?)",
            [
                (owner, f"day:{(D - timedelta(days=n)).isoformat()}", progression._now())
                for n in range(999, 0, -1)
            ],
        )
    got = progression.award_take(owner, "isl", 0)
    assert [m for m in got["milestones"] if m.startswith("streak_")] == STREAK_IDS
    snap = progression.snapshot(owner)
    assert snap["streak_days"] == 1000
    assert all(item in snap["owned"] for item in progression.STREAK_ITEMS.values())
    assert snap["streak_rung_best"] == 1000


def test_a_frozen_day_inside_the_run_still_reaches_fourteen(owner, monkeypatch):
    _days(owner, *range(14, 8, -1))
    _freeze(owner, 9)
    monkeypatch.setattr(progression, "_today", lambda: _d(7))
    progression.snapshot(owner)  # settles the freeze on D-8
    monkeypatch.setattr(progression, "_today", lambda: D.isoformat())
    _days(owner, *range(7, 0, -1))
    got = progression.award_take(owner, "isl", 0)
    snap = progression.snapshot(owner)
    assert snap["frozen_days"] == [_d(8)]
    assert snap["streak_days"] == 14
    assert "streak_14" in got["milestones"]
    assert "face.streak_14" in snap["owned"]


def test_a_rung_reached_again_after_a_break_pays_nothing_twice(owner, monkeypatch):
    _seed_run(owner, 13)
    progression.award_take(owner, "isl", 0)
    later = D + timedelta(days=40)
    _seed_run(owner, 13, end=later)
    monkeypatch.setattr(progression, "_today", lambda: later.isoformat())
    got = progression.award_take(owner, "isl", 0)
    snap = progression.snapshot(owner)
    assert snap["streak_days"] == 14
    assert "streak_14" not in got["milestones"]
    assert _ms_rows(owner, "streak_14") == 1
    assert _owned_rows(owner, "face.streak_14") == 1
    replay = progression.award(owner, "ms:streak_14", 100, 25)
    assert (replay["xp"], replay["coins"]) == (0, 0)
    assert _owned_rows(owner, "face.streak_14") == 1
    assert snap["streak_rung_best"] == 14


def test_a_second_take_the_same_day_does_not_see_the_streak(owner):
    _seed_run(owner, 13)
    progression.award_take(owner, "isl", 0)
    got = progression.award_take(owner, "isl", 1)
    assert not [m for m in got["milestones"] if m.startswith("streak_")]


# --- what the client reads ---


def test_a_fresh_owner_has_no_best_rung(owner):
    assert progression.snapshot(owner)["streak_rung_best"] == 0


def test_achievements_list_the_nine_rungs_in_order(owner):
    rungs = [a for a in progression.achievements(owner) if a["id"].startswith("streak_")]
    assert [a["id"] for a in rungs] == STREAK_IDS
    assert all(not a["secret"] and a["name"] and a["earned_at"] is None for a in rungs)
    assert [a["name"] for a in progression.achievements(owner, "he") if a["id"] == "streak_14"] == [
        "רצף של 14 ימים"
    ]


def test_the_catalog_carries_nine_achievement_items():
    assert progression.catalog("en", with_rarity=False)["version"] == 2
    for ui, text, name in (
        ("en", "Earn: 14 day streak", "14 Day Reward"),
        ("he", "השיגו: רצף של 14 ימים", "פרס 14 ימים"),
    ):
        items = progression.catalog(ui, with_rarity=False)["items"]
        tied = {i["id"]: i for i in items if i["unlock"]["source"] == "achievement"}
        assert set(tied) == set(progression.STREAK_ITEMS.values())
        assert len(tied) == 9
        assert tied["face.streak_14"]["unlock"]["text"] == text
        assert tied["face.streak_14"]["unlock"]["need"] == "streak_14"
        assert tied["face.streak_14"]["name"] == name
        assert all(i["price"] == 0 and i["level_req"] == 1 for i in tied.values())
    slots = {i["id"]: i["slot"] for i in progression._CATALOG["items"]}
    for item_id in progression.STREAK_ITEMS.values():
        assert item_id.split(".")[0] == slots[item_id]
