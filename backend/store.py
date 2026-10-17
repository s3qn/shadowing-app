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

import dbconn

DATA_DIR = Path(os.getenv("SHADOW_DATA_DIR", Path(__file__).parent / "data"))
DB_PATH = DATA_DIR / "islands.db"
AUDIO_DIR = DATA_DIR / "audio"
TAKES_DIR = DATA_DIR / "takes"
AEC_DIR = DATA_DIR / "aec"
VIDEO_AUDIO_DIR = DATA_DIR / "video-audio"

SCHEMA = """
CREATE TABLE IF NOT EXISTS islands (
  id          TEXT PRIMARY KEY,
  title       TEXT NOT NULL DEFAULT '',
  status      TEXT NOT NULL,
  stage       TEXT NOT NULL DEFAULT '',
  error       TEXT NOT NULL DEFAULT '',
  complexity  TEXT NOT NULL DEFAULT 'simple',
  register    TEXT NOT NULL DEFAULT 'polite',
  language    TEXT NOT NULL DEFAULT 'ja',
  native      TEXT NOT NULL DEFAULT 'en',
  source      TEXT NOT NULL DEFAULT 'voice',
  source_name TEXT NOT NULL DEFAULT '',
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
  offset      REAL NOT NULL DEFAULT 0,
  tatoeba_id  INTEGER,
  span        TEXT NOT NULL DEFAULT '',
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
CREATE TABLE IF NOT EXISTS builds (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  device      TEXT NOT NULL,
  kind        TEXT NOT NULL,
  created_at  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_builds_device_kind_created
  ON builds (device, kind, created_at);
CREATE TABLE IF NOT EXISTS videos (
  island_id   TEXT PRIMARY KEY REFERENCES islands(id) ON DELETE CASCADE,
  video_id    TEXT NOT NULL,
  start_s     REAL NOT NULL DEFAULT 0,
  duration    REAL NOT NULL DEFAULT 0,
  title       TEXT NOT NULL DEFAULT '',
  author      TEXT NOT NULL DEFAULT '',
  created_at  TEXT NOT NULL,
  align_status   TEXT NOT NULL DEFAULT '',
  align_error    TEXT NOT NULL DEFAULT '',
  align_attempts INTEGER NOT NULL DEFAULT 0
);
"""


def _now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


# One connection per thread, see dbconn.
_local = threading.local()


def _make_dirs() -> None:
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    AUDIO_DIR.mkdir(parents=True, exist_ok=True)
    TAKES_DIR.mkdir(parents=True, exist_ok=True)
    AEC_DIR.mkdir(parents=True, exist_ok=True)
    VIDEO_AUDIO_DIR.mkdir(parents=True, exist_ok=True)


