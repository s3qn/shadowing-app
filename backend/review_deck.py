"""Saved-sentence review deck: one card per sentence a learner stars in a
video or podcast, with its own spaced repetition.

Kept in its own sqlite file (review.db), like schedule.py, so store.py's schema
is untouched. A card snapshots the sentence text at save time and, for lines
that have a wav, a copy of the clip, so it outlives the island.
"""

import json
import os
import shutil
import sqlite3
import threading
import uuid
from datetime import date, datetime, timezone
from pathlib import Path

import dbconn
import spacing
import store

DATA_DIR = Path(os.getenv("SHADOW_DATA_DIR", Path(__file__).parent / "data"))
DB_PATH = DATA_DIR / "review.db"
CLIP_DIR = DATA_DIR / "review"

MAX_CARDS = 500

SCHEMA = """
CREATE TABLE IF NOT EXISTS review_cards (
  id TEXT PRIMARY KEY,
  device TEXT NOT NULL,
  island_id TEXT NOT NULL,
  idx INTEGER NOT NULL,
  island_title TEXT NOT NULL DEFAULT '',
  source TEXT NOT NULL DEFAULT '',
  language TEXT NOT NULL DEFAULT '',
  native TEXT NOT NULL DEFAULT '',
  ja TEXT NOT NULL DEFAULT '',
  kana TEXT NOT NULL DEFAULT '',
  romaji TEXT NOT NULL DEFAULT '',
  en TEXT NOT NULL DEFAULT '',
  words TEXT NOT NULL DEFAULT '[]',
  duration REAL NOT NULL DEFAULT 0,
  kind TEXT NOT NULL,
  video_id TEXT NOT NULL DEFAULT '',
  start_s REAL NOT NULL DEFAULT 0,
  end_s REAL NOT NULL DEFAULT 0,
  level INTEGER NOT NULL DEFAULT 0,
  due_on TEXT NOT NULL,
  last_reviewed_on TEXT NOT NULL DEFAULT '',
  reviews INTEGER NOT NULL DEFAULT 0,
  lapses INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS review_cards_line
  ON review_cards (device, island_id, idx);
"""


def _now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def _today() -> str:
    """The UTC day, the same rule as schedule._today."""
    return datetime.now(timezone.utc).date().isoformat()


_local = threading.local()


def connect() -> sqlite3.Connection:
    return dbconn.thread_conn(_local, DB_PATH, "journal_mode = WAL")


def init() -> None:
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    with connect() as conn:
        conn.executescript(SCHEMA)


def clip_path(card_id: str) -> Path:
    return CLIP_DIR / f"{card_id}.wav"


def _card(row: sqlite3.Row) -> dict:
    card = dict(row)
    card.pop("device", None)
    try:
        card["words"] = json.loads(card["words"])
    except ValueError:
        card["words"] = []
    return card


def count_cards(device: str) -> int:
    with connect() as conn:
        return conn.execute(
            "SELECT COUNT(*) FROM review_cards WHERE device=?", (device,)
        ).fetchone()[0]


def _find(device: str, island_id: str, idx: int) -> sqlite3.Row | None:
    with connect() as conn:
        return conn.execute(
            "SELECT * FROM review_cards WHERE device=? AND island_id=? AND idx=?",
            (device, island_id, idx),
        ).fetchone()


