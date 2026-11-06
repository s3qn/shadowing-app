"""Video rows: YouTube shadowing, the aligner queue and the ASR context repair.

Split out of store.py. Every function opens its connection through
`store.connect()` so a patched `store.DB_PATH` holds here too."""
import json
from pathlib import Path

import store


# --- youtube-shadowing ---
def add_video(island_id: str, video_id: str, start_s: float, title: str, author: str) -> None:
    with store.connect() as conn:
        conn.execute(
            "INSERT OR REPLACE INTO videos (island_id, video_id, start_s, title, author,"
            " created_at) VALUES (?, ?, ?, ?, ?, ?)",
            (island_id, video_id, start_s, title, author, store._now()),
        )


def set_video_duration(island_id: str, duration: float) -> None:
    with store.connect() as conn:
        conn.execute("UPDATE videos SET duration=? WHERE island_id=?", (duration, island_id))


# --- bl36-align ---
def video_audio_path(island_id: str, kind: str = "src") -> Path:
    """Scratch audio for the aligner: the phone's upload ("src"), the 16 kHz wav
    ("wav") and the job files. The per-island folder is made on first use."""
    folder = store.VIDEO_AUDIO_DIR / island_id
    folder.mkdir(parents=True, exist_ok=True)
    return folder / kind


def set_align_status(island_id: str, status: str, error: str = "",
                     count_attempt: bool = False) -> None:
    with store.connect() as conn:
        conn.execute(
            "UPDATE videos SET align_status=?, align_error=?,"
            " align_attempts=align_attempts+? WHERE island_id=?",
            (status, error, 1 if count_attempt else 0, island_id),
        )


def claim_align(island_id: str, max_attempts: int) -> bool:
    """Mark the video queued if it is idle ('' or failed) and has attempts left.
    One UPDATE, so of two racing uploads only one wins."""
    with store.connect() as conn:
        cur = conn.execute(
            "UPDATE videos SET align_status='queued', align_error=''"
            " WHERE island_id=? AND align_status IN ('','failed') AND align_attempts<?",
            (island_id, max_attempts),
        )
    return cur.rowcount == 1


def island_status(island_id: str) -> str | None:
    with store.connect() as conn:
        row = conn.execute("SELECT status FROM islands WHERE id=?", (island_id,)).fetchone()
    return row["status"] if row else None


def list_align_pending() -> list[str]:
    """Island ids whose alignment was queued or running when the process died."""
    with store.connect() as conn:
        rows = conn.execute(
            "SELECT island_id FROM videos WHERE align_status IN ('queued','running')"
            " ORDER BY created_at"
        ).fetchall()
    return [r["island_id"] for r in rows]


def set_line_span(island_id: str, idx: int, offset: float, duration: float) -> None:
    with store.connect() as conn:
        conn.execute(
            "UPDATE lines SET offset=?, duration=? WHERE island_id=? AND idx=?",
            (offset, duration, island_id, idx),
        )
# --- end bl36-align ---


def get_video(island_id: str) -> dict | None:
    with store.connect() as conn:
        row = conn.execute("SELECT * FROM videos WHERE island_id=?", (island_id,)).fetchone()
    return dict(row) if row else None


# --- youtube-asr-context-repair ---
def set_line_text(island_id: str, idx: int, ja: str, kana: str, words: list,
                  sure: int | None, expected_ja: str) -> bool:
    """Replace one line's text, reading, word times and verdict, only while
    its text still equals `expected_ja` (checked inside one write lock, like
    _set_line_json), so a repair computed from an older read never overwrites
    a line that moved in the meantime. Returns True when a row was written."""
    conn = store.connect()
    conn.execute("BEGIN IMMEDIATE")
    try:
        row = conn.execute(
            "SELECT ja FROM lines WHERE island_id=? AND idx=?", (island_id, idx)
        ).fetchone()
        if row is None or row["ja"] != expected_ja:
            conn.rollback()
            return False
        cur = conn.execute(
            "UPDATE lines SET ja=?, kana=?, words=?, sure=? WHERE island_id=? AND idx=?",
            (ja, kana, json.dumps(words, ensure_ascii=False), sure, island_id, idx),
        )
        conn.commit()
        return cur.rowcount > 0
    except Exception:
        conn.rollback()
        raise


def set_line_sure(island_id: str, idx: int, sure: int | None) -> None:
    with store.connect() as conn:
        conn.execute("UPDATE lines SET sure=? WHERE island_id=? AND idx=?", (sure, island_id, idx))


