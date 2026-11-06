"""SQLite storage for islands and their lines.

One island is one recording plus everything derived from it. Lines are the
Japanese sentences generated from that recording, each with its own wav on disk
and its own mora timeline stored as JSON.

Audio files live outside the database at data/audio/<island_id>/<n>.wav, because
wav blobs in SQLite make the file awkward to inspect and back up.
"""

import json
import os
import re
import sqlite3
import threading
import time
import uuid
from datetime import datetime, timedelta, timezone
from pathlib import Path

import dbconn
import store_schema

DATA_DIR = Path(os.getenv("SHADOW_DATA_DIR", Path(__file__).parent / "data"))
DB_PATH = DATA_DIR / "islands.db"
AUDIO_DIR = DATA_DIR / "audio"
TAKES_DIR = DATA_DIR / "takes"
AEC_DIR = DATA_DIR / "aec"
VIDEO_AUDIO_DIR = DATA_DIR / "video-audio"

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


def backup_before_bl51(db_path: Path, data_dir: Path) -> Path | None:
    """Copies an existing database that predates the review_sessions tables to
    `islands.db.bak-bl51-<YYYYMMDD>` (sqlite backup API, safe under WAL) before
    the migration adds them. Returns the copy's path, or None when there is no
    database or it already has the tables. Runs once: after the migration the
    tables exist, so the next start skips it."""
    if not db_path.exists():
        return None
    src = sqlite3.connect(db_path)
    try:
        has = src.execute(
            "SELECT 1 FROM sqlite_master WHERE type='table' AND name='review_sessions'"
        ).fetchone()
        if has:
            return None
        dest = data_dir / f"islands.db.bak-bl51-{datetime.now(timezone.utc):%Y%m%d}"
        if dest.exists():
            return None
        out = sqlite3.connect(dest)
        try:
            src.backup(out)
        finally:
            out.close()
        return dest
    finally:
        src.close()


def init() -> None:
    """Create the data directories and the schema. Called once at app
    startup (and once per test by the `_init_db` fixture); the mkdirs used to
    run inside `connect()` itself, which meant every hot-path call paid for
    four syscalls it only ever needed once."""
    _make_dirs()
    backup_before_bl51(DB_PATH, DATA_DIR)
    with connect() as conn:
        conn.executescript(store_schema.SCHEMA)
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
        # bl70-eta: databases created before build estimates lack the media
        # length and the build start time.
        if "media_s" not in island_cols:
            conn.execute("ALTER TABLE islands ADD COLUMN media_s REAL NOT NULL DEFAULT 0")
        if "build_t0" not in island_cols:
            conn.execute("ALTER TABLE islands ADD COLUMN build_t0 REAL NOT NULL DEFAULT 0")
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
            ("lines_dropped", "INTEGER NOT NULL DEFAULT 0"),
        ):
            if col not in video_cols:
                conn.execute(f"ALTER TABLE videos ADD COLUMN {col} {ddl}")
        # youtube-asr-context-repair: lines from before the repair pass carry
        # no verdict (NULL = not checked), videos no repair state. Additive
        # and idempotent like the loop above.
        if "sure" not in cols:
            conn.execute("ALTER TABLE lines ADD COLUMN sure INTEGER")
        for col, ddl in (
            ("repair_status", "TEXT NOT NULL DEFAULT ''"),
            ("repair_error", "TEXT NOT NULL DEFAULT ''"),
            ("repair_attempts", "INTEGER NOT NULL DEFAULT 0"),
            ("repair_version", "INTEGER NOT NULL DEFAULT 0"),
        ):
            if col not in video_cols:
                conn.execute(f"ALTER TABLE videos ADD COLUMN {col} {ddl}")
    prune_ops()


# offline-first: client operation ids. A phone that posts from an outbox may
# send the same practice chunk or take twice (a reply lost in flight, a retry
# after a kill), so a post that carries an `op` is claimed once per owner and
# its reply is kept for the replay. One small row per post, pruned after
# OP_KEEP_DAYS; the payload itself never grows.
OP_RE = re.compile(r"^[A-Za-z0-9_:-]{1,64}$")
OP_KEEP_DAYS = 14


def valid_op(op: str) -> bool:
    return isinstance(op, str) and OP_RE.fullmatch(op) is not None


