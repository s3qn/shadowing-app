"""Tests for progression.py: the XP curve, the award ledger, the shop, the
catalog, and the award hooks in log_practice and upload_take. Direct calls,
no server. conftest points SHADOW_DATA_DIR at a throwaway directory."""

import asyncio
import io
import uuid

import pytest
from fastapi import HTTPException, UploadFile

import main
import progression
import schedule
import store

AUTH = f"Bearer {main.SHADOW_TOKEN}"


@pytest.fixture(autouse=True)
def _init_db():
    store.init()
    progression.init()
    schedule.init()


@pytest.fixture
def owner():
    return f"user_{uuid.uuid4().hex}"


def _give(owner, xp=0, coins=0):
    """Puts a progress row in place through the ledger primitive."""
    progression.award(owner, f"seed:{uuid.uuid4().hex}", xp, coins)


def _code(exc: HTTPException):
    return exc.detail["code"]


# --- curve ---


def test_curve_first_level_and_strictly_increasing():
    assert progression.xp_to_next(1) == 60
    needs = [progression.xp_to_next(n) for n in range(1, 50)]
    assert all(b > a for a, b in zip(needs, needs[1:]))


def test_level_for_at_and_just_under_a_threshold():
    assert progression.level_for(0) == 1
    assert progression.level_for(59) == 1
    assert progression.level_for(60) == 2
    second = 60 + progression.xp_to_next(2)
    assert progression.level_for(second - 1) == 2
    assert progression.level_for(second) == 3


def test_level_caps_at_50():
    total = sum(progression.xp_to_next(n) for n in range(1, 50))
    assert progression.level_for(total - 1) == 49
    assert progression.level_for(total) == 50
    assert progression.level_for(total * 10) == 50


# --- awards ---


def test_an_award_key_paid_twice_adds_once(owner):
    first = progression.award(owner, "k:1", 10, 2)
    again = progression.award(owner, "k:1", 10, 2)
    assert (first["xp"], first["coins"]) == (10, 2)
    assert (again["xp"], again["coins"]) == (0, 0)
    snap = progression.snapshot(owner)
    assert (snap["xp"], snap["coins"]) == (10, 2)


def test_practice_at_30s_pays_nothing(owner):
    got = progression.award_practice(owner, "isl", 30)
    assert (got["xp"], got["coins"]) == (0, 0)
    assert progression.snapshot(owner)["xp"] == 0


def test_practice_at_45s_pays_practiced_once_across_two_calls(owner):
    first = progression.award_practice(owner, "isl", 45)
    second = progression.award_practice(owner, "isl", 50)
    # practiced 30 + day 20
    assert (first["xp"], first["coins"]) == (50, 15)
    assert (second["xp"], second["coins"]) == (0, 0)


def test_practice_at_125s_pays_two_minute_keys(owner):
    got = progression.award_practice(owner, "isl", 125)
    # practiced 30 + 2 minutes of 5 + day 20 = 60 XP, which is level 2
    assert got["xp"] == 30 + 10 + 20
    assert got["coins"] == 10 + 2 + 5 + 25


def test_the_21st_minute_pays_nothing(owner):
    progression.award_practice(owner, "isl", 20 * 60)
    before = progression.snapshot(owner)["xp"]
    got = progression.award_practice(owner, "isl", 21 * 60 + 5)
    assert got["xp"] == 0
    assert progression.snapshot(owner)["xp"] == before


def test_award_take_same_island_idx_day_pays_once(owner):
    first = progression.award_take(owner, "isl", 0)
    again = progression.award_take(owner, "isl", 0)
    assert first["xp"] == 10 + 20
    assert again["xp"] == 0


def test_the_61st_take_of_a_day_pays_nothing(owner):
    for i in range(60):
        assert progression.award_take(owner, "isl", i)["xp"] > 0
    assert progression.award_take(owner, "isl", 60)["xp"] == 0


def test_level_up_pays_25_coins_per_level_gained(owner):
    got = progression.award(owner, "big", 60, 0)
    assert got["leveled_up"] is True and got["level"] == 2
    assert got["coins"] == 25
    two = progression.award(owner, "bigger", progression.xp_to_next(2) + progression.xp_to_next(3), 0)
    assert two["level"] == 4
    assert two["coins"] == 50
    assert progression.snapshot(owner)["coins"] == 75


# --- buy ---


def test_buy_unknown_item_is_404(owner):
    with pytest.raises(HTTPException) as e:
        progression.buy(owner, "head.nope")
    assert e.value.status_code == 404 and _code(e.value) == "unknown_item"


def test_buy_level_locked_leaves_coins(owner):
    _give(owner, coins=900)
    with pytest.raises(HTTPException) as e:
        progression.buy(owner, "head.crown_purple")
    assert e.value.status_code == 400
    assert _code(e.value) == "level_locked" and e.value.detail["level_req"] == 50
    snap = progression.snapshot(owner)
    assert snap["coins"] == 900 and snap["owned"] == []


def test_buy_not_enough_coins_leaves_owned_empty(owner):
    _give(owner, coins=5)
    with pytest.raises(HTTPException) as e:
        progression.buy(owner, "body.scarf_blue")
    assert _code(e.value) == "not_enough_coins"
    assert e.value.detail["price"] == 30 and e.value.detail["coins"] == 5
    assert progression.snapshot(owner)["owned"] == []


def test_buy_debits_equips_and_a_second_buy_charges_nothing(owner):
    _give(owner, coins=100)
    snap = progression.buy(owner, "body.scarf_blue")
    assert snap["coins"] == 70
    assert snap["owned"] == ["body.scarf_blue"]
    assert snap["equipped"]["body"] == "body.scarf_blue"
    again = progression.buy(owner, "body.scarf_blue")
    assert again["coins"] == 70