def connect() -> sqlite3.Connection:
    # WAL lets a read proceed while another thread holds a write
    # transaction, which matters now that connections (and so
    # transactions) live as long as the thread does.
    return dbconn.thread_conn(_local, DB_PATH, "foreign_keys = ON", "journal_mode = WAL")


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
        # Databases created before imported islands existed lack the offset
        # a line's slice starts at in its source audio.
        if "offset" not in cols:
            conn.execute("ALTER TABLE lines ADD COLUMN offset REAL NOT NULL DEFAULT 0")
        # Databases created before voice topics lack the Tatoeba sentence id.
        if "tatoeba_id" not in cols:
            conn.execute("ALTER TABLE lines ADD COLUMN tatoeba_id INTEGER")
        # Databases created before grammar islands lack the drilled span.
        if "span" not in cols:
            conn.execute("ALTER TABLE lines ADD COLUMN span TEXT NOT NULL DEFAULT ''")
        # Databases created before the speech register choice existed lack it.
        island_cols = {row["name"] for row in conn.execute("PRAGMA table_info(islands)")}
        if "register" not in island_cols:
            conn.execute("ALTER TABLE islands ADD COLUMN register TEXT NOT NULL DEFAULT 'polite'")
        # Databases created before islands remembered their learning language lack it.
        if "language" not in island_cols:
            conn.execute("ALTER TABLE islands ADD COLUMN language TEXT NOT NULL DEFAULT 'ja'")
        # Databases created before imports and podcasts existed lack where an
        # island's audio came from and the uploaded file name or episode title.
        if "source" not in island_cols:
            conn.execute("ALTER TABLE islands ADD COLUMN source TEXT NOT NULL DEFAULT 'voice'")
        if "source_name" not in island_cols:
            conn.execute("ALTER TABLE islands ADD COLUMN source_name TEXT NOT NULL DEFAULT ''")
        # Databases created before islands remembered their understood language lack it.
        if "native" not in island_cols:
            conn.execute("ALTER TABLE islands ADD COLUMN native TEXT NOT NULL DEFAULT 'en'")
        # Databases created before failures carried a machine-readable code lack it.
        if "error_code" not in island_cols:
            conn.execute("ALTER TABLE islands ADD COLUMN error_code TEXT NOT NULL DEFAULT ''")
        # device-scope: databases created before per-device islands existed
        # lack the column that scopes an island to the phone that made it.
        # Rows without it (device='') belong to nobody until claimed.
        if "device" not in island_cols:
            conn.execute("ALTER TABLE islands ADD COLUMN device TEXT NOT NULL DEFAULT ''")
        # After the ALTER above, since old databases only now have `device`.
        conn.execute(
            "CREATE INDEX IF NOT EXISTS idx_islands_device_created ON islands(device, created_at)"
        )
        # bl36-align: video islands from before forced alignment lack its state.
        # Additive and idempotent: each column is added only when missing.
        video_cols = {row["name"] for row in conn.execute("PRAGMA table_info(videos)")}
        for col, ddl in (
            ("align_status", "TEXT NOT NULL DEFAULT ''"),
            ("align_error", "TEXT NOT NULL DEFAULT ''"),
            ("align_attempts", "INTEGER NOT NULL DEFAULT 0"),
        ):
            if col not in video_cols:
                conn.execute(f"ALTER TABLE videos ADD COLUMN {col} {ddl}")


def create_island(
    complexity: str, speaker: int, register: str = "polite", language: str = "ja",
    source: str = "voice", source_name: str = "", native: str = "en", device: str = "",
) -> str:
    island_id = uuid.uuid4().hex[:12]
    with connect() as conn:
        conn.execute(
            "INSERT INTO islands (id, status, stage, complexity, register, language, native,"
            " source, source_name, speaker, created_at, device)"
            " VALUES (?, 'pending', 'queued', ?, ?, ?, ?, ?, ?, ?, ?, ?)",
            (island_id, complexity, register, language, native, source, source_name, speaker,
             _now(), device),
        )
    (AUDIO_DIR / island_id).mkdir(parents=True, exist_ok=True)
    return island_id


def set_stage(island_id: str, stage: str) -> None:
    with connect() as conn:
        conn.execute(
            "UPDATE islands SET status='working', stage=? WHERE id=?", (stage, island_id)
        )


def set_failed(island_id: str, error: str, code: str = "") -> None:
    with connect() as conn:
        conn.execute(
            "UPDATE islands SET status='failed', stage='', error=?, error_code=? WHERE id=?",
            (error, code, island_id),
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


def set_source(island_id: str, source: str, source_name: str) -> None:
    """Re-label an island's origin (the mic found a grammar point)."""
    with connect() as conn:
        conn.execute(
            "UPDATE islands SET source=?, source_name=? WHERE id=?",
            (source, source_name, island_id),
        )


def set_title(island_id: str, title: str) -> None:
    with connect() as conn:
        conn.execute(
            "UPDATE islands SET title=? WHERE id=?",
            (title, island_id),
        )


def add_line(island_id: str, idx: int, line: dict, duration: float, timeline: list,
             words: list | None = None, offset: float = 0.0) -> None:
    with connect() as conn:
        conn.execute(
            "INSERT OR REPLACE INTO lines"
            " (island_id, idx, ja, kana, romaji, en, duration, timeline, words, offset,"
            " tatoeba_id, span)"
            " VALUES (?,?,?,?,?,?,?,?,?,?,?,?)",
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
                offset,
                line.get("tatoeba_id"),
                line.get("span", ""),
            ),
        )