def claim_op(owner: str, op: str) -> bool:
    """True the first time `owner` posts `op`; False on every replay."""
    with connect() as conn:
        cur = conn.execute(
            "INSERT OR IGNORE INTO client_ops (owner, op, reply, created_at) VALUES (?, ?, '', ?)",
            (owner, op, _now()),
        )
    return cur.rowcount == 1


def set_op_reply(owner: str, op: str, reply: dict) -> None:
    with connect() as conn:
        conn.execute(
            "UPDATE client_ops SET reply=? WHERE owner=? AND op=?",
            (json.dumps(reply, default=str), owner, op),
        )


def op_reply(owner: str, op: str) -> dict | None:
    """The stored reply for a claimed op; `{}` when the first run died before
    it stored one (the client treats that as accepted); None when the op was
    never claimed."""
    with connect() as conn:
        row = conn.execute(
            "SELECT reply FROM client_ops WHERE owner=? AND op=?", (owner, op)
        ).fetchone()
    if row is None:
        return None
    if not row["reply"]:
        return {}
    try:
        return json.loads(row["reply"])
    except ValueError:
        return {}


def prune_ops(days: int = OP_KEEP_DAYS) -> int:
    """Drops ops older than `days`. An outbox entry that old has long been
    flushed or dropped, so nothing replays it."""
    cutoff = (datetime.now(timezone.utc) - timedelta(days=days)).isoformat(timespec="seconds")
    with connect() as conn:
        cur = conn.execute("DELETE FROM client_ops WHERE created_at < ?", (cutoff,))
    return cur.rowcount


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


def start_build(island_id: str) -> None:
    """Stamp the build start (upload or download counts toward the wait)."""
    with connect() as conn:
        conn.execute("UPDATE islands SET build_t0=? WHERE id=?", (time.time(), island_id))


def set_media(island_id: str, media_s: float) -> None:
    """Record the media length; stamps the start too if nothing has yet."""
    with connect() as conn:
        conn.execute(
            "UPDATE islands SET media_s=?, build_t0=CASE WHEN build_t0=0 THEN ? ELSE build_t0 END"
            " WHERE id=?",
            (media_s, time.time(), island_id),
        )


def build_kind(source: str) -> str | None:
    return {"import": "import", "podcast": "import", "youtube": "video"}.get(source)


def record_build(kind: str, media_s: float, work_s: float) -> None:
    with connect() as conn:
        conn.execute(
            "INSERT INTO build_stats(kind, media_s, work_s, at) VALUES (?,?,?,?)",
            (kind, media_s, work_s, datetime.now(timezone.utc).isoformat()),
        )


def build_history(kind: str, limit: int = 20) -> list[tuple[float, float]]:
    with connect() as conn:
        rows = conn.execute(
            "SELECT media_s, work_s FROM build_stats WHERE kind=? ORDER BY rowid DESC LIMIT ?",
            (kind, limit),
        ).fetchall()
    return [(r["media_s"], r["work_s"]) for r in rows]


def set_ready(island_id: str, title: str) -> None:
    with connect() as conn:
        conn.execute(
            "UPDATE islands SET status='ready', stage='', title=? WHERE id=?",
            (title, island_id),
        )
        row = conn.execute(
            "SELECT source, media_s, build_t0 FROM islands WHERE id=?", (island_id,)
        ).fetchone()
    kind = build_kind(row["source"]) if row else None
    if kind and row["media_s"] > 0 and row["build_t0"] > 0:
        record_build(kind, row["media_s"], max(0.0, time.time() - row["build_t0"]))


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


def get_say_cache(key: str) -> dict | None:
    """The stored say_lines reply for `key` (generate._say_key), or None on a
    miss. Shared across devices: the key carries no device."""
    with connect() as conn:
        row = conn.execute("SELECT value FROM say_cache WHERE key=?", (key,)).fetchone()
    return json.loads(row["value"]) if row is not None else None


