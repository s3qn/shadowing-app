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
import threading
import uuid
from datetime import datetime, timezone
from pathlib import Path

DATA_DIR = Path(os.getenv("SHADOW_DATA_DIR", Path(__file__).parent / "data"))
DB_PATH = DATA_DIR / "islands.db"
AUDIO_DIR = DATA_DIR / "audio"
TAKES_DIR = DATA_DIR / "takes"
AEC_DIR = DATA_DIR / "aec"

SCHEMA = """
CREATE TABLE IF NOT EXISTS islands (
  id          TEXT PRIMARY KEY,
  title       TEXT NOT NULL DEFAULT '',
  status      TEXT NOT NULL,
  stage       TEXT NOT NULL DEFAULT '',
  error       TEXT NOT NULL DEFAULT '',
  complexity  TEXT NOT NULL DEFAULT 'simple',
  register    TEXT NOT NULL DEFAULT 'polite',
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
  words       TEXT NOT NULL DEFAULT '[]',
  PRIMARY KEY (island_id, idx),
  FOREIGN KEY (island_id) REFERENCES islands(id) ON DELETE CASCADE
);
CREATE TABLE IF NOT EXISTS word_context (
  word        TEXT NOT NULL,
  sentence    TEXT NOT NULL,
  context     TEXT NOT NULL,
  created_at  TEXT NOT NULL,
  PRIMARY KEY (word, sentence)
);
CREATE TABLE IF NOT EXISTS explain_cache (
  sentence    TEXT NOT NULL,
  marked      TEXT NOT NULL,
  question    TEXT NOT NULL,
  answer      TEXT NOT NULL,
  created_at  TEXT NOT NULL,
  PRIMARY KEY (sentence, marked, question)
);
"""


def _now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


# One sqlite3 connection per thread, kept for the thread's life rather than
# opened fresh on every call. store.* is hit from route handlers that hop
# onto asyncio.to_thread's worker pool, whose threads are reused across
# requests, so this is a real cache, not a one-shot. sqlite3's default
# check_same_thread=True is exactly the safety this needs: a connection is
# only ever touched by the thread that opened it, the same guarantee
# threading.local already gives its contents.
_local = threading.local()


def _make_dirs() -> None:
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    AUDIO_DIR.mkdir(parents=True, exist_ok=True)
    TAKES_DIR.mkdir(parents=True, exist_ok=True)
    AEC_DIR.mkdir(parents=True, exist_ok=True)


def connect() -> sqlite3.Connection:
    conn = getattr(_local, "conn", None)
    if conn is None:
        conn = sqlite3.connect(DB_PATH)
        conn.row_factory = sqlite3.Row
        conn.execute("PRAGMA foreign_keys = ON")
        # WAL lets a read proceed while another thread holds a write
        # transaction, which matters now that connections (and so
        # transactions) live as long as the thread does.
        conn.execute("PRAGMA journal_mode = WAL")
        _local.conn = conn
    return conn


def init() -> None:
    """Create the data directories and the schema. Called once at app
    startup (and once per test by the `_init_db` fixture); the mkdirs used to
    run inside `connect()` itself, which meant every hot-path call paid for
    four syscalls it only ever needed once."""
    _make_dirs()
    with connect() as conn:
        conn.executescript(SCHEMA)
        # Databases created before word timings existed lack the column.
        cols = {row["name"] for row in conn.execute("PRAGMA table_info(lines)")}
        if "words" not in cols:
            conn.execute("ALTER TABLE lines ADD COLUMN words TEXT NOT NULL DEFAULT '[]'")
        # Databases created before the speech register choice existed lack it.
        island_cols = {row["name"] for row in conn.execute("PRAGMA table_info(islands)")}
        if "register" not in island_cols:
            conn.execute("ALTER TABLE islands ADD COLUMN register TEXT NOT NULL DEFAULT 'polite'")


