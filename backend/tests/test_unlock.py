"""The unlock model: one source per catalog item (grant, achievement, hours,
level), the server-owned requirement copy, the buy gate and `earned` on
every snapshot. No shipped item is tied to an achievement yet, so the tests
add one (face.test_badge) to a copy of the catalog."""

import uuid

import pytest
from fastapi import HTTPException

import progression
import schedule
import store

KEYS = {"source", "need", "short", "text", "group"}
BADGE = {
    "id": "face.test_badge",
    "slot": "face",
    "name": "Test Badge",
    "nameHe": "תג בדיקה",
    "level_req": 1,
    "price": 0,
    "achievement_req": "perfect_take",
    "art": {"shape": "mask", "color": "#FFFFFF"},
}


@pytest.fixture(autouse=True)
def _init_db():
    store.init()
    schedule.init()
    progression.init()


@pytest.fixture
def owner():
    return f"user_{uuid.uuid4().hex}"


def _add_badge(monkeypatch):
    monkeypatch.setattr(
        progression, "_CATALOG",
        {**progression._CATALOG, "items": [*progression._CATALOG["items"], BADGE]},
    )
    monkeypatch.setattr(progression, "_ITEMS", {**progression._ITEMS, BADGE["id"]: BADGE})


@pytest.fixture
def badge(monkeypatch):
    _add_badge(monkeypatch)
    return BADGE


@pytest.fixture(params=["shipped", "with_badge"])
def raw_items(request, monkeypatch):
    """The catalog as shipped, then with the achievement-tied fixture item."""
    if request.param == "with_badge":
        _add_badge(monkeypatch)
    return progression._CATALOG["items"]


# --- unlock_of ---


@pytest.mark.parametrize(
    "item, en, he",
    [
        (
            {"level_req": 6, "price": 110},
            {"source": "level", "need": 6, "short": "Lv 6", "text": "Reach level 6", "group": "By level"},
            {"source": "level", "need": 6, "short": "רמה 6", "text": "הגיעו לרמה 6", "group": "לפי רמה"},
        ),
        (
            {"level_req": 1, "price": 0, "hours_req": 50},
            {"source": "hours", "need": 50, "short": "50 h", "text": "Listen for 50 hours", "group": "By listening hours"},
            {"source": "hours", "need": 50, "short": "50 ש׳", "text": "האזינו 50 שעות", "group": "לפי שעות האזנה"},
        ),
        (
            {"level_req": 1, "price": 0, "hours_req": 1},
            {"source": "hours", "need": 1, "short": "1 h", "text": "Listen for 1 hour", "group": "By listening hours"},
            {"source": "hours", "need": 1, "short": "1 ש׳", "text": "האזינו שעה אחת", "group": "לפי שעות האזנה"},
        ),
        (
            BADGE,
            {"source": "achievement", "need": "perfect_take", "short": "Perfect take", "text": "Earn: Perfect take", "group": "By achievement"},
            {"source": "achievement", "need": "perfect_take", "short": "הקלטה מושלמת", "text": "השיגו: הקלטה מושלמת", "group": "לפי הישג"},
        ),
        (
            {"level_req": 1, "price": 0, "grant_only": True},
            {"source": "grant", "need": "beta", "short": "Beta", "text": "Given to beta testers", "group": ""},
            {"source": "grant", "need": "beta", "short": "בטא", "text": "ניתן לבודקי בטא", "group": ""},
        ),
    ],
    ids=["level", "hours", "hours_one", "achievement", "grant"],
)
def test_unlock_of_en_and_he(item, en, he):
    assert progression.unlock_of(item, "en") == en
    assert progression.unlock_of(item, "he") == he
    assert progression.unlock_of(item, "fr") == en


def test_unlock_precedence_is_grant_achievement_hours_level():
    everything = {"level_req": 9, "hours_req": 10, "achievement_req": "first_take", "grant_only": True}
    assert progression.unlock_source(everything) == ("grant", "beta")
    del everything["grant_only"]
    assert progression.unlock_source(everything) == ("achievement", "first_take")
    del everything["achievement_req"]
    assert progression.unlock_source(everything) == ("hours", 10)
    del everything["hours_req"]
    assert progression.unlock_source(everything) == ("level", 9)


# --- the catalog ---


