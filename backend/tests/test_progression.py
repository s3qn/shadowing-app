"""Tests for progression.py: the XP curve, the award ledger, the shop, the
catalog, and the award hooks in log_practice and upload_take. Direct calls,
no server. conftest points SHADOW_DATA_DIR at a throwaway directory."""

import asyncio
import io
import uuid
from datetime import date, timedelta

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
    # practiced 30 + day 20 + first_island 40; coins 10 + 5 + 10 + 25 for level 2
    assert (first["xp"], first["coins"]) == (90, 50)
    assert (second["xp"], second["coins"]) == (0, 0)


def test_practice_at_125s_pays_two_minute_keys(owner):
    got = progression.award_practice(owner, "isl", 125)
    # practiced 30 + 2 minutes of 5 + day 20 + first_island 40 = 100 XP, level 2
    assert got["xp"] == 30 + 10 + 20 + 40
    assert got["coins"] == 10 + 2 + 5 + 10 + 25


def test_the_21st_minute_pays_nothing(owner):
    progression.award_practice(owner, "isl", 20 * 60)
    before = progression.snapshot(owner)["xp"]
    got = progression.award_practice(owner, "isl", 21 * 60 + 5)
    assert got["xp"] == 0
    assert progression.snapshot(owner)["xp"] == before


def test_award_take_same_line_again_pays_the_small_repeat(owner):
    first = progression.award_take(owner, "isl", 0)
    again = progression.award_take(owner, "isl", 0)
    # take 10 + day 20 + first_take 40, then only the repeat: base 2 with no score
    assert first["xp"] == 10 + 20 + 40
    assert again["xp"] == 2


@pytest.mark.parametrize("total,xp", [(None, 2), (0, 2), (24, 2), (25, 3), (60, 4), (99, 5), (100, 6), (250, 6), (float("nan"), 2)])
def test_repeat_take_pays_two_plus_one_per_25_points(owner, total, xp):
    progression.award_take(owner, "isl", 0)
    got = progression.award_take(owner, "isl", 0, score={"total": total})
    assert got["xp"] == xp


def test_every_repeat_of_a_line_pays(owner, day):
    progression.award_take(owner, "isl", 0)
    for _ in range(3):
        assert progression.award_take(owner, "isl", 0, score={"total": 80})["xp"] == 5
    total, xp = _ledger(owner)
    assert total == xp


def test_cap_note_comes_once_a_day_when_a_take_pays_nothing(owner, day, monkeypatch):
    monkeypatch.setattr(progression, "DAILY_XP_CAP", 30)
    first = progression.award_take(owner, "isl", 0)  # take 10 + day 20 fills the cap
    assert first["cap_note"] is False
    blocked = progression.award_take(owner, "isl", 0)
    assert blocked["xp"] == 0 and blocked["capped"] is True and blocked["cap_note"] is True
    again = progression.award_take(owner, "isl", 1)
    assert again["xp"] == 0 and again["cap_note"] is False
    assert progression.snapshot(owner)["xp_today"] == 30


def test_the_61st_take_of_a_day_pays_nothing(owner, monkeypatch):
    # Lift the XP cap out of the way: this test is about the 60-take-a-day
    # limit, not the daily XP cap, which would otherwise zero the coins first.
    monkeypatch.setattr(progression, "DAILY_XP_CAP", 100000)
    for i in range(60):
        assert progression.award_take(owner, "isl", i)["coins"] > 0
    got = progression.award_take(owner, "isl", 60)
    assert (got["xp"], got["coins"]) == (0, 0)
    row = progression.connect().execute(
        "SELECT 1 FROM awards WHERE owner=? AND key LIKE 'take:isl:60:%'", (owner,)
    ).fetchone()
    assert row is None


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

TABLES = ("progress", "awards", "owned", "equipped", "day_xp", "line_best")


def _rows(owner):
    conn = progression.connect()
    return {t: conn.execute(f"SELECT COUNT(*) AS n FROM {t} WHERE owner=?", (owner,)).fetchone()["n"] for t in TABLES}


