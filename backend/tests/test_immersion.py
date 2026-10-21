"""Immersion: honest minutes (daily max, app_state, language stamp), the
slow XP tail, the hours ladder, secret awards and rarity. Direct calls, no
server. conftest points SHADOW_DATA_DIR at a throwaway directory."""

import asyncio
import uuid
from datetime import datetime, timedelta, timezone

import pytest
from fastapi import HTTPException

import main
import progression
import schedule
import store

AUTH = f"Bearer {main.SHADOW_TOKEN}"


@pytest.fixture(autouse=True)
def _init_db():
    store.init()
    schedule.init()
    progression.init()


@pytest.fixture
def owner():
    return f"user_{uuid.uuid4().hex}"


def _island(device, source="podcast", language="ja", source_name="", video_s=0.0):
    isl = uuid.uuid4().hex
    with store.connect() as conn:
        conn.execute(
            "INSERT INTO islands (id, status, created_at, device, source, source_name, language)"
            " VALUES (?, 'ready', '2026-01-01T00:00:00+00:00', ?, ?, ?, ?)",
            (isl, device, source, source_name, language),
        )
        if video_s:
            conn.execute(
                "INSERT INTO videos (island_id, video_id, duration, created_at)"
                " VALUES (?, 'v', ?, '2026-01-01T00:00:00+00:00')",
                (isl, video_s),
            )
    return isl


def _post(isl, device, seconds, app_state=""):
    return asyncio.run(schedule.log_practice(
        island_id=isl, seconds=seconds, app_state=app_state,
        authorization=AUTH, x_shadow_device=device,
    ))


def _events(isl):
    return schedule.connect().execute(
        "SELECT language, app_state FROM practice_events WHERE island_id=?", (isl,)
    ).fetchall()


# --- honest minutes ---


def test_language_and_app_state_are_stamped(owner):
    isl = _island(owner, language="es")
    _post(isl, owner, 30, app_state="background")
    _post(isl, owner, 30, app_state="nonsense")
    rows = _events(isl)
    assert [r["language"] for r in rows] == ["es", "es"]
    assert [r["app_state"] for r in rows] == ["background", ""]


def test_language_backfill_on_init(owner):
    isl = _island(owner, language="ko")
    with schedule.connect() as conn:
        conn.execute(
            "INSERT INTO practice_events (island_id, seconds, created_at, device, language)"
            " VALUES (?, 10, ?, ?, '')",
            (isl, schedule._now(), owner),
        )
    schedule.init()
    schedule.init()
    assert [r["language"] for r in _events(isl)] == ["ko"]


def test_counted_today_stops_at_the_daily_max_and_total_keeps_growing(owner):
    isl = _island(owner)
    outs = [_post(isl, owner, 3600) for _ in range(4)]
    assert [o["counted_today_seconds"] for o in outs] == [3600, 7200, 10800, 10800]
    assert [o["total_seconds"] for o in outs] == [3600, 7200, 10800, 14400]
    assert outs[-1]["daily_max_seconds"] == schedule.DAILY_MAX_SECONDS == 10800
    imm = schedule.immersion(owner)
    assert imm["today"] == 14400 and imm["counted_today"] == 10800
    assert imm["by_language"] == {"ja": 14400}


def test_a_post_over_an_hour_is_still_refused(owner):
    isl = _island(owner)
    with pytest.raises(HTTPException) as e:
        _post(isl, owner, 3601)
    assert e.value.status_code == 400