def test_every_item_carries_one_unlock(raw_items):
    for ui in ("en", "he"):
        by_id = {i["id"]: i for i in progression.catalog(ui, with_rarity=False)["items"]}
        assert by_id.keys() == {i["id"] for i in raw_items}
        for raw in raw_items:
            unlock = by_id[raw["id"]]["unlock"]
            assert set(unlock) == KEYS
            assert unlock["source"] in progression.UNLOCK_SOURCES
            assert unlock["short"] and unlock["text"]
            sources = [k for k in ("grant_only", "achievement_req", "hours_req") if k in raw]
            assert len(sources) <= 1, raw["id"]
            if "hours_req" in raw:
                assert unlock["source"] == "hours" and unlock["need"] == raw["hours_req"]
            if "achievement_req" in raw:
                assert unlock["source"] == "achievement" and unlock["need"] == raw["achievement_req"]
                assert raw["achievement_req"] in progression.MILESTONES
                assert not progression.ACHIEVEMENTS[raw["achievement_req"]]["secret"]
            if raw.get("grant_only"):
                assert unlock["source"] == "grant" and unlock["group"] == ""
            else:
                assert unlock["group"]
    assert by_id[progression.BETA_HAT]["unlock"]["source"] == "grant"
    assert {i["unlock"]["source"] for i in by_id.values()} >= {"level", "hours", "grant"}


def test_catalog_unlock_is_localised():
    en = {i["id"]: i["unlock"] for i in progression.catalog("en", with_rarity=False)["items"]}
    he = {i["id"]: i["unlock"] for i in progression.catalog("he", with_rarity=False)["items"]}
    for item_id, u in en.items():
        assert he[item_id]["source"] == u["source"] and he[item_id]["need"] == u["need"]
        assert he[item_id]["short"] != u["short"] and he[item_id]["text"] != u["text"]


# --- unlock_met ---


@pytest.mark.parametrize(
    "item, level, hours, earned, met",
    [
        ({"level_req": 6}, 5, 0, set(), False),
        ({"level_req": 6}, 6, 0, set(), True),
        ({"level_req": 1, "hours_req": 50}, 50, 49.9, set(), False),
        ({"level_req": 1, "hours_req": 50}, 1, 50, set(), True),
        (BADGE, 50, 1000, set(), False),
        (BADGE, 1, 0, {"perfect_take"}, True),
        (BADGE, 1, 0, {"first_take"}, False),
        ({"level_req": 1, "grant_only": True}, 50, 1000, set(progression.MILESTONES), False),
    ],
    ids=["level_below", "level_at", "hours_below", "hours_at", "ach_unearned", "ach_earned", "ach_other", "grant"],
)
def test_unlock_met(item, level, hours, earned, met):
    assert progression.unlock_met(item, level, hours, earned) is met


# --- buy and earned ---


def test_buy_achievement_item_is_locked_until_earned(owner, badge):
    assert progression.snapshot(owner)["earned"] == []
    with pytest.raises(HTTPException) as e:
        progression.buy(owner, badge["id"])
    assert e.value.status_code == 400
    assert e.value.detail == {"code": "achievement_locked", "achievement_req": "perfect_take"}
    assert progression.snapshot(owner)["owned"] == []

    progression.award(owner, "ms:perfect_take", *progression.MILESTONES["perfect_take"])
    snap = progression.snapshot(owner)
    assert snap["earned"] == ["perfect_take"]
    snap = progression.buy(owner, badge["id"])
    assert badge["id"] in snap["owned"]
    assert snap["equipped"]["face"] == badge["id"]


def test_locked_payloads_are_unchanged(owner):
    with pytest.raises(HTTPException) as e:
        progression.buy(owner, "head.crown_purple")
    assert e.value.detail == {"code": "level_locked", "level_req": 50}
    progression.award(owner, "seed", 10000, 5000)
    with pytest.raises(HTTPException) as e:
        progression.buy(owner, "accessory.bowtie_tide")
    assert e.value.detail == {"code": "hours_locked", "hours_req": 10}
    assert progression.snapshot(owner)["owned"] == []


def test_earned_is_sorted_and_only_milestones(owner):
    progression.award(owner, "ms:streak_7", 1, 0)
    progression.award(owner, "take:isl:0:1:x", 1, 0)
    progression.award(owner, "ms:first_take", 1, 0)
    assert progression.snapshot(owner)["earned"] == ["first_take", "streak_7"]
    assert progression.earned_milestones(owner) == {"first_take", "streak_7"}