def test_erase_owner_clears_one_owner_and_keeps_another(owner):
    other = f"user_{uuid.uuid4().hex}"
    for who in (owner, other):
        progression.award_take(who, "isl", 0, score={"words": ["ok"] * 4}, line_idxs=[0])
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


def _own_island_for(device, island_id="isl"):
    """Give `device` an island so a practice post for it passes the ownership
    check that log_practice now enforces."""
    with store.connect() as conn:
        conn.execute(
            "INSERT INTO islands (id, status, created_at, device)"
            " VALUES (?, 'ready', '2026-01-01T00:00:00+00:00', ?)"
            " ON CONFLICT(id) DO UPDATE SET device = excluded.device",
            (island_id, device),
        )


def test_log_practice_response_carries_an_award(owner):
    _own_island_for(owner)
    out = asyncio.run(schedule.log_practice(
        island_id="isl", seconds=60.0, authorization=AUTH, x_shadow_device=owner,
    ))
    assert out["award"]["xp"] > 0


def test_a_failing_award_does_not_fail_log_practice(owner, monkeypatch):
    _own_island_for(owner)

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


def test_upload_take_scored_pays_quality(owner, monkeypatch, tmp_path):
    _wire_take(monkeypatch, tmp_path)
    monkeypatch.setattr(main, "_run_clean", lambda *a, **k: {"score": {"words": ["ok"] * 4}})
    out = _upload(owner)
    # take 10 + quality 5 + 5 + day 20 + mastery 60 = 100, all counting toward the cap
    assert out["award"]["milestones"] == ["first_take", "perfect_take", "full_speed", "first_mastery"]
    assert progression.snapshot(owner)["xp_today"] == 100


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


# --- cat-xp: daily cap, streak, quality, mastery, milestones ---

DAY = "2026-01-02"


@pytest.fixture
def day(monkeypatch):
    monkeypatch.setattr(progression, "_today", lambda: DAY)
    return DAY


def _ledger(owner):
    conn = progression.connect()
    total = conn.execute("SELECT COALESCE(SUM(xp),0) AS n FROM awards WHERE owner=?", (owner,)).fetchone()["n"]
    return total, progression.snapshot(owner)["xp"]


def _row_xp(owner, key):
    return progression.connect().execute(
        "SELECT xp FROM awards WHERE owner=? AND key=?", (owner, key)
    ).fetchone()["xp"]


def test_sixty_takes_end_at_the_cap_and_ledger_matches(owner, day):
    for i in range(60):
        progression.award_take(owner, "isl", i)
    snap = progression.snapshot(owner)
    assert snap["xp_today"] == 120 and snap["xp_today_cap"] == 120
    assert snap["xp"] == 120 + 40  # plus first_take
    total, xp = _ledger(owner)
    assert total == xp


def test_partial_clamp_and_replay(owner, day, monkeypatch):
    monkeypatch.setattr(progression, "DAILY_XP_CAP", 35)
    progression.award_take(owner, "isl", 0)  # take 10 + day 20 (+ first_take 40)
    got = progression.award_take(owner, "isl", 1)
    assert got["xp"] == 5
    assert _row_xp(owner, f"take:isl:1:{day}") == 5
    assert progression.snapshot(owner)["xp_today"] == 35
    # A repeat of the same line at the cap pays nothing and writes no XP.
    again = progression.award_take(owner, "isl", 1)
    assert (again["xp"], again["coins"]) == (0, 0)
    assert progression.snapshot(owner)["xp_today"] == 35


def test_coins_stop_at_the_cap_and_milestones_ignore_it(owner, day, monkeypatch):
    monkeypatch.setattr(progression, "DAILY_XP_CAP", 20)
    got = progression.award_take(owner, "isl", 0)
    # take 10 and the day bonus clamped to 10, both inside the cap of 20
    assert progression.snapshot(owner)["xp_today"] == 20
    assert got["xp"] == 20 + 40 and got["capped"] is True
    # A further take at the cap pays no XP, so it pays no coins either: coins
    # track real XP and stop at the cap.
    more = progression.award_take(owner, "isl", 1)
    assert more["xp"] == 0 and more["coins"] == 0


