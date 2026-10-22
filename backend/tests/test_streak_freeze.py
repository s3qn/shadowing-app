"""Streak freezes and the streak milestones in progression.py: the buy, the
settle rule, the bridged count, the longest run, the 100 and 365 rungs with
their items, and the route's purchase_id check. conftest points
SHADOW_DATA_DIR at a throwaway directory."""

import asyncio
import uuid
from datetime import date, timedelta

import pytest
from fastapi import HTTPException

import main
import progression
import schedule
import store

AUTH = f"Bearer {main.SHADOW_TOKEN}"
D = date(2026, 3, 10)


def _d(n: int) -> str:
    """D minus n days."""
    return (D - timedelta(days=n)).isoformat()


@pytest.fixture(autouse=True)
def _init_db(monkeypatch):
    store.init()
    progression.init()
    schedule.init()
    monkeypatch.setattr(progression, "_today", lambda: D.isoformat())


@pytest.fixture
def owner():
    return f"user_{uuid.uuid4().hex}"


def _coins(owner, n):
    progression.award(owner, f"seed:{uuid.uuid4().hex}", 0, n)


def _days(owner, *back):
    for n in back:
        progression.award(owner, f"day:{_d(n)}", 0, 0)


def _freeze(owner, bought_back):
    """A held freeze bought `bought_back` days before D, through buy_freeze."""
    progression._today = lambda: _d(bought_back)
    try:
        _coins(owner, progression.FREEZE_PRICE)
        progression.buy_freeze(owner, uuid.uuid4().hex)
    finally:
        progression._today = lambda: D.isoformat()


def _rows(owner):
    conn = progression.connect()
    return conn.execute(
        "SELECT * FROM streak_freezes WHERE owner=?", (owner,)
    ).fetchall()


def test_buy_debits_the_price_and_holds_one(owner):
    _coins(owner, 200)
    snap = progression.buy_freeze(owner, "purchase-1")
    assert snap["coins"] == 50
    assert snap["freezes_held"] == 1
    assert snap["freeze_price"] == 150 and snap["freeze_cap"] == 2
    assert snap["frozen_days"] == []


def test_a_replayed_purchase_id_changes_nothing(owner):
    _coins(owner, 400)
    progression.buy_freeze(owner, "purchase-1")
    snap = progression.buy_freeze(owner, "purchase-1")
    assert snap["coins"] == 250 and snap["freezes_held"] == 1
    assert len(_rows(owner)) == 1


def test_a_third_freeze_is_refused_at_the_cap(owner):
    _coins(owner, 500)
    progression.buy_freeze(owner, "purchase-1")
    progression.buy_freeze(owner, "purchase-2")
    with pytest.raises(HTTPException) as e:
        progression.buy_freeze(owner, "purchase-3")
    assert e.value.status_code == 400
    assert e.value.detail == {"code": "freeze_cap", "cap": 2}
    assert progression.snapshot(owner)["coins"] == 200


def test_short_coins_is_refused_with_no_row(owner):
    _coins(owner, 149)
    with pytest.raises(HTTPException) as e:
        progression.buy_freeze(owner, "purchase-1")
    assert e.value.status_code == 400
    assert e.value.detail == {"code": "not_enough_coins", "price": 150, "coins": 149}
    assert _rows(owner) == []
    assert progression.snapshot(owner)["coins"] == 149


def test_a_freeze_bridges_a_missed_day_without_counting(owner):
    _days(owner, 3, 2)
    _freeze(owner, 3)
    snap = progression.snapshot(owner)
    assert snap["streak_days"] == 2
    assert snap["frozen_days"] == [_d(1)]
    assert snap["freezes_held"] == 0


def test_a_gap_longer_than_the_held_freezes_uses_none(owner):
    _days(owner, 4, 3)
    _freeze(owner, 4)
    snap = progression.snapshot(owner)
    assert snap["streak_days"] == 0
    assert snap["freezes_held"] == 1
    assert snap["frozen_days"] == []


def test_a_gap_of_two_with_two_held_uses_both(owner):
    _days(owner, 4, 3)
    _freeze(owner, 4)
    _freeze(owner, 3)
    snap = progression.snapshot(owner)
    assert snap["streak_days"] == 2
    assert snap["frozen_days"] == [_d(2), _d(1)]
    assert snap["freezes_held"] == 0


def test_a_gap_longer_than_the_cap_uses_none(owner):
    _days(owner, 5, 4)
    _freeze(owner, 5)
    _freeze(owner, 5)
    snap = progression.snapshot(owner)
    assert snap["streak_days"] == 0 and snap["freezes_held"] == 2


def test_no_run_before_the_gap_uses_none(owner):
    _freeze(owner, 3)
    snap = progression.snapshot(owner)
    assert snap["freezes_held"] == 1 and snap["frozen_days"] == []