def test_forged_hour_posts_pay_one_day_of_hours_at_most(owner):
    """The BL-22 forge: 100 posts of 3600 s in one day. Only the daily max
    counts toward the hours ladder, so one day reaches the first rung and no
    other, and the daily XP stays at its cap. The shown total stays uncapped."""
    isl = _island(owner)
    xp0 = progression.snapshot(owner)["xp"]
    outs = [_post(isl, owner, 3600, app_state="background") for _ in range(100)]
    last = outs[-1]
    assert last["total_seconds"] == 100 * 3600
    assert last["counted_total_seconds"] == schedule.DAILY_MAX_SECONDS == 3 * 3600
    # Healing on read pays on the counted seconds too, not the shown ones.
    prog = asyncio.run(main.get_progress(authorization=AUTH, x_shadow_device=owner))
    cat = asyncio.run(main.cosmetics_catalog(ui="en", authorization=AUTH, x_shadow_device=owner))
    assert prog["listened_seconds"] == 100 * 3600 and prog["counted_seconds"] == 3 * 3600
    assert cat["listened_hours"] == 100 and cat["counted_hours"] == 3
    rungs = {m for m in progression.earned_milestones(owner) if m.startswith("hours_")}
    counted_hours = last["counted_total_seconds"] / 3600
    assert counted_hours <= 3
    assert len(rungs) <= max(1, int(counted_hours // 3))
    assert rungs == {"hours_1"}
    hours_items = set(progression.HOURS_ITEMS.values()) & set(prog["owned"])
    assert hours_items <= {progression.HOURS_ITEMS[1]}
    snap = progression.snapshot(owner)
    assert snap["xp_today"] == 120
    milestone_xp = sum(progression.MILESTONES[m][0] for m in progression.earned_milestones(owner))
    # Past the daily cap only the slow tail pays: at most one XP per counted minute.
    assert snap["xp"] - xp0 <= 120 + milestone_xp + progression.DAILY_MINUTES_MAX
    assert progression.hours_next(last["counted_total_seconds"])["hours"] == 10


def test_minutes_cap_at_180_across_islands(owner):
    a, b = _island(owner), _island(owner)
    for isl in (a, b, a, b):
        _post(isl, owner, 3600)
    n = progression.connect().execute(
        "SELECT COUNT(*) AS n FROM awards WHERE owner=? AND key LIKE 'minute:%'", (owner,)
    ).fetchone()["n"]
    assert n == progression.DAILY_MINUTES_MAX == 180


# --- the slow tail ---


def test_slow_tail_pays_one_per_line_and_per_minute(owner):
    i = 0
    while progression.snapshot(owner)["xp_today"] < 120:
        progression.award_take(owner, "isl", i)
        i += 1
    slow = progression.snapshot(owner)["xp_today_slow"]
    line = progression.award_take(owner, "isl", i)
    assert (line["xp"], line["coins"]) == (1, 0)
    minute = progression.award_practice(owner, "isl", 10, owner_seconds_today=60)
    assert (minute["xp"], minute["coins"]) == (1, 0)
    snap = progression.snapshot(owner)
    assert snap["xp_today"] == 120
    assert snap["xp_today_slow"] == slow + 2


def test_a_pure_listener_fills_the_band_at_40_minutes(owner):
    # day 20 + practiced 20 + 40 minutes x 2 = 120
    progression.award_practice(owner, "isl", 40 * 60)
    snap = progression.snapshot(owner)
    assert snap["xp_today"] == 120 and snap["xp_today_slow"] == 0
    first = progression.award_practice(owner, "isl", 41 * 60)
    assert progression.snapshot(owner)["xp_today_slow"] == 1
    assert first["cap_note"] is True
    assert progression.award_practice(owner, "isl", 42 * 60)["cap_note"] is False


# --- hours ladder ---


def test_hours_10_pays_once_and_owns_its_item(owner):
    got = progression.award_practice(owner, "isl", 10, total_seconds=10 * 3600)
    assert {"hours_1", "hours_10"} <= set(got["milestones"])
    owned = progression.snapshot(owner)["owned"]
    assert {"accessory.bell_sprout", "accessory.bowtie_tide"} <= set(owned)
    again = progression.award_practice(owner, "isl", 10, total_seconds=10 * 3600 + 5)
    assert again["milestones"] == []
    n = progression.connect().execute(
        "SELECT COUNT(*) AS n FROM awards WHERE owner=? AND key='ms:hours_10'", (owner,)
    ).fetchone()["n"]
    assert n == 1


def test_grant_hours_heals_and_then_writes_nothing(owner):
    progression.grant_hours(owner, 3700)
    snap = progression.snapshot(owner)
    assert "accessory.bell_sprout" in snap["owned"]
    assert snap["xp"] == progression.MILESTONES["hours_1"][0]
    progression.grant_hours(owner, 3700)
    assert progression.snapshot(owner)["xp"] == snap["xp"]
    progression.grant_hours(owner, 100)
    assert progression.hours_next(3700)["item_id"] == "accessory.bowtie_tide"
    assert progression.hours_next(1000 * 3600) is None


def test_buy_an_hours_item_is_hours_locked(owner):
    progression.award(owner, "seed", 10000, 5000)
    with pytest.raises(HTTPException) as e:
        progression.buy(owner, "accessory.bowtie_tide")
    assert e.value.status_code == 400
    assert e.value.detail == {"code": "hours_locked", "hours_req": 10}
    assert "accessory.bowtie_tide" not in progression.snapshot(owner)["owned"]


def _users():
    return progression.connect().execute(
        "SELECT COUNT(DISTINCT owner) AS n FROM progress"
    ).fetchone()["n"]


def test_owned_pct_is_null_under_the_user_floor(monkeypatch):
    monkeypatch.setattr(progression, "RARITY_MIN_USERS", _users() + 1)
    items = progression.catalog("en")["items"]
    hours = [i for i in items if "hours_req" in i]
    assert len(hours) == 8 and all(i["owned_pct"] is None for i in hours)
    assert all("owned_pct" not in i and "hours_req" not in i for i in items if i not in hours)


def test_owned_pct_is_a_number_at_the_user_floor():
    for _ in range(max(0, progression.RARITY_MIN_USERS - _users())):
        progression.award(f"user_{uuid.uuid4().hex}", "seed", 1, 0)
    o = f"user_{uuid.uuid4().hex}"
    progression.grant_hours(o, 3600)
    pct = {i["id"]: i["owned_pct"] for i in progression.catalog("en")["items"] if "hours_req" in i}
    assert all(isinstance(v, int) and 0 <= v <= 100 for v in pct.values())


def test_catalog_route_carries_listened_hours(owner):
    isl = _island(owner)
    _post(isl, owner, 3600)
    _post(isl, owner, 360)
    out = asyncio.run(main.cosmetics_catalog(ui="en", authorization=AUTH, x_shadow_device=owner))
    assert out["listened_hours"] == 1.1
    prog = asyncio.run(main.get_progress(authorization=AUTH, x_shadow_device=owner))
    assert prog["listened_seconds"] == 3960
    assert "accessory.bell_sprout" in prog["owned"]


# --- secret awards ---


def _ms(out):
    return out["award"]["milestones"]


def test_replay_10_fires_once(owner):
    isl = _island(owner, source="youtube", video_s=60)
    assert "replay_10" not in _ms(_post(isl, owner, 590))
    assert "replay_10" in _ms(_post(isl, owner, 10))
    assert "replay_10" not in _ms(_post(isl, owner, 600))


def test_replay_10_ignores_voice_islands(owner):
    isl = _island(owner, source="voice", video_s=60)
    assert "replay_10" not in _ms(_post(isl, owner, 700))


def test_marathon_60_fires_once_on_one_unbroken_run(owner):
    isl = _island(owner, source="podcast", video_s=3600)
    start = datetime.now(timezone.utc).replace(hour=0, minute=0, second=0, microsecond=0)
    with schedule.connect() as conn:
        for i in range(11):
            at = (start + timedelta(minutes=5 * i)).isoformat(timespec="seconds")
            conn.execute(
                "INSERT INTO practice_events (island_id, seconds, created_at, device, source)"
                " VALUES (?, 300, ?, ?, 'podcast')",
                (isl, at, owner),
            )
    assert "marathon_60" in _ms(_post(isl, owner, 10))
    assert "marathon_60" not in _ms(_post(isl, owner, 10))


def test_marathon_60_needs_no_long_gap(owner):
    isl = _island(owner, source="podcast", video_s=3600)
    start = datetime.now(timezone.utc).replace(hour=0, minute=0, second=0, microsecond=0)
    with schedule.connect() as conn:
        for i in range(11):
            # 20 minutes apart: every gap is over 600 s, so no run sums to 0.9 h
            at = (start + timedelta(minutes=20 * i)).isoformat(timespec="seconds")
            conn.execute(
                "INSERT INTO practice_events (island_id, seconds, created_at, device, source)"
                " VALUES (?, 300, ?, ?, 'podcast')",
                (isl, at, owner),
            )
    assert "marathon_60" not in _ms(_post(isl, owner, 10))


def test_three_channels_fires_once(owner):
    isls = [_island(owner, source_name=f"show {n}") for n in range(3)]
    assert "three_channels" not in _ms(_post(isls[0], owner, 300))
    assert "three_channels" not in _ms(_post(isls[1], owner, 300))
    assert "three_channels" in _ms(_post(isls[2], owner, 300))
    assert "three_channels" not in _ms(_post(isls[2], owner, 300))


def test_three_channels_needs_distinct_names(owner):
    isls = [_island(owner, source_name="same show") for _ in range(3)]
    for isl in isls:
        assert "three_channels" not in _ms(_post(isl, owner, 300))


def test_achievements_name_a_secret_once_earned(owner):
    isl = _island(owner, source="youtube", video_s=60)
    _post(isl, owner, 600)
    ach = {a["id"]: a for a in progression.achievements(owner, "en")}
    assert ach["replay_10"]["name"] == "Heard it ten times" and ach["replay_10"]["earned_at"]
    assert ach["marathon_60"]["name"] is None and ach["marathon_60"]["secret"] is True