def test_rollover_pays_again(owner, monkeypatch):
    monkeypatch.setattr(progression, "_today", lambda: "2026-01-02")
    progression.award_take(owner, "isl", 0)
    monkeypatch.setattr(progression, "_today", lambda: "2026-01-03")
    assert progression.snapshot(owner)["xp_today"] == 0
    got = progression.award_take(owner, "isl", 0)
    assert got["xp"] >= 10 + 20
    assert progression.snapshot(owner)["xp_today"] > 0


def test_concurrent_takes_end_exactly_at_the_cap(owner, day):
    from concurrent.futures import ThreadPoolExecutor

    with ThreadPoolExecutor(8) as pool:
        list(pool.map(lambda i: progression.award_take(owner, "isl", i), range(30)))
    assert progression.snapshot(owner)["xp_today"] == 120
    total, xp = _ledger(owner)
    assert total == xp


def _seed_days(owner, days):
    for d in days:
        progression.award(owner, f"day:{d}", 20, 5)


def test_streak_of_three_pays_ten(owner, day):
    _seed_days(owner, ["2025-12-31", "2026-01-01"])
    assert progression.snapshot(owner)["streak_days"] == 2
    progression.award_take(owner, "isl", 0)
    assert progression.snapshot(owner)["streak_days"] == 3
    assert _row_xp(owner, f"streak:{day}") == 10


def test_streak_gap_resets(owner, day):
    _seed_days(owner, ["2025-12-30", "2026-01-01"])
    progression.award_take(owner, "isl", 0)
    assert progression.snapshot(owner)["streak_days"] == 2
    row = progression.connect().execute(
        "SELECT 1 FROM awards WHERE owner=? AND key=?", (owner, f"streak:{day}")
    ).fetchone()
    assert row is None


def test_streak_tiers_and_milestones(owner, monkeypatch):
    monkeypatch.setattr(progression, "DAILY_XP_CAP", 1000)
    _seed_days(owner, [f"2025-12-{d}" for d in range(26, 32)] + ["2026-01-01"])  # 7 days before D
    monkeypatch.setattr(progression, "_today", lambda: "2026-01-02")
    got = progression.award_take(owner, "isl", 0)
    assert _row_xp(owner, "streak:2026-01-02") == 20
    assert "streak_7" in got["milestones"]
    monkeypatch.setattr(progression, "_today", lambda: "2026-01-03")
    got = progression.award_take(owner, "isl", 0)
    assert "streak_7" not in got["milestones"]
    assert _row_xp(owner, "streak:2026-01-03") == 20


def test_streak_30_tier(owner, monkeypatch):
    monkeypatch.setattr(progression, "DAILY_XP_CAP", 1000)
    start = date(2026, 1, 2) - timedelta(days=30)
    _seed_days(owner, [(start + timedelta(days=i)).isoformat() for i in range(30)])
    monkeypatch.setattr(progression, "_today", lambda: "2026-01-02")
    got = progression.award_take(owner, "isl", 0)
    assert _row_xp(owner, "streak:2026-01-02") == 30
    assert "streak_30" in got["milestones"]


def test_snapshot_before_practice_keeps_yesterdays_streak(owner, day):
    _seed_days(owner, ["2025-12-31", "2026-01-01"])
    assert progression.snapshot(owner)["streak_days"] == 2