def test_a_freeze_bought_today_never_covers_yesterday(owner):
    _days(owner, 3, 2)
    _freeze(owner, 0)
    snap = progression.snapshot(owner)
    assert snap["streak_days"] == 0
    assert snap["freezes_held"] == 1 and snap["frozen_days"] == []


def test_yesterday_practised_uses_nothing(owner):
    _days(owner, 2, 1)
    _freeze(owner, 2)
    snap = progression.snapshot(owner)
    assert snap["streak_days"] == 2 and snap["freezes_held"] == 1


def test_the_snapshot_lists_when_each_held_freeze_was_bought(owner):
    _days(owner, 2, 1)
    _freeze(owner, 0)
    _freeze(owner, 2)
    snap = progression.snapshot(owner)
    assert snap["freezes_bought"] == [_d(2), _d(0)]
    assert snap["server_day"] == D.isoformat()


def test_a_used_freeze_leaves_the_bought_list(owner):
    _days(owner, 3, 2)
    _freeze(owner, 3)
    snap = progression.snapshot(owner)
    assert snap["frozen_days"] == [_d(1)] and snap["freezes_bought"] == []


def test_a_take_after_a_frozen_day_pays_the_streak_bonus(owner):
    _days(owner, 3, 2)
    _freeze(owner, 3)
    progression.award_take(owner, "isl", 0)
    conn = progression.connect()
    keys = {
        r["key"] for r in conn.execute("SELECT key FROM awards WHERE owner=?", (owner,))
    }
    assert f"day:{D.isoformat()}" in keys
    assert f"streak:{D.isoformat()}" in keys
    snap = progression.snapshot(owner)
    assert snap["streak_days"] == 3
    assert snap["frozen_days"] == [_d(1)]


def test_the_take_settles_the_freeze_itself(owner):
    """No snapshot between the buy and the take: the award path settles."""
    _days(owner, 3, 2)
    _freeze(owner, 3)
    conn = progression.connect()
    conn.execute("UPDATE streak_freezes SET used_on=NULL WHERE owner=?", (owner,))
    conn.commit()
    progression.award_take(owner, "isl", 0)
    assert [r["used_on"] for r in _rows(owner)] == [_d(1)]


def test_longest_streak_bridges_frozen_days(owner):
    _days(owner, 9, 8, 7, 5, 4)
    conn = progression.connect()
    conn.execute(
        "INSERT INTO streak_freezes (owner, purchase_id, bought_on, used_on, created_at)"
        " VALUES (?, ?, ?, ?, ?)",
        (owner, "seeded-1", _d(9), _d(6), "x"),
    )
    conn.commit()
    assert progression.stats(owner)["longest_streak"] == 5
    assert progression.snapshot(owner)["longest_streak"] == 5


def test_delete_owner_clears_the_freezes(owner):
    _coins(owner, 150)
    progression.buy_freeze(owner, "purchase-1")
    progression.delete_owner(owner)
    assert _rows(owner) == []


def test_the_route_rejects_a_short_purchase_id(owner):
    with pytest.raises(HTTPException) as e:
        asyncio.run(main.streak_freeze_buy(
            purchase_id="abc", authorization=AUTH, x_shadow_device=owner,
        ))
    assert e.value.status_code == 422
    assert e.value.detail == {"code": "bad_purchase_id"}


def test_the_route_buys_once_per_purchase_id(owner):
    _coins(owner, 400)
    pid = str(uuid.uuid4())
    for _ in range(2):
        snap = asyncio.run(main.streak_freeze_buy(
            purchase_id=pid, authorization=AUTH, x_shadow_device=owner,
        ))
    assert snap["freezes_held"] == 1 and snap["coins"] == 250


def test_streak_100_pays_and_grants_its_item(owner):
    _days(owner, *range(1, 100))
    progression.award_take(owner, "isl", 0)
    snap = progression.snapshot(owner)
    assert snap["streak_days"] == 100
    assert {"streak_7", "streak_30", "streak_100"} <= set(snap["earned"])
    assert "streak_365" not in snap["earned"]
    for item in ("accessory.badge_ember", "body.scarf_ember", "head.crown_ember"):
        assert item in snap["owned"]
    assert "face.mask_phoenix" not in snap["owned"]
    assert not any(v for v in snap["equipped"].values() if v and "ember" in v)


def test_a_read_heals_the_item_of_an_earned_streak_milestone(owner):
    progression.award(owner, "ms:streak_30", 0, 0)
    snap = progression.snapshot(owner)
    assert "body.scarf_ember" in snap["owned"]
    assert "accessory.badge_ember" not in snap["owned"]


def test_streak_items_unlock_through_their_achievement():
    items = {i["id"]: i for i in progression.catalog("en", with_rarity=False)["items"]}
    for rung, item_id in progression.STREAK_ITEMS.items():
        assert items[item_id]["unlock"]["source"] == "achievement"
        assert items[item_id]["unlock"]["need"] == f"streak_{rung}"
