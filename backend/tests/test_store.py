"""Tests for store.py: the sqlite layer for islands and their lines.

Runs against a real sqlite database in the throwaway directory conftest.py
points SHADOW_DATA_DIR at. Every test gets its own island id from the
island_id fixture, so tests do not depend on each other or on run order.
"""

import sqlite3
import threading
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


def test_create_island_defaults_register_to_polite(island_id):
    # island_id was created without passing register at all.
    island = store.get_island(island_id)
    assert island["register"] == "polite"


def test_create_island_stores_given_register():
    iid = store.create_island("simple", 3, register="casual")
    try:
        island = store.get_island(iid)
        assert island["register"] == "casual"
    finally:
        store.delete_island(iid)


def test_create_island_defaults_language_to_ja(island_id):
    # island_id was created without passing language at all.
    island = store.get_island(island_id)
    assert island["language"] == "ja"


def test_create_island_stores_given_language():
    iid = store.create_island("simple", 3, register="polite", language="es")
    try:
        island = store.get_island(iid)
        assert island["language"] == "es"
        found = next(i for i in store.list_islands() if i["id"] == iid)
        assert found["language"] == "es"
    finally:
        store.delete_island(iid)


def test_init_migrates_islands_missing_language_source_and_offset_columns(tmp_path, monkeypatch):
    # Simulate a database created before the language, source, source_name
    # and offset columns existed: the same tables, minus what this feature
    # (and b1's language column) adds.
    db_path = tmp_path / "old.db"
    raw = sqlite3.connect(db_path)
    raw.execute(
        "CREATE TABLE islands ("
        " id TEXT PRIMARY KEY, title TEXT NOT NULL DEFAULT '',"
        " status TEXT NOT NULL, stage TEXT NOT NULL DEFAULT '',"
        " error TEXT NOT NULL DEFAULT '', complexity TEXT NOT NULL DEFAULT 'simple',"
        " register TEXT NOT NULL DEFAULT 'polite', speaker INTEGER NOT NULL DEFAULT 3,"
        " transcript TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL)"
    )
    raw.execute(
        "CREATE TABLE lines ("
        " island_id TEXT NOT NULL, idx INTEGER NOT NULL, ja TEXT NOT NULL,"
        " kana TEXT NOT NULL DEFAULT '', romaji TEXT NOT NULL DEFAULT '',"
        " en TEXT NOT NULL DEFAULT '', duration REAL NOT NULL DEFAULT 0,"
        " timeline TEXT NOT NULL DEFAULT '[]', words TEXT NOT NULL DEFAULT '[]',"
        " PRIMARY KEY (island_id, idx))"
    )
    raw.execute(
        "INSERT INTO islands (id, status, created_at) VALUES ('old-island', 'ready', 'now')"
    )
    raw.execute(
        "INSERT INTO lines (island_id, idx, ja) VALUES ('old-island', 0, 'line')"
    )
    raw.commit()
    raw.close()

    monkeypatch.setattr(store, "DB_PATH", db_path)
    if hasattr(store._local, "conn"):
        del store._local.conn

    try:
        store.init()
        store.init()  # a second run (a real restart) must not raise on the columns

        island = store.get_island("old-island")
        assert island["language"] == "ja"
        assert island["source"] == "voice"
        assert island["source_name"] == ""
        assert island["lines"][0]["offset"] == 0
    finally:
        if hasattr(store._local, "conn"):
            del store._local.conn


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


def test_create_island_defaults_source_to_voice(island_id):
    island = store.get_island(island_id)
    assert island["source"] == "voice"
    assert island["source_name"] == ""


def test_create_island_stores_given_source_and_source_name():
    iid = store.create_island("simple", 3, source="import", source_name="clip.mp3")
    try:
        island = store.get_island(iid)
        assert island["source"] == "import"
        assert island["source_name"] == "clip.mp3"
        found = next(i for i in store.list_islands() if i["id"] == iid)
        assert found["source"] == "import"
    finally:
        store.delete_island(iid)


def test_add_line_defaults_offset_to_zero_and_stores_given_offset(island_id):
    store.add_line(island_id, 0, {"ja": "a"}, 1.0, [])
    store.add_line(island_id, 1, {"ja": "b"}, 1.0, [], offset=12.5)

    lines = store.get_island(island_id)["lines"]

    assert lines[0]["offset"] == 0
    assert lines[1]["offset"] == 12.5


