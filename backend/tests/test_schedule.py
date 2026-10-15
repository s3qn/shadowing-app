"""Tests for spacing.py's pure math and the /shadow/schedule routes in
schedule.py. Calls the route functions directly (plain async def), same
reasoning as test_explain_chat_route.py: no server, no network needed.
"""

import asyncio
from datetime import date

import pytest

import main
import schedule
import spacing
import store


@pytest.fixture(autouse=True)
def _init_db():
    store.init()
    schedule.init()


AUTH = f"Bearer {main.SHADOW_TOKEN}"
DEV = "dev-a"


def _own(island_id: str, device: str = DEV) -> None:
    """Make `device` own `island_id` in the store, so a practice post for it
    passes the ownership check. A practice post is now accepted only for an
    island the caller owns."""
    with store.connect() as conn:
        conn.execute(
            "INSERT INTO islands (id, status, created_at, device)"
            " VALUES (?, 'ready', '2026-01-01T00:00:00+00:00', ?)"
            " ON CONFLICT(id) DO UPDATE SET device = excluded.device",
            (island_id, device),
        )


def _freeze(monkeypatch, day: str) -> None:
    """Puts the module on a given UTC day. Both clocks move together: the
    day counting reads _today, the event rows are stamped by _now and are
    counted back by the first ten characters of that stamp."""
    monkeypatch.setattr(schedule, "_today", lambda: day)
    monkeypatch.setattr(schedule, "_now", lambda: f"{day}T12:00:00+00:00")


def test_due_date_advances_by_the_ladder():
    assert spacing.due_date(date(2026, 1, 1), 0) == date(2026, 1, 1)
    assert spacing.due_date(date(2026, 1, 1), 1) == date(2026, 1, 2)
    assert spacing.due_date(date(2026, 1, 1), 3) == date(2026, 1, 5)


def test_due_date_clamps_past_max_level():
    far_future_level = spacing.MAX_LEVEL + 5
    assert spacing.due_date(date(2026, 1, 1), far_future_level) == spacing.due_date(
        date(2026, 1, 1), spacing.MAX_LEVEL
    )


def test_posting_one_long_practice_event_creates_a_level_one_row_due_tomorrow():
    _own("island-a")
    result = asyncio.run(schedule.log_practice(
        island_id="island-a", seconds=60.0, authorization=AUTH, x_shadow_device=DEV,
    ))

    assert result["level"] == 1
    today = date.today()
    assert result["due_on"] == spacing.due_date(today, 1).isoformat()


def test_a_short_event_leaves_the_island_at_level_zero_and_still_due_today():
    _own("island-short")
    result = asyncio.run(schedule.log_practice(
        island_id="island-short", seconds=30.0, authorization=AUTH, x_shadow_device=DEV,
    ))

    assert result["level"] == 0
    due = asyncio.run(schedule.due_today(authorization=AUTH, x_shadow_device=DEV))
    assert "island-short" in {row["island_id"] for row in due}


def test_two_short_events_the_same_day_add_up_to_one_move():
    _own("island-sum")
    for _ in range(2):
        result = asyncio.run(schedule.log_practice(
            island_id="island-sum", seconds=30.0, authorization=AUTH, x_shadow_device=DEV,
        ))

    assert result["level"] == 1
    assert result["due_on"] == spacing.due_date(date.today(), 1).isoformat()


def test_a_whole_sitting_moves_the_level_only_once():
    _own("island-sitting")
    # What one sitting really posts: a flush every 15s of playback.
    for _ in range(12):
        result = asyncio.run(schedule.log_practice(
            island_id="island-sitting", seconds=15.0, authorization=AUTH, x_shadow_device=DEV,
        ))

    assert result["level"] == 1
    assert result["seconds_today"] == 180.0


def test_the_next_day_moves_the_island_one_more_level(monkeypatch):
    _own("island-b")
    _freeze(monkeypatch, "2026-03-01")
    asyncio.run(schedule.log_practice(
        island_id="island-b", seconds=60.0, authorization=AUTH, x_shadow_device=DEV,
    ))
    _freeze(monkeypatch, "2026-03-02")
    result = asyncio.run(schedule.log_practice(
        island_id="island-b", seconds=60.0, authorization=AUTH, x_shadow_device=DEV,
    ))

    assert result["level"] == 2
    assert result["due_on"] == "2026-03-04"


def test_a_practice_long_after_the_due_date_drops_one_level(monkeypatch):
    _own("lapsed")
    _freeze(monkeypatch, "2026-03-11")
    with schedule.connect() as conn:
        conn.execute(
            "INSERT INTO schedule_state"
            " (island_id, level, due_on, last_practiced_on, updated_at, device, moved_on)"
            " VALUES ('lapsed', 3, '2026-03-01', '2026-02-26', '2026-02-26T00:00:00+00:00', ?, '2026-02-26')",
            (DEV,),
        )

    result = asyncio.run(schedule.log_practice(
        island_id="lapsed", seconds=45.0, authorization=AUTH, x_shadow_device=DEV,
    ))

    assert result["level"] == 2
    assert result["due_on"] == "2026-03-13"