def test_quality_tiers(owner, day):
    five_ok = {"words": ["ok"] * 5}
    three = {"words": ["ok", "ok", "ok", "late", "late"]}
    one = {"words": ["ok", "late", "late", "late", "late"]}
    progression.award(owner, f"day:{day}", 0, 0)  # day bonus out of the way
    got = progression.award_take(owner, "a", 0, score=five_ok)
    # take 10 + quality 5 + 5, first_take 40, perfect_take 60, full_speed 60
    assert got["xp"] == 20 + 40 + 60 + 60
    assert _row_xp(owner, f"quality:a:0:{day}:good") == 5
    assert _row_xp(owner, f"quality:a:0:{day}:great") == 5
    progression.award_take(owner, "b", 0, score=three)
    assert _row_xp(owner, f"quality:b:0:{day}:good") == 5
    assert progression.connect().execute(
        "SELECT 1 FROM awards WHERE owner=? AND key=?", (owner, f"quality:b:0:{day}:great")
    ).fetchone() is None
    keys = lambda isl: [r["key"] for r in progression.connect().execute(
        "SELECT key FROM awards WHERE owner=? AND key LIKE ?", (owner, f"quality:{isl}:%"))]
    progression.award_take(owner, "c", 0, score=one)
    assert keys("c") == []
    progression.award_take(owner, "d", 0, score=1)
    progression.award_take(owner, "e", 0, score={"words": ["ok", "ok"]})
    progression.award_take(owner, "f", 0, score=five_ok, whole_line=False)
    assert keys("d") == [] and keys("e") == [] and keys("f") == []


def test_better_take_later_pays_the_missing_tier(owner, day):
    progression.award_take(owner, "a", 0, score={"words": ["ok", "ok", "ok", "late", "late"]})
    progression.award_take(owner, "a", 0, score={"words": ["ok"] * 5})
    assert _row_xp(owner, f"quality:a:0:{day}:great") == 5


def test_none_words_are_not_scoreable(owner, day):
    progression.award_take(owner, "a", 0, score={"words": ["ok", "ok", "none", "none"]})
    assert progression.connect().execute(
        "SELECT 1 FROM awards WHERE owner=? AND key LIKE 'quality:%'", (owner,)
    ).fetchone() is None


def test_mastery_pays_once_after_every_line_is_great(owner, day, monkeypatch):
    monkeypatch.setattr(progression, "DAILY_XP_CAP", 1000)
    great = {"words": ["ok"] * 4}
    kw = dict(score=great, line_idxs=[0, 1, 2])
    assert "first_mastery" not in progression.award_take(owner, "isl", 0, **kw)["milestones"]
    progression.award_take(owner, "isl", 1, **kw)
    key = "mastery:isl"
    has = lambda: progression.connect().execute(
        "SELECT 1 FROM awards WHERE owner=? AND key=?", (owner, key)).fetchone()
    assert has() is None
    # a phrase take on the last line does not complete it
    progression.award_take(owner, "isl", 2, whole_line=False, **kw)
    assert has() is None
    got = progression.award_take(owner, "isl", 2, **kw)
    assert _row_xp(owner, key) == 60
    assert "first_mastery" in got["milestones"]
    # Mastery and its milestone do not pay twice; only the small repeat does.
    again = progression.award_take(owner, "isl", 2, **kw)
    assert again["xp"] == progression.rep_xp(great) and again["milestones"] == []


def test_mastery_counts_toward_the_cap_and_waits_for_a_day_with_room(owner, monkeypatch):
    great = {"words": ["ok"] * 4}
    kw = dict(score=great, line_idxs=[0])
    monkeypatch.setattr(progression, "_today", lambda: "2026-01-02")
    # Fill the day to the cap with ordinary takes.
    for i in range(30):
        progression.award_take(owner, "other", i, score=None)
    assert progression.snapshot(owner)["xp_today"] == 120
    # Mastering the island at the cap pays no mastery XP and does not consume
    # the once-per-island key, so it is not lost.
    got = progression.award_take(owner, "isl", 0, **kw)
    assert progression.connect().execute(
        "SELECT 1 FROM awards WHERE owner=? AND key='mastery:isl'", (owner,)
    ).fetchone() is None
    assert "first_mastery" not in got["milestones"]
    assert progression.snapshot(owner)["xp_today"] == 120  # still exactly the cap
    # A later day with room pays it in full, and first_mastery fires then.
    monkeypatch.setattr(progression, "_today", lambda: "2026-01-03")
    got2 = progression.award_take(owner, "isl", 0, **kw)
    assert _row_xp(owner, "mastery:isl") == 60
    assert "first_mastery" in got2["milestones"]


