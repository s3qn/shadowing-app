"""Tests for store.py: the sqlite layer for islands and their lines.

Runs against a real sqlite database in the throwaway directory conftest.py
points SHADOW_DATA_DIR at. Every test gets its own island id from the
island_id fixture, so tests do not depend on each other or on run order.
"""

from pathlib import Path

import pytest

import store


@pytest.fixture(autouse=True)
def _init_db():
    store.init()


@pytest.fixture
def island_id():
    iid = store.create_island("simple", 3)
    yield iid
    store.delete_island(iid)


def test_create_island_then_get_island(island_id):
    island = store.get_island(island_id)
    assert island is not None
    assert island["id"] == island_id
    assert island["complexity"] == "simple"
    assert island["speaker"] == 3
    assert island["status"] == "pending"
    assert island["lines"] == []


def test_get_island_missing_id_returns_none():
    assert store.get_island("does-not-exist") is None


def test_add_line_stores_timeline_and_words_in_idx_order(island_id):
    timeline0 = [{"text": "お", "start": 0.0, "end": 0.1}]
    words0 = [{"text": "起きます", "start": 0.0, "end": 0.5}]
    # Insert idx 1 first so order can only come from ORDER BY idx, not insert order.
    store.add_line(island_id, 1, {"ja": "second"}, 1.0, [{"text": "x"}], [{"text": "y"}])
    store.add_line(
        island_id, 0,
        {"ja": "first", "kana": "k", "romaji": "r", "en": "e"},
        0.5, timeline0, words0,
    )

    lines = store.get_island(island_id)["lines"]

    assert [line["idx"] for line in lines] == [0, 1]
    first = lines[0]
    assert first["ja"] == "first"
    assert first["kana"] == "k"
    assert first["romaji"] == "r"
    assert first["en"] == "e"
    assert isinstance(first["timeline"], list)
    assert isinstance(first["words"], list)
    assert first["timeline"] == timeline0
    assert first["words"] == words0


def test_add_line_defaults_words_to_empty_list(island_id):
    store.add_line(island_id, 0, {"ja": "line"}, 1.0, [])
    line = store.get_island(island_id)["lines"][0]
    assert line["words"] == []


def test_set_stage_updates_status_and_stage_only(island_id):
    before = store.get_island(island_id)

    store.set_stage(island_id, "transcribing")

    after = store.get_island(island_id)
    assert after["status"] == "working"
    assert after["stage"] == "transcribing"
    for key in ("id", "title", "complexity", "speaker", "transcript", "error", "created_at"):
        assert after[key] == before[key], key


def test_set_failed_sets_status_clears_stage_and_sets_error(island_id):
    store.set_stage(island_id, "transcribing")
    before = store.get_island(island_id)

    store.set_failed(island_id, "whisper crashed")

    after = store.get_island(island_id)
    assert after["status"] == "failed"
    assert after["stage"] == ""
    assert after["error"] == "whisper crashed"
    for key in ("id", "title", "complexity", "speaker", "transcript", "created_at"):
        assert after[key] == before[key], key


def test_set_transcript_updates_only_transcript(island_id):
    before = store.get_island(island_id)

    store.set_transcript(island_id, "I went to the store today.")

    after = store.get_island(island_id)
    assert after["transcript"] == "I went to the store today."
    for key in ("id", "title", "status", "stage", "complexity", "speaker", "error", "created_at"):
        assert after[key] == before[key], key


def test_set_speaker_updates_only_speaker(island_id):
    before = store.get_island(island_id)

    store.set_speaker(island_id, 7)

    after = store.get_island(island_id)
    assert after["speaker"] == 7
    for key in ("id", "title", "status", "stage", "complexity", "transcript", "error", "created_at"):
        assert after[key] == before[key], key


def test_set_ready_sets_status_clears_stage_and_sets_title(island_id):
    store.set_stage(island_id, "synthesizing")
    before = store.get_island(island_id)

    store.set_ready(island_id, "Morning routine")

    after = store.get_island(island_id)
    assert after["status"] == "ready"
    assert after["stage"] == ""
    assert after["title"] == "Morning routine"
    for key in ("id", "complexity", "speaker", "transcript", "error", "created_at"):
        assert after[key] == before[key], key


def test_set_words_replaces_words_without_touching_timeline(island_id):
    timeline = [{"text": "あ", "start": 0.0, "end": 0.2}]
    store.add_line(island_id, 0, {"ja": "line"}, 1.0, timeline, [{"text": "old"}])

    store.set_words(island_id, 0, [{"text": "new", "start": 0.0, "end": 1.0}])

    line = store.get_island(island_id)["lines"][0]
    assert line["words"] == [{"text": "new", "start": 0.0, "end": 1.0}]
    assert line["timeline"] == timeline


def test_clear_lines_empties_lines_but_keeps_island(island_id):
    store.add_line(island_id, 0, {"ja": "a"}, 1.0, [], [])
    store.add_line(island_id, 1, {"ja": "b"}, 1.0, [], [])

    store.clear_lines(island_id)

    island = store.get_island(island_id)
    assert island is not None
    assert island["lines"] == []


def test_delete_island_cascades_lines_and_hides_from_list(island_id):
    store.add_line(island_id, 0, {"ja": "a"}, 1.0, [], [])

    store.delete_island(island_id)

    assert store.get_island(island_id) is None
    assert island_id not in [i["id"] for i in store.list_islands()]
    # Confirm the FOREIGN KEY cascade actually removed the row rather than
    # leaving it orphaned (get_island would also return None for an island
    # whose lines just failed to join).
    with store.connect() as conn:
        rows = conn.execute(
            "SELECT * FROM lines WHERE island_id=?", (island_id,)
        ).fetchall()
    assert rows == []


def test_list_islands_includes_created_island_with_line_count(island_id):
    store.add_line(island_id, 0, {"ja": "a"}, 1.0, [], [])
    store.add_line(island_id, 1, {"ja": "b"}, 1.0, [], [])

    found = next(i for i in store.list_islands() if i["id"] == island_id)

    assert found["line_count"] == 2


def test_line_audio_path_and_take_paths_stay_under_test_data_dir(island_id):
    audio_path = store.line_audio_path(island_id, 0)
    raw_path, clean_path = store.take_paths(island_id, 0)

    # This is the guard that keeps a future test from writing into the real
    # ~/shadowing-data island store: every path handed to callers must resolve
    # under the throwaway directory conftest.py set SHADOW_DATA_DIR to.
    for path in (audio_path, raw_path, clean_path):
        assert store.DATA_DIR in path.parents
    assert store.DATA_DIR != Path.home() / "shadowing-data"