def test_set_en_updates_only_that_lines_english(island_id):
    store.add_line(island_id, 0, {"ja": "a", "en": "old"}, 1.0, [])
    store.add_line(island_id, 1, {"ja": "b", "en": "old"}, 1.0, [])

    store.set_en(island_id, 0, "new translation")

    lines = store.get_island(island_id)["lines"]
    assert lines[0]["en"] == "new translation"
    assert lines[1]["en"] == "old"
    assert lines[0]["ja"] == "a"  # untouched


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


def test_set_title_updates_only_title(island_id):
    before = store.get_island(island_id)

    store.set_title(island_id, "Renamed island")

    after = store.get_island(island_id)
    assert after["title"] == "Renamed island"
    for key in ("id", "status", "stage", "complexity", "speaker", "transcript", "error", "created_at"):
        assert after[key] == before[key], key


def test_set_words_replaces_words_without_touching_timeline(island_id):
    timeline = [{"text": "あ", "start": 0.0, "end": 0.2}]
    store.add_line(island_id, 0, {"ja": "line"}, 1.0, timeline, [{"text": "old"}])

    store.set_words(island_id, 0, [{"text": "new", "start": 0.0, "end": 1.0}])

    line = store.get_island(island_id)["lines"][0]
    assert line["words"] == [{"text": "new", "start": 0.0, "end": 1.0}]
    assert line["timeline"] == timeline


def test_set_timeline_replaces_timeline_without_touching_words(island_id):
    timeline = [{"text": "あ", "start": 0.0, "end": 0.2}]
    words = [{"text": "old", "start": 0.0, "end": 0.2}]
    store.add_line(island_id, 0, {"ja": "line"}, 1.0, timeline, words)

    new_timeline = [{"text": "あ", "start": 0.0, "end": 0.2, "high": True}]
    store.set_timeline(island_id, 0, new_timeline)

    line = store.get_island(island_id)["lines"][0]
    assert line["timeline"] == new_timeline
    assert line["words"] == words


def test_set_timeline_with_expected_writes_when_unchanged(island_id):
    timeline = [{"text": "あ", "start": 0.0, "end": 0.2}]
    store.add_line(island_id, 0, {"ja": "line"}, 1.0, timeline, [])

    filled = [{**timeline[0], "high": True}]
    assert store.set_timeline(island_id, 0, filled, expected=timeline) is True

    assert store.get_island(island_id)["lines"][0]["timeline"] == filled


def test_set_timeline_with_expected_skips_a_replaced_line(island_id):
    old = [{"text": "あ", "start": 0.0, "end": 0.2}]
    store.add_line(island_id, 0, {"ja": "line"}, 1.0, old, [])
    # A re-voice replaces the line between the backfill's read and its write.
    revoiced = [{"text": "あ", "start": 0.0, "end": 0.3, "high": False}]
    store.add_line(island_id, 0, {"ja": "line"}, 1.0, revoiced, [])

    stale = [{**old[0], "high": True}]
    assert store.set_timeline(island_id, 0, stale, expected=old) is False

    assert store.get_island(island_id)["lines"][0]["timeline"] == revoiced


def test_set_words_with_expected_skips_a_replaced_line(island_id):
    timeline = [{"text": "あ", "start": 0.0, "end": 0.2}]
    store.add_line(island_id, 0, {"ja": "line"}, 1.0, timeline, [])
    fresh = [{"text": "new", "start": 0.0, "end": 0.2, "ruby": []}]
    store.add_line(island_id, 0, {"ja": "line"}, 1.0, timeline, fresh)

    stale = [{"text": "old", "start": 0.0, "end": 0.2, "ruby": []}]
    assert store.set_words(island_id, 0, stale, expected=[]) is False
    assert store.get_island(island_id)["lines"][0]["words"] == fresh

    assert store.set_words(island_id, 0, stale, expected=fresh) is True
    assert store.get_island(island_id)["lines"][0]["words"] == stale


def test_set_with_expected_on_a_missing_line_writes_nothing(island_id):
    assert store.set_words(island_id, 7, [], expected=[]) is False
    assert store.get_island(island_id)["lines"] == []


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