def set_en(island_id: str, idx: int, en: str) -> None:
    """Plain overwrite of one line's English translation, no expected-value
    check: the translator (Task 2) fills this in after the island is ready
    and already usable, so there is no concurrent writer to race against."""
    with connect() as conn:
        conn.execute(
            "UPDATE lines SET en=? WHERE island_id=? AND idx=?", (en, island_id, idx)
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
EXPLAIN_CACHE_VERSION = "v4"


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


def island_device(island_id: str) -> str | None:
    """The owning device of an island, or None for an unknown id. One row, no
    lines, for ownership checks on hot routes."""
    with connect() as conn:
        row = conn.execute("SELECT device FROM islands WHERE id=?", (island_id,)).fetchone()
    return None if row is None else row["device"]


def island_source(island_id: str) -> str | None:
    """Where an island's audio came from (voice, youtube, podcast, ...), or
    None for an unknown id. One row, no lines."""
    with connect() as conn:
        row = conn.execute("SELECT source FROM islands WHERE id=?", (island_id,)).fetchone()
    return None if row is None else row["source"]


def count_islands(device: str) -> int:
    """How many ready islands `device` owns."""
    with connect() as conn:
        row = conn.execute(
            "SELECT COUNT(*) AS n FROM islands WHERE device=? AND status='ready'", (device,)
        ).fetchone()
    return int(row["n"])


def list_islands(device: str | None = None) -> list[dict]:
    """`device=None` lists every island regardless of owner, which startup
    healing relies on. A string filters to that device's own islands."""
    query = (
        "SELECT i.id, i.title, i.status, i.stage, i.complexity, i.language, i.native,"
        " i.source, i.source_name, i.created_at, i.device, COUNT(l.idx) AS line_count"
        " FROM islands i LEFT JOIN lines l ON l.island_id = i.id"
    )
    params: tuple = ()
    if device is not None:
        query += " WHERE i.device = ?"
        params = (device,)
    query += " GROUP BY i.id ORDER BY i.created_at DESC"
    with connect() as conn:
        rows = conn.execute(query, params).fetchall()
    return [dict(r) for r in rows]


def delete_island(island_id: str) -> None:
    import shutil

    with connect() as conn:
        conn.execute("DELETE FROM islands WHERE id=?", (island_id,))
    shutil.rmtree(AUDIO_DIR / island_id, ignore_errors=True)
    shutil.rmtree(TAKES_DIR / island_id, ignore_errors=True)


# device-scope: per-device ownership and the daily build limit.
def claim_unowned(device: str) -> int:
    """Gives every unowned island to `device`. Called once at startup when
    `SHADOW_OWNER_DEVICE` is set, so Sean's pre-existing islands (device='')
    become his rather than staying invisible to everyone."""
    with connect() as conn:
        cur = conn.execute("UPDATE islands SET device=? WHERE device=''", (device,))
        return cur.rowcount


def count_builds_today(device: str, kind: str) -> int:
    today = _now()[:10]
    with connect() as conn:
        row = conn.execute(
            "SELECT COUNT(*) AS n FROM builds WHERE device=? AND kind=?"
            " AND substr(created_at,1,10)=?",
            (device, kind, today),
        ).fetchone()
    return row["n"]


def log_build(device: str, kind: str) -> None:
    with connect() as conn:
        conn.execute(
            "INSERT INTO builds (device, kind, created_at) VALUES (?, ?, ?)",
            (device, kind, _now()),
        )


def delete_owner_rows(device: str) -> None:
    with connect() as conn:
        conn.execute("DELETE FROM builds WHERE device=?", (device,))


def line_audio_path(island_id: str, idx: int) -> Path:
    return AUDIO_DIR / island_id / f"{idx}.wav"


def take_paths(island_id: str, idx: int) -> tuple[Path, Path]:
    """Where a line's take pair lives: the untouched upload and the version
    with the echo removed. The per-island folder is created on first use,
    since islands built before this feature predate it."""
    folder = TAKES_DIR / island_id
    folder.mkdir(parents=True, exist_ok=True)
    return folder / f"{idx}.raw.wav", folder / f"{idx}.clean.wav"


# --- youtube-shadowing ---
def add_video(island_id: str, video_id: str, start_s: float, title: str, author: str) -> None:
    with connect() as conn:
        conn.execute(
            "INSERT OR REPLACE INTO videos (island_id, video_id, start_s, title, author,"
            " created_at) VALUES (?, ?, ?, ?, ?, ?)",
            (island_id, video_id, start_s, title, author, _now()),
        )


def set_video_duration(island_id: str, duration: float) -> None:
    with connect() as conn:
        conn.execute("UPDATE videos SET duration=? WHERE island_id=?", (duration, island_id))


# --- bl36-align ---
def video_audio_path(island_id: str, kind: str = "src") -> Path:
    """Scratch audio for the aligner: the phone's upload ("src"), the 16 kHz wav
    ("wav") and the job files. The per-island folder is made on first use."""
    folder = VIDEO_AUDIO_DIR / island_id
    folder.mkdir(parents=True, exist_ok=True)
    return folder / kind


def set_align_status(island_id: str, status: str, error: str = "",
                     count_attempt: bool = False) -> None:
    with connect() as conn:
        conn.execute(
            "UPDATE videos SET align_status=?, align_error=?,"
            " align_attempts=align_attempts+? WHERE island_id=?",
            (status, error, 1 if count_attempt else 0, island_id),
        )


def claim_align(island_id: str, max_attempts: int) -> bool:
    """Mark the video queued if it is idle ('' or failed) and has attempts left.
    One UPDATE, so of two racing uploads only one wins."""
    with connect() as conn:
        cur = conn.execute(
            "UPDATE videos SET align_status='queued', align_error=''"
            " WHERE island_id=? AND align_status IN ('','failed') AND align_attempts<?",
            (island_id, max_attempts),
        )
    return cur.rowcount == 1


def island_status(island_id: str) -> str | None:
    with connect() as conn:
        row = conn.execute("SELECT status FROM islands WHERE id=?", (island_id,)).fetchone()
    return row["status"] if row else None


def list_align_pending() -> list[str]:
    """Island ids whose alignment was queued or running when the process died."""
    with connect() as conn:
        rows = conn.execute(
            "SELECT island_id FROM videos WHERE align_status IN ('queued','running')"
            " ORDER BY created_at"
        ).fetchall()
    return [r["island_id"] for r in rows]


def set_line_span(island_id: str, idx: int, offset: float, duration: float) -> None:
    with connect() as conn:
        conn.execute(
            "UPDATE lines SET offset=?, duration=? WHERE island_id=? AND idx=?",
            (offset, duration, island_id, idx),
        )
# --- end bl36-align ---


def get_video(island_id: str) -> dict | None:
    with connect() as conn:
        row = conn.execute("SELECT * FROM videos WHERE island_id=?", (island_id,)).fetchone()
    return dict(row) if row else None


def list_videos(device: str) -> list[dict]:
    """A device's video islands, newest first."""
    with connect() as conn:
        rows = conn.execute(
            "SELECT v.island_id, v.video_id, v.title, i.status, i.stage, i.error_code,"
            " v.created_at,"
            " (SELECT COUNT(*) FROM lines l WHERE l.island_id=i.id) AS line_count"
            " FROM videos v JOIN islands i ON i.id=v.island_id"
            " WHERE i.device=? ORDER BY v.created_at DESC, v.rowid DESC",
            (device,),
        ).fetchall()
    return [dict(r) for r in rows]