def test_mastering_many_one_line_islands_cannot_beat_the_cap(owner, day):
    # The exploit: five one-line islands, each mastered with a perfect take,
    # would pay 5 x 60 = 300 mastery XP a day while mastery was cap-exempt.
    # Mastery now counts toward the cap, so the day's repeatable XP stops at
    # 120 no matter how many one-line islands are mastered.
    great = {"words": ["ok"] * 4}
    for n in range(5):
        progression.award_take(owner, f"isl{n}", 0, score=great, line_idxs=[0])
    assert progression.snapshot(owner)["xp_today"] == 120
    # The ledger never over-counts: day XP equals the sum of capped grants.
    total, xp = _ledger(owner)
    assert total == xp


def test_milestones_pay_once_and_speed_matters(owner, day, monkeypatch):
    monkeypatch.setattr(progression, "DAILY_XP_CAP", 1000)
    good = {"words": ["ok", "ok", "late"]}
    slow = progression.award_take(owner, "a", 0, score=good, speed=0.9)
    assert "full_speed" not in slow["milestones"] and "first_take" in slow["milestones"]
    fast = progression.award_take(owner, "a", 1, score=good, speed=1.0)
    assert fast["milestones"] == ["full_speed"]
    perfect = progression.award_take(owner, "a", 2, score={"words": ["ok"] * 3})
    assert perfect["milestones"] == ["perfect_take"]
    assert progression.award_take(owner, "a", 3, score={"words": ["ok"] * 3})["milestones"] == []


def test_first_take_pays_in_full_at_the_cap(owner, day, monkeypatch):
    monkeypatch.setattr(progression, "DAILY_XP_CAP", 0)
    got = progression.award_take(owner, "a", 0)
    assert got["xp"] == 40 and got["milestones"] == ["first_take"]
    assert progression.snapshot(owner)["xp_today"] == 0


def test_level_milestone_pays_coins_only(owner, day):
    progression.award(owner, "seed", 1000, 0)
    assert progression.level_for(1000) >= 5
    got = progression.award_take(owner, "a", 0)
    assert "level_5" in got["milestones"]
    assert _row_xp(owner, "ms:level_5") == 0


# --- beta tester hat (grant only) ---

HAT = "head.beta_tester_hat"


def test_beta_grant_on_owns_hat_unequipped(owner, monkeypatch):
    monkeypatch.setenv("SHADOW_BETA_GRANT", "1")
    snap = progression.snapshot(owner)
    assert HAT in snap["owned"] and snap["equipped"]["head"] is None


def test_beta_grant_off_grants_nothing(owner, monkeypatch):
    monkeypatch.delenv("SHADOW_BETA_GRANT", raising=False)
    assert progression.snapshot(owner)["owned"] == []


def test_beta_grant_survives_flag_off_and_never_duplicates(owner, monkeypatch):
    monkeypatch.setenv("SHADOW_BETA_GRANT", "1")
    progression.snapshot(owner)
    progression.snapshot(owner)
    monkeypatch.delenv("SHADOW_BETA_GRANT")
    assert progression.snapshot(owner)["owned"] == [HAT]


def test_buy_beta_hat_is_not_for_sale(owner):
    _give(owner, coins=500)
    with pytest.raises(HTTPException) as e:
        progression.buy(owner, HAT)
    assert e.value.status_code == 400 and _code(e.value) == "not_for_sale"
    snap = progression.snapshot(owner)
    assert snap["coins"] == 500 and snap["owned"] == []


def test_equip_unowned_beta_hat_is_refused(owner):
    with pytest.raises(HTTPException) as e:
        progression.equip(owner, "head", HAT)
    assert _code(e.value) == "not_owned"


def test_catalog_lists_beta_hat_as_grant_only():
    item = next(i for i in progression.catalog()["items"] if i["id"] == HAT)
    assert item["grant_only"] is True and item["price"] == 0