def test_connect_reuses_the_same_connection_on_one_thread():
    # store calls now run from asyncio.to_thread worker threads that get
    # reused across requests, so connect() must hand back the same
    # connection object rather than opening a fresh one every call.
    assert store.connect() is store.connect()


def test_connect_gives_each_thread_its_own_connection():
    other = {}

    def grab():
        other["conn"] = store.connect()

    thread = threading.Thread(target=grab)
    thread.start()
    thread.join()

    assert other["conn"] is not store.connect()


def test_set_timeline_leaves_the_connection_usable_after_a_stale_write(island_id):
    # _set_line_json used to conn.close() the connection it used; now that
    # connect() hands back a cached per-thread connection, a stale write
    # (the early "expected mismatch" return) must roll back and leave that
    # same connection open for the next call on this thread.
    timeline = [{"text": "あ", "start": 0.0, "end": 0.2}]
    store.add_line(island_id, 0, {"ja": "line"}, 1.0, timeline, [])

    stale = [{**timeline[0], "high": True}]
    assert store.set_timeline(island_id, 0, stale, expected=[{"text": "not-it"}]) is False

    # A closed connection would raise sqlite3.ProgrammingError here.
    assert store.get_island(island_id)["lines"][0]["timeline"] == timeline


def test_get_word_context_missing_returns_none():
    assert store.get_word_context("行きます", "学校に行きます。") is None


def test_set_word_context_then_get_round_trips():
    store.set_word_context("行きます", "学校に行きます。", "The polite present form of 行く.")

    assert store.get_word_context("行きます", "学校に行きます。") == (
        "The polite present form of 行く."
    )


def test_set_word_context_twice_overwrites_rather_than_erroring():
    store.set_word_context("行きます", "学校に行きます。", "first answer")
    store.set_word_context("行きます", "学校に行きます。", "second answer")

    assert store.get_word_context("行きます", "学校に行きます。") == "second answer"


def test_set_word_context_is_scoped_to_word_and_sentence_pair():
    store.set_word_context("行きます", "学校に行きます。", "about going to school")
    store.set_word_context("行きます", "公園に行きます。", "about going to the park")

    assert store.get_word_context("行きます", "学校に行きます。") == "about going to school"
    assert store.get_word_context("行きます", "公園に行きます。") == "about going to the park"


def test_get_explain_answer_missing_returns_none():
    assert store.get_explain_answer("学校に行きます。", ["行きます"], "explain this") is None


def test_set_explain_answer_then_get_round_trips():
    store.set_explain_answer(
        "学校に行きます。", ["行きます"], "explain this", "It means 'go', polite present form."
    )

    assert store.get_explain_answer("学校に行きます。", ["行きます"], "explain this") == (
        "It means 'go', polite present form."
    )


def test_set_explain_answer_twice_overwrites_rather_than_erroring():
    store.set_explain_answer("学校に行きます。", ["行きます"], "explain this", "first answer")
    store.set_explain_answer("学校に行きます。", ["行きます"], "explain this", "second answer")

    assert store.get_explain_answer("学校に行きます。", ["行きます"], "explain this") == "second answer"


def test_set_explain_answer_is_scoped_to_sentence_marked_and_question():
    store.set_explain_answer("学校に行きます。", ["行きます"], "explain this", "about going")
    store.set_explain_answer("学校に行きます。", [], "explain this", "about the whole sentence")
    store.set_explain_answer("学校に行きます。", ["行きます"], "why is this polite?", "a different question")

    assert store.get_explain_answer("学校に行きます。", ["行きます"], "explain this") == "about going"
    assert store.get_explain_answer("学校に行きます。", [], "explain this") == "about the whole sentence"
    assert store.get_explain_answer("学校に行きます。", ["行きます"], "why is this polite?") == (
        "a different question"
    )


def test_set_explain_answer_marked_word_order_matters():
    store.set_explain_answer("学校に行きます。", ["行きます", "学校"], "explain this", "order A")
    store.set_explain_answer("学校に行きます。", ["学校", "行きます"], "explain this", "order B")

    assert store.get_explain_answer("学校に行きます。", ["行きます", "学校"], "explain this") == "order A"
    assert store.get_explain_answer("学校に行きます。", ["学校", "行きます"], "explain this") == "order B"