def set_say_cache(key: str, value: dict) -> None:
    with connect() as conn:
        conn.execute(
            "INSERT OR REPLACE INTO say_cache (key, value, created_at) VALUES (?,?,?)",
            (key, json.dumps(value, ensure_ascii=False), _now()),
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


def island_language(island_id: str) -> str | None:
    """An island's learning language, or None for an unknown id."""
    with connect() as conn:
        row = conn.execute("SELECT language FROM islands WHERE id=?", (island_id,)).fetchone()
    return None if row is None else row["language"]


def island_languages() -> dict[str, str]:
    """{island id: learning language} for every island, for cross-db joins."""
    with connect() as conn:
        rows = conn.execute("SELECT id, language FROM islands").fetchall()
    return {r["id"]: r["language"] for r in rows}


def island_length(island_id: str) -> float:
    """Seconds of media in an island: the video's duration, else the sum of
    its line durations. 0 for an unknown id."""
    with connect() as conn:
        row = conn.execute(
            "SELECT duration FROM videos WHERE island_id=?", (island_id,)
        ).fetchone()
        if row is not None and row["duration"] > 0:
            return float(row["duration"])
        row = conn.execute(
            "SELECT COALESCE(SUM(duration), 0) AS s FROM lines WHERE island_id=?", (island_id,)
        ).fetchone()
    return float(row["s"])


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
        " i.source, i.source_name, i.created_at, i.device, i.media_s, i.build_t0, COUNT(l.idx) AS line_count"
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
        conn.execute("DELETE FROM known_lines WHERE island_id=?", (island_id,))
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


# --- ai-guardrails ---
def count_builds_today_kinds(device: str, kinds) -> int:
    today = _now()[:10]
    marks = ",".join("?" for _ in kinds)
    with connect() as conn:
        row = conn.execute(
            f"SELECT COUNT(*) AS n FROM builds WHERE device=? AND kind IN ({marks})"
            " AND substr(created_at,1,10)=?",
            (device, *kinds, today),
        ).fetchone()
    return row["n"]


def count_builds_all_today(kinds) -> int:
    today = _now()[:10]
    marks = ",".join("?" for _ in kinds)
    with connect() as conn:
        row = conn.execute(
            f"SELECT COUNT(*) AS n FROM builds WHERE kind IN ({marks})"
            " AND substr(created_at,1,10)=?",
            (*kinds, today),
        ).fetchone()
    return row["n"]


def user_known(principal: str) -> bool:
    """Any island, build, known line or energy row for this principal."""
    with connect() as conn:
        for table in ("islands", "builds", "known_lines", "energy_ledger"):
            if conn.execute(f"SELECT 1 FROM {table} WHERE device=? LIMIT 1", (principal,)).fetchone():
                return True
    return False
# --- end ai-guardrails ---


def log_build(device: str, kind: str) -> None:
    with connect() as conn:
        conn.execute(
            "INSERT INTO builds (device, kind, created_at) VALUES (?, ?, ?)",
            (device, kind, _now()),
        )


def unlog_build(device: str, kind: str) -> None:
    """Gives back the latest slot of `kind` the device took today."""
    with connect() as conn:
        conn.execute(
            "DELETE FROM builds WHERE id=(SELECT id FROM builds WHERE device=? AND kind=?"
            " AND created_at>=? ORDER BY id DESC LIMIT 1)",
            (device, kind, _now()[:10] + "T00:00:00"),
        )


# bl52-energy lives in store_energy.py.


def add_take_score(device: str, island_id: str, idx: int, language: str,
                   score: dict, speed: float, whole_line: bool) -> None:
    """Keeps one row per uploaded take so sessions can aggregate later. No
    foreign key on island_id: a deleted island keeps its history."""
    parts = score.get("parts") or {}
    with connect() as conn:
        conn.execute(
            "INSERT INTO take_scores (device, island_id, idx, language, total, content,"
            " timing, pitch, speed, whole_line, created_at)"
            " VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
            (device, island_id, idx, language, score.get("total"), parts.get("content"),
             parts.get("timing"), parts.get("pitch"), speed, 1 if whole_line else 0, _now()),
        )


def has_take_score(device: str, island_id: str) -> bool:
    """True once this device has uploaded any scored take on the island."""
    with connect() as conn:
        row = conn.execute(
            "SELECT 1 FROM take_scores WHERE device=? AND island_id=? LIMIT 1",
            (device, island_id),
        ).fetchone()
    return row is not None


def list_take_scores(device: str, since: str = "") -> list[dict]:
    with connect() as conn:
        rows = conn.execute(
            "SELECT * FROM take_scores WHERE device=? AND created_at>=? ORDER BY created_at, id",
            (device, since),
        ).fetchall()
    return [dict(r) for r in rows]


def has_line_take(device: str, island_id: str, idx: int) -> bool:
    """True once this device has uploaded a whole-line take on the line."""
    with connect() as conn:
        row = conn.execute(
            "SELECT 1 FROM take_scores WHERE device=? AND island_id=? AND idx=?"
            " AND whole_line=1 LIMIT 1",
            (device, island_id, idx),
        ).fetchone()
    return row is not None


# bl58-easy-for-me: lines a learner marked "Easy for me". A known line
# leaves Practice now and the later lines of its island skip the prep passes.
def mark_known(device: str, island_id: str, idx: int) -> bool:
    """True when the mark is new. A repeat changes nothing."""
    with connect() as conn:
        cur = conn.execute(
            "INSERT OR IGNORE INTO known_lines (device, island_id, idx, created_at)"
            " VALUES (?, ?, ?, ?)",
            (device, island_id, idx, _now()),
        )
        return cur.rowcount == 1


def unmark_known(device: str, island_id: str, idx: int) -> bool:
    """True when a mark was removed. A repeat changes nothing."""
    with connect() as conn:
        cur = conn.execute(
            "DELETE FROM known_lines WHERE device=? AND island_id=? AND idx=?",
            (device, island_id, idx),
        )
        return cur.rowcount == 1


def known_idxs(device: str, island_id: str) -> list[int]:
    with connect() as conn:
        rows = conn.execute(
            "SELECT idx FROM known_lines WHERE device=? AND island_id=? ORDER BY idx",
            (device, island_id),
        ).fetchall()
    return [r["idx"] for r in rows]


def known_by_island(device: str) -> dict[str, set[int]]:
    out: dict[str, set[int]] = {}
    with connect() as conn:
        rows = conn.execute(
            "SELECT island_id, idx FROM known_lines WHERE device=?", (device,)
        ).fetchall()
    for r in rows:
        out.setdefault(r["island_id"], set()).add(r["idx"])
    return out


def count_known(device: str) -> int:
    with connect() as conn:
        row = conn.execute(
            "SELECT COUNT(*) AS n FROM known_lines WHERE device=?", (device,)
        ).fetchone()
    return row["n"]


def add_session(device: str, session_id: str, size: int, planned_sentences: int,
                planned_seconds: float, plan: dict) -> None:
    with connect() as conn:
        conn.execute(
            "INSERT OR IGNORE INTO review_sessions (id, device, size, planned_sentences,"
            " planned_seconds, plan, started_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
            (session_id, device, size, planned_sentences, planned_seconds,
             json.dumps(plan, ensure_ascii=False), _now()),
        )


def finish_session(device: str, session_id: str, sentences: int, seconds: float,
                   avg_score: float | None, lines: list[dict], completed: bool) -> bool:
    """Closes an open session and writes its line rows. False (and no write)
    for an unknown, foreign or already finished id."""
    with connect() as conn:
        cur = conn.execute(
            "UPDATE review_sessions SET finished_at=?, actual_sentences=?, actual_seconds=?,"
            " avg_score=?, completed=? WHERE id=? AND device=? AND finished_at=''",
            (_now(), sentences, seconds, avg_score, 1 if completed else 0, session_id, device),
        )
        if cur.rowcount == 0:
            return False
        conn.executemany(
            "INSERT INTO review_session_lines (session_id, device, island_id, idx, position,"
            " seconds, score) VALUES (?, ?, ?, ?, ?, ?, ?)",
            [(session_id, device, ln["island_id"], ln["idx"], pos, ln.get("seconds", 0),
              ln.get("score")) for pos, ln in enumerate(lines)],
        )
    return True


def list_sessions(device: str, limit: int = 5) -> list[dict]:
    """Finished sessions, newest first."""
    with connect() as conn:
        rows = conn.execute(
            "SELECT * FROM review_sessions WHERE device=? AND finished_at!=''"
            " ORDER BY finished_at DESC, started_at DESC LIMIT ?",
            (device, limit),
        ).fetchall()
    return [dict(r) for r in rows]


def line_audio_path(island_id: str, idx: int) -> Path:
    return AUDIO_DIR / island_id / f"{idx}.wav"


def take_paths(island_id: str, idx: int) -> tuple[Path, Path]:
    """Where a line's take pair lives: the untouched upload and the version
    with the echo removed. The per-island folder is created on first use,
    since islands built before this feature predate it."""
    folder = TAKES_DIR / island_id
    folder.mkdir(parents=True, exist_ok=True)
    return folder / f"{idx}.raw.wav", folder / f"{idx}.clean.wav"


# Video rows (add_video through set_repair_result, list_videos) live in store_video.py.