def test_a_free_starter_can_be_claimed_with_no_progress_row(owner):
    snap = progression.buy(owner, "accessory.collar_red")
    assert snap["owned"] == ["accessory.collar_red"]
    assert snap["equipped"]["accessory"] == "accessory.collar_red"


# --- equip ---


def test_equip_rules(owner):
    with pytest.raises(HTTPException) as e:
        progression.equip(owner, "head", "head.cap_paper")
    assert _code(e.value) == "not_owned"
    with pytest.raises(HTTPException) as e:
        progression.equip(owner, "hat", "head.cap_paper")
    assert _code(e.value) == "bad_slot"
    progression.buy(owner, "head.cap_paper")
    with pytest.raises(HTTPException) as e:
        progression.equip(owner, "face", "head.cap_paper")
    assert _code(e.value) == "wrong_slot"
    snap = progression.equip(owner, "head", "")
    assert snap["equipped"]["head"] is None
    snap = progression.equip(owner, "head", "head.cap_paper")
    assert snap["equipped"]["head"] == "head.cap_paper"


# --- erase ---

TABLES = ("progress", "awards", "owned", "equipped")


def _rows(owner):
    conn = progression.connect()
    return {t: conn.execute(f"SELECT COUNT(*) AS n FROM {t} WHERE owner=?", (owner,)).fetchone()["n"] for t in TABLES}


def test_erase_owner_clears_one_owner_and_keeps_another(owner):
    other = f"user_{uuid.uuid4().hex}"
    for who in (owner, other):
        progression.award_take(who, "isl", 0)
        progression.buy(who, "head.cap_paper")
    assert all(n > 0 for n in _rows(owner).values())
    main._erase_owner(owner)
    assert _rows(owner) == {t: 0 for t in TABLES}
    assert all(n > 0 for n in _rows(other).values())


# --- catalog ---


def test_catalog_is_well_formed():
    cat = progression.catalog("en")
    items = cat["items"]
    assert len(items) >= 52
    ids = [i["id"] for i in items]
    assert len(set(ids)) == len(ids)
    for i in items:
        assert i["slot"] in cat["slots"]
        assert 1 <= i["level_req"] <= 50
        assert i["price"] >= 0
        assert i["art"]["shape"] in cat["shapes"][i["slot"]]
        assert i["id"].startswith(i["slot"] + ".")
    assert {"accessory.collar_red", "head.cap_paper"} <= {i["id"] for i in items if i["price"] == 0 and i["level_req"] == 1}


def test_catalog_he_names_are_hebrew():
    en = {i["id"]: i["name"] for i in progression.catalog("en")["items"]}
    he = {i["id"]: i["name"] for i in progression.catalog("he")["items"]}
    assert en.keys() == he.keys()
    assert all(any("֐" <= c <= "׿" for c in n) for n in he.values())
    assert en["head.cap_paper"] != he["head.cap_paper"]


# --- hooks ---


def test_log_practice_response_carries_an_award(owner):
    out = asyncio.run(schedule.log_practice(
        island_id="isl", seconds=60.0, authorization=AUTH, x_shadow_device=owner,
    ))
    assert out["award"]["xp"] > 0


def test_a_failing_award_does_not_fail_log_practice(owner, monkeypatch):
    def boom(*a, **k):
        raise RuntimeError("db down")

    monkeypatch.setattr(progression, "award_practice", boom)
    out = asyncio.run(schedule.log_practice(
        island_id="isl", seconds=60.0, authorization=AUTH, x_shadow_device=owner,
    ))
    assert "award" not in out and out["island_id"] == "isl"


def _wire_take(monkeypatch, tmp_path):
    island = {"id": "isl", "device": "x", "lines": [{"idx": 0}]}

    async def fake_audio(*a, **k):
        return tmp_path / "ref.wav"

    monkeypatch.setattr(main, "_own_island", lambda island_id, device: island)
    monkeypatch.setattr(main, "_load_take_profile", lambda aec, device: None)
    monkeypatch.setattr(main, "_take_use_slot", lambda device, kind: None)
    monkeypatch.setattr(main, "_resolve_line_audio", fake_audio)
    monkeypatch.setattr(main, "_run_clean", lambda *a, **k: {"score": 1})


def _upload(owner, calibrate="0"):
    return asyncio.run(main.upload_take(
        island_id="isl", idx=0, speed=1.0, calibrate=calibrate, start=-1, end=-1,
        lag=0, line_start=-1,
        take=UploadFile(file=io.BytesIO(b"RIFF"), filename="t.wav"),
        authorization=AUTH, x_shadow_device=owner,
    ))


def test_upload_take_response_carries_an_award(owner, monkeypatch, tmp_path):
    _wire_take(monkeypatch, tmp_path)
    out = _upload(owner)
    assert out["score"] == 1 and out["award"]["xp"] > 0


def test_a_failing_award_does_not_fail_the_take(owner, monkeypatch, tmp_path):
    _wire_take(monkeypatch, tmp_path)

    def boom(*a, **k):
        raise RuntimeError("db down")

    monkeypatch.setattr(progression, "award_take", boom)
    out = _upload(owner)
    assert out == {"score": 1}


def test_calibration_takes_pay_nothing(owner, monkeypatch, tmp_path):
    _wire_take(monkeypatch, tmp_path)
    monkeypatch.setattr(main, "_run_calibration", lambda *a, **k: {"ok": True})
    out = _upload(owner, calibrate="1")
    assert "award" not in out
    assert progression.snapshot(owner)["xp"] == 0