def test_a_row_written_before_the_migration_still_moves(monkeypatch):
    _own("old-row")
    _freeze(monkeypatch, "2026-04-05")
    # A pre-migration row has no moved_on: the column default is the empty
    # string, which is no day, so today's practice is free to move it.
    with schedule.connect() as conn:
        conn.execute(
            "INSERT INTO schedule_state"
            " (island_id, level, due_on, last_practiced_on, updated_at, device)"
            " VALUES ('old-row', 2, '2026-04-04', '2026-04-02', '2026-04-02T00:00:00+00:00', ?)",
            (DEV,),
        )

    first = asyncio.run(schedule.log_practice(
        island_id="old-row", seconds=60.0, authorization=AUTH, x_shadow_device=DEV,
    ))
    second = asyncio.run(schedule.log_practice(
        island_id="old-row", seconds=60.0, authorization=AUTH, x_shadow_device=DEV,
    ))

    assert first["level"] == 3
    assert second["level"] == 3
    assert second["due_on"] == "2026-04-09"


def test_next_level_lapses_past_one_whole_interval():
    assert spacing.next_level(3, days_late=5) == 2
    assert spacing.next_level(3, days_late=4) == 4
    assert spacing.next_level(0, days_late=9) == 1


def test_due_today_omits_an_island_due_tomorrow_and_one_due_next_week():
    _own("due-soon")
    asyncio.run(schedule.log_practice(
        island_id="due-soon", seconds=60.0, authorization=AUTH, x_shadow_device=DEV,
    ))
    # A row already high up the ladder, the state five practice days would
    # leave behind; getting there day by day is test_the_next_day_moves...
    with schedule.connect() as conn:
        conn.execute(
            "INSERT INTO schedule_state"
            " (island_id, level, due_on, last_practiced_on, updated_at, device, moved_on)"
            " VALUES ('due-later', 5, '2099-01-01', '2026-01-01', '2026-01-01T00:00:00+00:00', ?, '2026-01-01')",
            (DEV,),
        )

    due = asyncio.run(schedule.due_today(authorization=AUTH, x_shadow_device=DEV))
    ids = {row["island_id"] for row in due}

    assert "due-soon" not in ids  # due tomorrow, not today
    assert "due-later" not in ids


def test_due_today_includes_an_island_due_today_or_earlier(monkeypatch):
    with schedule.connect() as conn:
        conn.execute(
            "INSERT INTO schedule_state (island_id, level, due_on, last_practiced_on, updated_at, device)"
            " VALUES ('already-due', 1, '2000-01-01', '2000-01-01', '2000-01-01T00:00:00+00:00', ?)",
            (DEV,),
        )

    due = asyncio.run(schedule.due_today(authorization=AUTH, x_shadow_device=DEV))
    ids = {row["island_id"] for row in due}

    assert "already-due" in ids


def test_due_today_omits_another_devices_row():
    with schedule.connect() as conn:
        conn.execute(
            "INSERT INTO schedule_state (island_id, level, due_on, last_practiced_on, updated_at, device)"
            " VALUES ('someone-elses', 1, '2000-01-01', '2000-01-01', '2000-01-01T00:00:00+00:00', 'dev-b')"
        )

    due = asyncio.run(schedule.due_today(authorization=AUTH, x_shadow_device=DEV))
    ids = {row["island_id"] for row in due}

    assert "someone-elses" not in ids


def test_zero_or_negative_seconds_is_a_400():
    with pytest.raises(Exception) as exc_info:
        asyncio.run(schedule.log_practice(
            island_id="island-c", seconds=0, authorization=AUTH, x_shadow_device=DEV,
        ))
    assert getattr(exc_info.value, "status_code", None) == 400


def test_missing_token_on_practice_is_401():
    with pytest.raises(Exception) as exc_info:
        asyncio.run(schedule.log_practice(
            island_id="island-d", seconds=10.0, authorization=None, x_shadow_device=DEV,
        ))
    assert getattr(exc_info.value, "status_code", None) == 401


def test_bad_token_on_due_today_is_401():
    with pytest.raises(Exception) as exc_info:
        asyncio.run(schedule.due_today(authorization="Bearer wrong", x_shadow_device=DEV))
    assert getattr(exc_info.value, "status_code", None) == 401


def test_missing_device_on_practice_is_401():
    with pytest.raises(Exception) as exc_info:
        asyncio.run(schedule.log_practice(
            island_id="island-e", seconds=10.0, authorization=AUTH, x_shadow_device="",
        ))
    assert getattr(exc_info.value, "status_code", None) == 401