def set_repair_status(island_id: str, status: str, error: str = "",
                      version: int | None = None, count_attempt: bool = False) -> None:
    with store.connect() as conn:
        conn.execute(
            "UPDATE videos SET repair_status=?, repair_error=?,"
            " repair_attempts=repair_attempts+?, repair_version=COALESCE(?, repair_version)"
            " WHERE island_id=?",
            (status, error, 1 if count_attempt else 0, version, island_id),
        )


def set_lines_dropped(island_id: str, n: int) -> None:
    """Caption lines cut at the line cap, reported by /video as lines_dropped."""
    with store.connect() as conn:
        conn.execute("UPDATE videos SET lines_dropped=? WHERE island_id=?", (n, island_id))


def claim_repair(island_id: str, max_attempts: int, version: int) -> bool:
    """Mark the video's repair queued and count the attempt if it is idle
    ('' or failed, or done at an older version) and has attempts left. One
    UPDATE, so of two racing callers only one wins."""
    with store.connect() as conn:
        cur = conn.execute(
            "UPDATE videos SET repair_status='queued', repair_error='',"
            " repair_attempts=repair_attempts+1"
            " WHERE island_id=? AND repair_attempts<?"
            " AND (repair_status IN ('','failed')"
            "      OR (repair_status='done' AND repair_version<?))",
            (island_id, max_attempts, version),
        )
    return cur.rowcount == 1


def list_repair_pending() -> list[str]:
    """Island ids whose repair was queued or running when the process died."""
    with store.connect() as conn:
        rows = conn.execute(
            "SELECT island_id FROM videos WHERE repair_status IN ('queued','running')"
            " ORDER BY created_at"
        ).fetchall()
    return [r["island_id"] for r in rows]


def get_repair(video_id: str) -> dict | None:
    """The per-video repair row with `context` and `result` parsed
    (`result` is None until a pass has run)."""
    with store.connect() as conn:
        row = conn.execute("SELECT * FROM video_repairs WHERE video_id=?", (video_id,)).fetchone()
    if row is None:
        return None
    out = dict(row)
    try:
        out["context"] = json.loads(out["context"] or "{}")
    except ValueError:
        out["context"] = {}
    try:
        out["result"] = json.loads(out["result"]) if out["result"] else None
    except ValueError:
        out["result"] = None
    return out


def _context_is_empty(context: dict | None) -> bool:
    return not context or not any(context.get(k) for k in
                                  ("title", "author", "description", "keywords", "chapters"))


def set_repair_context(video_id: str, context: dict | None) -> None:
    """Store the phone's video context. An empty context (web, offline, an
    old build) keeps whatever an earlier open stored."""
    now = store._now()
    with store.connect() as conn:
        conn.execute(
            "INSERT OR IGNORE INTO video_repairs (video_id, context, updated_at) VALUES (?, '{}', ?)",
            (video_id, now),
        )
        if not _context_is_empty(context):
            conn.execute(
                "UPDATE video_repairs SET context=?, updated_at=? WHERE video_id=?",
                (json.dumps(context, ensure_ascii=False), now, video_id),
            )


def set_repair_result(video_id: str, version: int, lines_hash: str, result: dict) -> None:
    now = store._now()
    with store.connect() as conn:
        conn.execute(
            "INSERT OR IGNORE INTO video_repairs (video_id, context, updated_at) VALUES (?, '{}', ?)",
            (video_id, now),
        )
        conn.execute(
            "UPDATE video_repairs SET version=?, lines_hash=?, result=?, updated_at=? WHERE video_id=?",
            (version, lines_hash, json.dumps(result, ensure_ascii=False), now, video_id),
        )
# --- end youtube-asr-context-repair ---


def list_videos(device: str) -> list[dict]:
    """A device's video islands, newest first."""
    with store.connect() as conn:
        rows = conn.execute(
            "SELECT v.island_id, v.video_id, v.title, i.status, i.stage, i.error_code,"
            " v.created_at,"
            " (SELECT COUNT(*) FROM lines l WHERE l.island_id=i.id) AS line_count"
            " FROM videos v JOIN islands i ON i.id=v.island_id"
            " WHERE i.device=? ORDER BY v.created_at DESC, v.rowid DESC",
            (device,),
        ).fetchall()
    return [dict(r) for r in rows]
