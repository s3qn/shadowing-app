"""BL-70: the build-time estimate (eta.py), the stats it learns from and the
eta_s field on the island routes."""

import asyncio
import sqlite3

import pytest

import eta
import main
import store


@pytest.fixture(autouse=True)
def _init_db():
    store.init()


DEV = "cccccccc-0000-4000-8000-000000000003"


def test_default_rate_with_fewer_than_three_rows():
    assert eta.estimate("import", 1000, 0, []) == round(0.35 * 1000 + 25)
    assert eta.estimate("import", 1000, 0, [(100, 10), (100, 10)]) == 375
    assert eta.estimate("video", 1000, 0, []) == round(0.05 * 1000 + 20)


def test_median_of_recent_rows_replaces_default():
    history = [(100, 10), (100, 20), (100, 30)]  # rates 0.1, 0.2, 0.3
    assert eta.estimate("import", 1000, 0, history) == round(0.2 * 1000 + 25)


def test_only_the_last_twenty_rows_count():
    history = [(100, 10)] * 20 + [(100, 90)] * 30
    assert eta.rate_for("import", history) == pytest.approx(0.1)


def test_short_media_rows_are_skipped():
    history = [(10, 100)] * 5 + [(100, 10)] * 3
    assert eta.rate_for("import", history) == pytest.approx(0.1)
    assert eta.rate_for("import", [(10, 100)] * 5) == 0.35


def test_eta_counts_down_and_floors_at_zero():
    first = eta.estimate("import", 600, 0, [])
    later = eta.estimate("import", 600, 100, [])
    assert later == first - 100
    total = 0.35 * 600 + 25
    assert eta.estimate("import", 600, total - 1, []) == 1
    assert eta.estimate("import", 600, total * 1.5 + 1, []) == 0


def test_none_without_media_length():
    assert eta.estimate("import", 0, 5, []) is None


def test_set_media_record_build_round_trip():
    iid = store.create_island("simple", 3, source="import", device=DEV)
    store.set_media(iid, 120.0)
    row = store.get_island(iid)
    assert row["media_s"] == 120.0
    t0 = row["build_t0"]
    assert t0 > 0
    store.set_media(iid, 130.0)
    assert store.get_island(iid)["build_t0"] == t0  # the start is not restamped

    before = len(store.build_history("import", 1000))
    store.set_ready(iid, "t")
    hist = store.build_history("import", 1000)
    assert len(hist) == before + 1
    assert hist[0][0] == 130.0
    assert hist[0][1] >= 0


def test_ready_without_media_records_nothing():
    iid = store.create_island("simple", 3, source="import", device=DEV)
    before = len(store.build_history("import", 1000))
    store.set_ready(iid, "t")
    assert len(store.build_history("import", 1000)) == before


def test_route_eta_int_while_working_null_when_ready():
    iid = store.create_island("simple", 3, source="import", device=DEV)
    store.set_stage(iid, "downloading")
    store.start_build(iid)
    got = asyncio.run(main.get_island(iid, f"Bearer {main.SHADOW_TOKEN}", DEV))
    assert got["eta_s"] is None  # media length not known yet

    store.set_media(iid, 600.0)
    store.set_stage(iid, "transcribing")
    got = asyncio.run(main.get_island(iid, f"Bearer {main.SHADOW_TOKEN}", DEV))
    assert isinstance(got["eta_s"], int) and got["eta_s"] > 0
    listed = next(r for r in main.list_islands(f"Bearer {main.SHADOW_TOKEN}", DEV, DEV) if r["id"] == iid)
    assert isinstance(listed["eta_s"], int)

    store.set_ready(iid, "t")
    got = asyncio.run(main.get_island(iid, f"Bearer {main.SHADOW_TOKEN}", DEV))
    assert got["eta_s"] is None


def test_old_database_upgrades_in_place(tmp_path, monkeypatch):
    db_path = tmp_path / "old.db"
    raw = sqlite3.connect(db_path)
    raw.execute(
        "CREATE TABLE islands (id TEXT PRIMARY KEY, title TEXT NOT NULL DEFAULT '',"
        " status TEXT NOT NULL, stage TEXT NOT NULL DEFAULT '', error TEXT NOT NULL DEFAULT '',"
        " complexity TEXT NOT NULL DEFAULT 'simple', register TEXT NOT NULL DEFAULT 'polite',"
        " speaker INTEGER NOT NULL DEFAULT 3, transcript TEXT NOT NULL DEFAULT '',"
        " created_at TEXT NOT NULL)"
    )
    raw.execute("INSERT INTO islands (id, status, created_at) VALUES ('o', 'ready', 'now')")
    raw.commit()
    raw.close()
    monkeypatch.setattr(store, "DB_PATH", db_path)
    if hasattr(store._local, "conn"):
        del store._local.conn
    try:
        store.init()
        store.init()
        row = store.get_island("o")
        assert row["media_s"] == 0 and row["build_t0"] == 0
        store.record_build("import", 60.0, 30.0)
        assert store.build_history("import") == [(60.0, 30.0)]
    finally:
        if hasattr(store._local, "conn"):
            del store._local.conn