def create_card(device: str, island: dict, line: dict, video: dict | None) -> dict:
    """Saves `line` of `island` as a card. An existing card for the same line
    is returned as is. Raises ValueError("no_audio") when the line has no wav
    and the island has no video row, ValueError("full") at MAX_CARDS."""
    existing = _find(device, island["id"], line["idx"])
    if existing is not None:
        return _card(existing)
    if count_cards(device) >= MAX_CARDS:
        raise ValueError("full")
    card_id = uuid.uuid4().hex[:12]
    wav = store.line_audio_path(island["id"], line["idx"])
    video_id, start_s, end_s = "", 0.0, 0.0
    if wav.exists():
        kind = "clip"
        CLIP_DIR.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(wav, clip_path(card_id))
    elif video is not None:
        kind = "embed"
        video_id = video["video_id"]
        start_s = float(video["start_s"]) + float(line.get("offset") or 0.0)
        end_s = start_s + float(line.get("duration") or 0.0)
    else:
        raise ValueError("no_audio")
    try:
        with connect() as conn:
            conn.execute(
                "INSERT INTO review_cards (id, device, island_id, idx, island_title, source,"
                " language, native, ja, kana, romaji, en, words, duration, kind, video_id,"
                " start_s, end_s, level, due_on, created_at)"
                " VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,0,?,?)",
                (
                    card_id, device, island["id"], line["idx"], island.get("title") or "",
                    island.get("source") or "", island.get("language") or "",
                    island.get("native") or "", line.get("ja") or "", line.get("kana") or "",
                    line.get("romaji") or "", line.get("en") or "",
                    json.dumps(line.get("words") or []), float(line.get("duration") or 0.0),
                    kind, video_id, start_s, end_s, _today(), _now(),
                ),
            )
    except sqlite3.IntegrityError:
        # A concurrent save of the same line won the race.
        clip_path(card_id).unlink(missing_ok=True)
        row = _find(device, island["id"], line["idx"])
        if row is None:
            raise
        return _card(row)
    return get_card(device, card_id)  # type: ignore[return-value]


def get_card(device: str, card_id: str) -> dict | None:
    with connect() as conn:
        row = conn.execute(
            "SELECT * FROM review_cards WHERE id=? AND device=?", (card_id, device)
        ).fetchone()
    return _card(row) if row else None


def list_cards(device: str, island_id: str | None = None) -> list[dict]:
    query = "SELECT * FROM review_cards WHERE device=?"
    params: tuple = (device,)
    if island_id is not None:
        query += " AND island_id=?"
        params = (device, island_id)
    query += " ORDER BY created_at ASC, idx ASC"
    with connect() as conn:
        rows = conn.execute(query, params).fetchall()
    return [_card(r) for r in rows]


def due_cards(device: str, today: str) -> list[dict]:
    with connect() as conn:
        rows = conn.execute(
            "SELECT * FROM review_cards WHERE device=? AND due_on <= ?"
            " ORDER BY due_on ASC, created_at ASC, idx ASC",
            (device, today),
        ).fetchall()
    return [_card(r) for r in rows]


def grade(device: str, card_id: str, result: str, today: str) -> dict | None:
    """Got it climbs one level (capped), Again drops to level 0. Lateness is
    ignored. None when the card is not this device's."""
    card = get_card(device, card_id)
    if card is None:
        return None
    if result == "got":
        level = min(card["level"] + 1, spacing.MAX_LEVEL)
        lapses = card["lapses"]
    else:
        level = 0
        lapses = card["lapses"] + 1
    due_on = spacing.due_date(date.fromisoformat(today), level).isoformat()
    with connect() as conn:
        conn.execute(
            "UPDATE review_cards SET level=?, due_on=?, last_reviewed_on=?,"
            " reviews=reviews+1, lapses=? WHERE id=? AND device=?",
            (level, due_on, today, lapses, card_id, device),
        )
    return get_card(device, card_id)


def delete_card(device: str, card_id: str) -> bool:
    with connect() as conn:
        cur = conn.execute(
            "DELETE FROM review_cards WHERE id=? AND device=?", (card_id, device)
        )
    clip_path(card_id).unlink(missing_ok=True) if cur.rowcount else None
    return cur.rowcount > 0


def delete_owner(device: str) -> None:
    with connect() as conn:
        ids = [r["id"] for r in conn.execute(
            "SELECT id FROM review_cards WHERE device=?", (device,))]
        conn.execute("DELETE FROM review_cards WHERE device=?", (device,))
    for card_id in ids:
        clip_path(card_id).unlink(missing_ok=True)