def test_another_devices_practice_post_is_refused_and_leaves_the_owners_row():
    _own("island-owned", DEV)
    asyncio.run(schedule.log_practice(
        island_id="island-owned", seconds=60.0, authorization=AUTH, x_shadow_device=DEV,
    ))
    with schedule.connect() as conn:
        before = dict(conn.execute(
            "SELECT level, due_on, device FROM schedule_state WHERE island_id = 'island-owned'"
        ).fetchone())

    # A stranger does not own the island, so the post is refused outright: it
    # never writes a row and never pays an award.
    with pytest.raises(Exception) as exc_info:
        asyncio.run(schedule.log_practice(
            island_id="island-owned", seconds=60.0, authorization=AUTH, x_shadow_device="dev-b",
        ))
    assert getattr(exc_info.value, "status_code", None) == 404

    with schedule.connect() as conn:
        after = dict(conn.execute(
            "SELECT level, due_on, device FROM schedule_state WHERE island_id = 'island-owned'"
        ).fetchone())
    assert after == before
    assert after["device"] == DEV


def test_a_made_up_island_id_is_a_404_and_pays_nothing():
    import progression

    owner = "dev-fresh"
    with pytest.raises(Exception) as exc_info:
        asyncio.run(schedule.log_practice(
            island_id="not-a-real-island", seconds=60.0, authorization=AUTH, x_shadow_device=owner,
        ))
    assert getattr(exc_info.value, "status_code", None) == 404
    # Nothing was written to the schedule, and no XP or coins were awarded.
    with schedule.connect() as conn:
        rows = conn.execute(
            "SELECT COUNT(*) AS n FROM practice_events WHERE device=?", (owner,)
        ).fetchone()["n"]
    assert rows == 0
    snap = progression.snapshot(owner)
    assert snap["xp"] == 0 and snap["coins"] == 0


def test_an_island_owned_by_another_device_is_a_404():
    _own("someone-elses", "dev-b")
    with pytest.raises(Exception) as exc_info:
        asyncio.run(schedule.log_practice(
            island_id="someone-elses", seconds=60.0, authorization=AUTH, x_shadow_device=DEV,
        ))
    assert getattr(exc_info.value, "status_code", None) == 404


def test_non_finite_seconds_is_a_400():
    _own("island-nan")
    for bad in (float("nan"), float("inf"), float("-inf")):
        with pytest.raises(Exception) as exc_info:
            asyncio.run(schedule.log_practice(
                island_id="island-nan", seconds=bad, authorization=AUTH, x_shadow_device=DEV,
            ))
        assert getattr(exc_info.value, "status_code", None) == 400


def test_seconds_past_the_per_request_cap_is_a_400():
    _own("island-huge")
    with pytest.raises(Exception) as exc_info:
        asyncio.run(schedule.log_practice(
            island_id="island-huge", seconds=schedule.MAX_PRACTICE_SECONDS + 1,
            authorization=AUTH, x_shadow_device=DEV,
        ))
    assert getattr(exc_info.value, "status_code", None) == 400


@pytest.mark.parametrize("source", ["youtube", "podcast"])
def test_youtube_and_podcast_practice_counts_but_leaves_the_schedule_alone(source):
    _own(f"island-{source}")
    with store.connect() as conn:
        conn.execute("UPDATE islands SET source=? WHERE id=?", (source, f"island-{source}"))
    result = asyncio.run(schedule.log_practice(
        island_id=f"island-{source}", seconds=120.0, authorization=AUTH, x_shadow_device=DEV,
    ))
    assert result["seconds_today"] >= 120.0
    with schedule.connect() as conn:
        n = conn.execute(
            "SELECT COUNT(*) FROM schedule_state WHERE island_id=?", (f"island-{source}",)
        ).fetchone()[0]
        secs = conn.execute(
            "SELECT SUM(seconds) FROM practice_events WHERE island_id=?", (f"island-{source}",)
        ).fetchone()[0]
    assert n == 0
    assert secs >= 120.0


def test_podcast_island_is_left_out_of_due_today_but_voice_stays():
    for name, source in (("island-pod", "podcast"), ("island-voice", "voice")):
        _own(name)
        with store.connect() as conn:
            conn.execute("UPDATE islands SET source=? WHERE id=?", (source, name))
        asyncio.run(schedule.log_practice(
            island_id=name, seconds=30.0, authorization=AUTH, x_shadow_device=DEV,
        ))
    due = {r["island_id"] for r in asyncio.run(
        schedule.due_today(authorization=AUTH, x_shadow_device=DEV))}
    assert "island-voice" in due
    assert "island-pod" not in due
