"""Tests for the profile endpoint: OG serials, the practice source split and
the response shape."""

import asyncio
import uuid

import pytest
from fastapi import HTTPException

import main
import progression
import schedule
import store
import user_profile

AUTH = f"Bearer {main.SHADOW_TOKEN}"

KEYS = {
    "username", "serial", "member_since", "level", "xp", "rank", "equipped",
    "streak_days", "longest_streak", "days_active", "best_xp_day", "cap_days",
    "immersion_seconds", "video_seconds", "podcast_seconds", "shadow_seconds",
    "islands_started", "islands_mastered", "lines_practiced", "lines_mastered",
    "average_accuracy", "milestones", "milestones_total",
    "cosmetics_owned", "cosmetics_total",
}


@pytest.fixture(autouse=True)
def _init_db():
    store.init()
    schedule.init()
    progression.init()
    user_profile.init()
    with user_profile.connect() as conn:
        conn.execute("DELETE FROM profiles")
        conn.execute("UPDATE serial_counter SET next=1")


def _id() -> str:
    return uuid.uuid4().hex


def _own(island_id: str, device: str, source: str = "voice") -> None:
    with store.connect() as conn:
        conn.execute(
            "INSERT INTO islands (id, status, created_at, device, source)"
            " VALUES (?, 'ready', '2026-01-01T00:00:00+00:00', ?, ?)",
            (island_id, device, source),
        )


def _post(island_id: str, device: str, seconds: float) -> None:
    asyncio.run(schedule.log_practice(
        island_id=island_id, seconds=seconds, authorization=AUTH, x_shadow_device=device,
    ))


def _serial(owner: str) -> int:
    return user_profile.lookup(user_profile.get_username(owner))["serial"]


def test_serials_increment_survive_rename_and_deletes():
    a, b, c = (f"user_{_id()}" for _ in range(3))
    user_profile.set_username(a, "first_cat")
    user_profile.set_username(b, "second_cat")
    user_profile.set_username(c, "third_cat")
    assert [_serial(o) for o in (a, b, c)] == [1, 2, 3]
    user_profile.set_username(a, "renamed_cat")
    assert _serial(a) == 1
    user_profile.delete_owner(b)
    d = f"user_{_id()}"
    user_profile.set_username(d, "fourth_cat")
    assert _serial(d) == 4


def test_serial_backfill_follows_created_at_and_is_idempotent():
    conn = user_profile.connect()
    rows = [("o3", "cat_c", "2026-03-01"), ("o1", "cat_a", "2026-01-01"), ("o2", "cat_b", "2026-02-01")]
    with conn:
        for owner, name, created in rows:
            conn.execute(
                "INSERT INTO profiles(owner, username, created_at, updated_at, serial)"
                " VALUES(?,?,?,?,NULL)",
                (owner, name, created, created),
            )

    def snap():
        return {r["owner"]: r["serial"] for r in conn.execute("SELECT owner, serial FROM profiles")}

    user_profile.init()
    first = snap()
    assert first == {"o1": 1, "o2": 2, "o3": 3}
    user_profile.init()
    assert snap() == first
    user_profile.set_username("o4", "cat_d")
    assert snap()["o4"] == 4


def test_practice_is_stamped_with_the_island_source():
    dev = f"user_{_id()}"
    yt, pod, voice = _id(), _id(), _id()
    _own(yt, dev, "youtube")
    _own(pod, dev, "podcast")
    _own(voice, dev, "voice")
    _post(yt, dev, 60)
    _post(pod, dev, 60)
    _post(voice, dev, 30)
    res = schedule.immersion(dev)
    assert res["total"] == 150
    assert res["by_source"]["youtube"] == 60
    assert res["by_source"]["podcast"] == 60
    assert res["by_source"]["voice"] == 30


def test_source_backfill_stamps_known_islands_and_is_idempotent():
    dev = f"user_{_id()}"
    known, unknown = _id(), _id()
    _own(known, dev, "podcast")
    with schedule.connect() as conn:
        for iid in (known, unknown):
            conn.execute(
                "INSERT INTO practice_events (island_id, seconds, created_at, device, source)"
                " VALUES (?, 10, '2026-01-01T00:00:00+00:00', ?, '')",
                (iid, dev),
            )

    def sources():
        with schedule.connect() as conn:
            return {
                r["island_id"]: r["source"]
                for r in conn.execute(
                    "SELECT island_id, source FROM practice_events WHERE device=?", (dev,)
                )
            }

    schedule.init()
    assert sources() == {known: "podcast", unknown: ""}
    schedule.init()
    assert sources() == {known: "podcast", unknown: ""}


def _get(name, owner):
    return asyncio.run(main.profile_get(username=name, authorization=AUTH, x_shadow_device=owner))


def test_profile_route_shape_case_insensitive_and_404(monkeypatch):
    monkeypatch.setattr(main, "_all_handles", lambda: user_profile.all_usernames())
    owner = f"user_{_id()}"
    user_profile.set_username(owner, "shape_cat")
    progression.award(owner, f"seed:{_id()}", 100, 0)
    item = progression.catalog()["items"][0]
    with progression.connect() as conn:
        conn.execute("INSERT INTO equipped(owner, slot, item_id) VALUES(?,?,?)", (owner, item["slot"], item["id"]))
    isl = _id()
    _own(isl, owner, "youtube")
    _post(isl, owner, 60)

    res = _get("SHAPE_Cat", owner)
    assert set(res) == KEYS
    assert "owner" not in res
    assert len(res["member_since"]) == 7
    assert res["equipped"][item["slot"]] == item["id"]
    assert res["video_seconds"] == 60
    assert res["islands_started"] == 1
    assert res["rank"] == 1

    with pytest.raises(HTTPException) as e:
        _get("nobody_here", owner)
    assert e.value.status_code == 404


def test_profile_without_progress_is_zeros(monkeypatch):
    monkeypatch.setattr(main, "_all_handles", lambda: user_profile.all_usernames())
    owner = f"user_{_id()}"
    user_profile.set_username(owner, "fresh_cat")
    res = _get("fresh_cat", owner)
    assert res["level"] == 1
    assert res["xp"] == 0
    assert res["milestones"] == []
    assert res["average_accuracy"] is None
    assert res["immersion_seconds"] == 0
    assert res["serial"] == 1