def create_island(complexity: str, speaker: int, register: str = "polite") -> str:
    island_id = uuid.uuid4().hex[:12]
    with connect() as conn:
        conn.execute(
            "INSERT INTO islands (id, status, stage, complexity, register, speaker, created_at)"
            " VALUES (?, 'pending', 'queued', ?, ?, ?, ?)",
            (island_id, complexity, register, speaker, _now()),
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


def set_title(island_id: str, title: str) -> None:
    with connect() as conn:
        conn.execute(
            "UPDATE islands SET title=? WHERE id=?",
            (title, island_id),
        )


def add_line(island_id: str, idx: int, line: dict, duration: float, timeline: list,
             words: list | None = None) -> None:
    with connect() as conn:
        conn.execute(
            "INSERT OR REPLACE INTO lines"
            " (island_id, idx, ja, kana, romaji, en, duration, timeline, words)"
            " VALUES (?,?,?,?,?,?,?,?,?)",
            (
                island_id,
                idx,
                line.get("ja", ""),
                line.get("kana", ""),
                line.get("romaji", ""),
                line.get("en", ""),
                duration,
                json.dumps(timeline, ensure_ascii=False),
                json.dumps(words or [], ensure_ascii=False),
            ),
        )


def _set_line_json(island_id: str, idx: int, column: str, value: list,
                   expected: list | None) -> bool:
    """Write one JSON column of a line. With `expected`, only when the stored
    value still equals it (compared as parsed JSON, inside one write lock),
    so a backfill computed from an older read cannot overwrite a line that a
    re-voice replaced in the meantime. Returns True when a row was written."""
    # connect() now hands back the thread's one long-lived connection, so
    # this must leave it usable for the next call on the same thread: roll
    # back on any early return or error instead of closing it.
    conn = connect()
    conn.execute("BEGIN IMMEDIATE")
    try:
        if expected is not None:
            row = conn.execute(
                f"SELECT {column} FROM lines WHERE island_id=? AND idx=?", (island_id, idx)
            ).fetchone()
            if row is None or json.loads(row[column] or "[]") != expected:
                conn.rollback()
                return False
        cur = conn.execute(
            f"UPDATE lines SET {column}=? WHERE island_id=? AND idx=?",
            (json.dumps(value, ensure_ascii=False), island_id, idx),
        )
        conn.commit()
        return cur.rowcount > 0
    except Exception:
        conn.rollback()
        raise


def set_words(island_id: str, idx: int, words: list, expected: list | None = None) -> bool:
    return _set_line_json(island_id, idx, "words", words, expected)


def get_word_context(word: str, sentence: str) -> str | None:
    with connect() as conn:
        row = conn.execute(
            "SELECT context FROM word_context WHERE word=? AND sentence=?",
            (word, sentence),
        ).fetchone()
    return row["context"] if row is not None else None


def set_word_context(word: str, sentence: str, context: str) -> None:
    with connect() as conn:
        conn.execute(
            "INSERT OR REPLACE INTO word_context (word, sentence, context, created_at)"
            " VALUES (?,?,?,?)",
            (word, sentence, context, _now()),
        )


# Bumped whenever the shape of a cached explain answer changes, folded into
# the cache key below. Explain answers used to be a plain-text string; they
# are now a JSON-encoded {"vocab", "grammar", "summary"} dict, so a stale
# plain-text row from before this version must never be served as the new
# shape. Bump this again the next time the answer shape changes.
# v3: grammar items can carry a "span" (the exact substring of the sentence
# the pattern appears in); a v2 row was cached before spans existed, so it
# must not be served in place of a fresh answer that has one.
EXPLAIN_CACHE_VERSION = "v3"


def get_explain_answer(sentence: str, marked: list[str], question: str) -> str | None:
    """A cached Explain answer for this exact (sentence, marked words,
    question) triple, or None on a cache miss. `marked` is compared as its
    JSON-serialised form, same list order as the caller used to set it."""
    with connect() as conn:
        row = conn.execute(
            "SELECT answer FROM explain_cache WHERE sentence=? AND marked=? AND question=?",
            (sentence, json.dumps(marked, ensure_ascii=False), f"{EXPLAIN_CACHE_VERSION}:{question}"),
        ).fetchone()
    return row["answer"] if row is not None else None


def set_explain_answer(sentence: str, marked: list[str], question: str, answer: str) -> None:
    with connect() as conn:
        conn.execute(
            "INSERT OR REPLACE INTO explain_cache (sentence, marked, question, answer, created_at)"
            " VALUES (?,?,?,?,?)",
            (sentence, json.dumps(marked, ensure_ascii=False), f"{EXPLAIN_CACHE_VERSION}:{question}", answer, _now()),
        )


def set_timeline(island_id: str, idx: int, timeline: list,
                 expected: list | None = None) -> bool:
    return _set_line_json(island_id, idx, "timeline", timeline, expected)


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
        {
            **dict(line),
            "timeline": json.loads(line["timeline"]),
            "words": json.loads(line["words"] or "[]"),
        }
        for line in lines
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
    shutil.rmtree(TAKES_DIR / island_id, ignore_errors=True)


def line_audio_path(island_id: str, idx: int) -> Path:
    return AUDIO_DIR / island_id / f"{idx}.wav"


def take_paths(island_id: str, idx: int) -> tuple[Path, Path]:
    """Where a line's take pair lives: the untouched upload and the version
    with the echo removed. The per-island folder is created on first use,
    since islands built before this feature predate it."""
    folder = TAKES_DIR / island_id
    folder.mkdir(parents=True, exist_ok=True)
    return folder / f"{idx}.raw.wav", folder / f"{idx}.clean.wav"
