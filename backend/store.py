"""SQLite storage for islands and their lines.

One island is one recording plus everything derived from it. Lines are the
Japanese sentences generated from that recording, each with its own wav on disk
and its own mora timeline stored as JSON.

Audio files live outside the database at data/audio/<island_id>/<n>.wav, because
wav blobs in SQLite make the file awkward to inspect and back up.
"""

import json
import os
import sqlite3
import uuid
from datetime import datetime, timezone
from pathlib import Path

DATA_DIR = Path(os.getenv("SHADOW_DATA_DIR", Path(__file__).parent / "data"))
DB_PATH = DATA_DIR / "islands.db"
AUDIO_DIR = DATA_DIR / "audio"

SCHEMA = """
CREATE TABLE IF NOT EXISTS islands (
  id          TEXT PRIMARY KEY,
  title       TEXT NOT NULL DEFAULT '',
  status      TEXT NOT NULL,
  stage       TEXT NOT NULL DEFAULT '',
  error       TEXT NOT NULL DEFAULT '',
  complexity  TEXT NOT NULL DEFAULT 'simple',
  speaker     INTEGER NOT NULL DEFAULT 3,
  transcript  TEXT NOT NULL DEFAULT '',
  created_at  TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS lines (
  island_id   TEXT NOT NULL,
  idx         INTEGER NOT NULL,
  ja          TEXT NOT NULL,
  kana        TEXT NOT NULL DEFAULT '',
  romaji      TEXT NOT NULL DEFAULT '',
  en          TEXT NOT NULL DEFAULT '',
  duration    REAL NOT NULL DEFAULT 0,
  timeline    TEXT NOT NULL DEFAULT '[]',
  PRIMARY KEY (island_id, idx),
  FOREIGN KEY (island_id) REFERENCES islands(id) ON DELETE CASCADE
);
"""


def _now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def connect() -> sqlite3.Connection:
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    AUDIO_DIR.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    return conn


def init() -> None:
    with connect() as conn:
        conn.executescript(SCHEMA)


def create_island(complexity: str, speaker: int) -> str:
    island_id = uuid.uuid4().hex[:12]
    with connect() as conn:
        conn.execute(
            "INSERT INTO islands (id, status, stage, complexity, speaker, created_at)"
            " VALUES (?, 'pending', 'queued', ?, ?, ?)",
            (island_id, complexity, speaker, _now()),
        )
    (AUDIO_DIR / island_id).mkdir(parents=True, exist_ok=True)
    return island_id


def set_stage(island_id: str, stage: str) -> None:
    with connect() as conn:
        conn.execute(
            "UPDATE islands SET status='working', stage=? WHERE id=?", (stage, island_id)
        )


def set_failed(island_id: str, error: str) -> None:
    with connect() as conn:
        conn.execute(
            "UPDATE islands SET status='failed', stage='', error=? WHERE id=?",
            (error, island_id),
        )


def set_transcript(island_id: str, text: str) -> None:
    with connect() as conn:
        conn.execute("UPDATE islands SET transcript=? WHERE id=?", (text, island_id))


def set_speaker(island_id: str, speaker: int) -> None:
    with connect() as conn:
        conn.execute("UPDATE islands SET speaker=? WHERE id=?", (speaker, island_id))


def set_ready(island_id: str, title: str) -> None:
    with connect() as conn:
        conn.execute(
            "UPDATE islands SET status='ready', stage='', title=? WHERE id=?",
            (title, island_id),
        )


def add_line(island_id: str, idx: int, line: dict, duration: float, timeline: list) -> None:
    with connect() as conn:
        conn.execute(
            "INSERT OR REPLACE INTO lines"
            " (island_id, idx, ja, kana, romaji, en, duration, timeline)"
            " VALUES (?,?,?,?,?,?,?,?)",
            (
                island_id,
                idx,
                line.get("ja", ""),
                line.get("kana", ""),
                line.get("romaji", ""),
                line.get("en", ""),
                duration,
                json.dumps(timeline, ensure_ascii=False),
            ),
        )


def clear_lines(island_id: str) -> None:
    with connect() as conn:
        conn.execute("DELETE FROM lines WHERE island_id=?", (island_id,))


def get_island(island_id: str) -> dict | None:
    with connect() as conn:
        row = conn.execute("SELECT * FROM islands WHERE id=?", (island_id,)).fetchone()
        if row is None:
            return None
        island = dict(row)
        lines = conn.execute(
            "SELECT * FROM lines WHERE island_id=? ORDER BY idx", (island_id,)
        ).fetchall()
    island["lines"] = [
        {**dict(line), "timeline": json.loads(line["timeline"])} for line in lines
    ]
    return island


def list_islands() -> list[dict]:
    with connect() as conn:
        rows = conn.execute(
            "SELECT i.id, i.title, i.status, i.stage, i.complexity, i.created_at,"
            " COUNT(l.idx) AS line_count"
            " FROM islands i LEFT JOIN lines l ON l.island_id = i.id"
            " GROUP BY i.id ORDER BY i.created_at DESC"
        ).fetchall()
    return [dict(r) for r in rows]


def delete_island(island_id: str) -> None:
    import shutil

    with connect() as conn:
        conn.execute("DELETE FROM islands WHERE id=?", (island_id,))
    shutil.rmtree(AUDIO_DIR / island_id, ignore_errors=True)


def line_audio_path(island_id: str, idx: int) -> Path:
    return AUDIO_DIR / island_id / f"{idx}.wav"
