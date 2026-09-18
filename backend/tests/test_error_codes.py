"""Tests for the machine-readable error codes on failed islands and on the
HTTPException details a user reads: store.set_failed / get_island round trip,
the pre-migration read path, and the dict details on the 413 and 502 routes.

No VOICEVOX, whisper or claude CLI: voices.list_speakers is monkeypatched.
"""

import asyncio
import sqlite3

import pytest
from fastapi import BackgroundTasks, HTTPException

import main
import store

AUTH = f"Bearer {main.SHADOW_TOKEN}"
DEV = "dddddddd-0000-4000-8000-000000000004"


@pytest.fixture(autouse=True)
def _init_db():
    store.init()


class _FakeUpload:
    def __init__(self, data: bytes = b"fake audio"):
        self._data = data
        self.filename = "rec.wav"

    async def read(self) -> bytes:
        return self._data


def test_set_failed_stores_code_and_get_island_returns_it():
    island_id = store.create_island("simple", 3)
    store.set_failed(island_id, "No lines could be generated.", "no_lines")

    island = store.get_island(island_id)
    assert island["error"] == "No lines could be generated."
    assert island["error_code"] == "no_lines"


def test_set_failed_without_a_code_defaults_to_empty_string():
    island_id = store.create_island("simple", 3)
    store.set_failed(island_id, "boom")

    island = store.get_island(island_id)
    assert island["error_code"] == ""


def test_a_failed_island_from_before_the_migration_reads_empty_error_code(
    tmp_path, monkeypatch
):
    db_path = tmp_path / "old.db"
    raw = sqlite3.connect(db_path)
    raw.execute(
        "CREATE TABLE islands ("
        " id TEXT PRIMARY KEY, title TEXT NOT NULL DEFAULT '',"
        " status TEXT NOT NULL, stage TEXT NOT NULL DEFAULT '',"
        " error TEXT NOT NULL DEFAULT '', complexity TEXT NOT NULL DEFAULT 'simple',"
        " register TEXT NOT NULL DEFAULT 'polite', language TEXT NOT NULL DEFAULT 'ja',"
        " native TEXT NOT NULL DEFAULT 'en',"
        " source TEXT NOT NULL DEFAULT 'voice', source_name TEXT NOT NULL DEFAULT '',"
        " speaker INTEGER NOT NULL DEFAULT 3,"
        " transcript TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL)"
    )
    raw.execute(
        "CREATE TABLE lines ("
        " island_id TEXT NOT NULL, idx INTEGER NOT NULL, ja TEXT NOT NULL,"
        " kana TEXT NOT NULL DEFAULT '', romaji TEXT NOT NULL DEFAULT '',"
        " en TEXT NOT NULL DEFAULT '', duration REAL NOT NULL DEFAULT 0,"
        " timeline TEXT NOT NULL DEFAULT '[]', words TEXT NOT NULL DEFAULT '[]',"
        " offset REAL NOT NULL DEFAULT 0,"
        " PRIMARY KEY (island_id, idx))"
    )
    raw.execute(
        "INSERT INTO islands (id, status, error, created_at)"
        " VALUES ('old-failed-island', 'failed', 'Nothing could be transcribed.', 'now')"
    )
    raw.commit()
    raw.close()

    monkeypatch.setattr(store, "DB_PATH", db_path)
    if hasattr(store._local, "conn"):
        del store._local.conn

    try:
        store.init()
        island = store.get_island("old-failed-island")
        assert island["status"] == "failed"
        assert island["error"] == "Nothing could be transcribed."
        assert island["error_code"] == ""
    finally:
        if hasattr(store._local, "conn"):
            del store._local.conn


def test_recording_too_large_is_a_413_with_a_code():
    big = b"x" * (main.MAX_UPLOAD_BYTES + 1)
    with pytest.raises(HTTPException) as exc:
        asyncio.run(main.create_island(
            background=BackgroundTasks(), audio=_FakeUpload(big), complexity="simple",
            register="polite", language="ja", native="en", speaker=3, count=8,
            authorization=AUTH, x_shadow_device=DEV,
        ))
    assert exc.value.status_code == 413
    assert exc.value.detail == {"code": "recording_too_large"}


def test_empty_upload_is_a_400_with_a_code():
    with pytest.raises(HTTPException) as exc:
        asyncio.run(main.create_island(
            background=BackgroundTasks(), audio=_FakeUpload(b""), complexity="simple",
            register="polite", language="ja", native="en", speaker=3, count=8,
            authorization=AUTH, x_shadow_device=DEV,
        ))
    assert exc.value.status_code == 400
    assert exc.value.detail == {"code": "empty_upload"}


def test_voicevox_unreachable_is_a_502_with_a_code(monkeypatch):
    async def _boom(language):
        raise RuntimeError("connection refused")

    monkeypatch.setattr(main.voices, "list_speakers", _boom)

    with pytest.raises(HTTPException) as exc:
        asyncio.run(main.speakers(language="ja", authorization=AUTH))
    assert exc.value.status_code == 502
    assert exc.value.detail == {"code": "voice_unreachable"}
