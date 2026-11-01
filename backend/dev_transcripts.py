"""Dev-only transcript review: Sean judges ASR candidates on the gold videos.

Reads JSON only from SHADOW_GOLD_DIR (default ~/shadow-gold): the per-video
`<channel>/<id>/<id>.info.json` and `_cache/**/<id>.json` candidates. Media
files are never listed, opened or served. Candidates are shown under blind
labels (A, B, C...), shuffled but stable per (session, video); the label to
candidate key map goes only into transcript-tags.jsonl. Mounted only when
SHADOW_ENV is not "prod". Own bearer check, as in dev_review.py.
"""

import hashlib
import json
import os
import random
import re
import secrets
import threading
from datetime import datetime, timezone
from pathlib import Path
from typing import Literal

from fastapi import APIRouter, Header, HTTPException
from pydantic import BaseModel, Field

import dev_review

router = APIRouter()

VIDEO_RE = re.compile(r"^[\w-]{6,20}$")
SESSION_RE = re.compile(r"^[\w-]{1,64}$")
LABELS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ"
_lock = threading.Lock()

TAGS = {
    "text": ["correct", "wrong_word", "missing_words", "extra_words", "name_kanji_wrong", "filler_shown"],
    "timing": ["starts_early", "starts_late", "word_offset", "too_fast", "too_slow", "lag_vs_audio"],
    "structure": ["bad_split", "lines_merged", "repeat_loop", "backchannel_shown", "double_caption"],
}
ALL_TAGS = {t for group in TAGS.values() for t in group}
TagName = Literal[
    "correct", "wrong_word", "missing_words", "extra_words", "name_kanji_wrong", "filler_shown",
    "starts_early", "starts_late", "word_offset", "too_fast", "too_slow", "lag_vs_audio",
    "bad_split", "lines_merged", "repeat_loop", "backchannel_shown", "double_caption",
]


def enabled() -> bool:
    return os.getenv("SHADOW_ENV", "dev") != "prod"


def _gold_dir() -> Path:
    env = os.getenv("SHADOW_GOLD_DIR")
    return Path(env) if env else Path.home() / "shadow-gold"


def _tags_file() -> Path:
    return dev_review._tour_file().parent / "transcript-tags.jsonl"


def _require_token(authorization: str | None) -> None:
    token = os.getenv("SHADOW_TOKEN", "")
    if not token:
        raise HTTPException(503, "SHADOW_TOKEN is not configured")
    prefix = "Bearer "
    if not authorization or not authorization.startswith(prefix):
        raise HTTPException(401, "missing bearer token")
    if not secrets.compare_digest(
        authorization[len(prefix):].encode("utf-8"), token.encode("utf-8")
    ):
        raise HTTPException(401, "bad token")


def _read_json(path: Path):
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None


def _scan_videos() -> dict[str, dict]:
    """id -> {id, channel, title}, from `<channel>/<id>/<id>.info.json` only."""
    out: dict[str, dict] = {}
    root = _gold_dir()
    if not root.is_dir():
        return out
    for chan in sorted(root.iterdir()):
        if chan.name.startswith("_") or chan.is_symlink() or not chan.is_dir():
            continue
        for vid in sorted(chan.iterdir()):
            if vid.is_symlink() or not vid.is_dir() or not VIDEO_RE.match(vid.name):
                continue
            info = _read_json(vid / f"{vid.name}.info.json")
            if not isinstance(info, dict):
                continue
            out[vid.name] = {
                "id": vid.name,
                "channel": str(info.get("channel") or info.get("uploader") or chan.name),
                "title": str(info.get("title") or vid.name),
            }
    return out


def _clean_lines(raw) -> list[dict]:
    out = []
    for ln in raw:
        if not isinstance(ln, dict):
            continue
        try:
            start, end = float(ln["start"]), float(ln["end"])
        except (KeyError, TypeError, ValueError):
            continue
        words = None
        if isinstance(ln.get("words"), list) and ln["words"]:
            words = []
            for w in ln["words"]:
                try:
                    words.append({"text": str(w["text"]), "start": float(w["start"]), "end": float(w["end"])})
                except (KeyError, TypeError, ValueError):
                    continue
            words = words or None
        out.append({"start": start, "end": end, "text": str(ln.get("text", "")), "words": words})
    return out


def _candidates(video: str) -> dict[str, list[dict]]:
    """candidate key -> cleaned lines. Key is the path under `_cache` minus the
    filename. Files without a `lines` list are skipped."""
    out: dict[str, list[dict]] = {}
    cache = _gold_dir() / "_cache"
    if not cache.is_dir():
        return out
    for dirpath, dirnames, filenames in os.walk(cache, followlinks=False):
        dirnames[:] = sorted(d for d in dirnames if not d.startswith("_"))
        if f"{video}.json" not in filenames:
            continue
        data = _read_json(Path(dirpath) / f"{video}.json")
        if not isinstance(data, dict) or not isinstance(data.get("lines"), list):
            continue
        key = Path(dirpath).relative_to(cache).as_posix()
        if key == ".":
            continue
        out[key] = _clean_lines(data["lines"])
    return out


def _label_map(session: str, video: str, keys: list[str]) -> dict[str, str]:
    """label -> candidate key, shuffled but stable per (session, video)."""
    seed = int.from_bytes(hashlib.sha256(f"{session}|{video}".encode()).digest()[:8], "big")
    order = sorted(keys)
    random.Random(seed).shuffle(order)
    return {LABELS[i]: k for i, k in enumerate(order[: len(LABELS)])}


def _check_ids(video: str, session: str | None = None) -> None:
    if not VIDEO_RE.match(video):
        raise HTTPException(400, "bad video id")
    if session is not None and not SESSION_RE.match(session):
        raise HTTPException(400, "bad session")


def _resolve(session: str, video: str, label: str) -> str:
    _check_ids(video, session)
    if video not in _scan_videos():
        raise HTTPException(404, "unknown video")
    labels = _label_map(session, video, list(_candidates(video)))
    if label not in labels:
        raise HTTPException(400, "bad label")
    return labels[label]


def _append(row: dict) -> None:
    path = _tags_file()
    with _lock:
        path.parent.mkdir(parents=True, exist_ok=True)
        with path.open("a", encoding="utf-8") as f:
            f.write(json.dumps(row, ensure_ascii=False) + "\n")


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _has_real_words(lines: list[dict]) -> bool:
    """True when some line carries word timing that is not just the whole line as one word."""
    for ln in lines:
        ws = ln["words"]
        if ws and (len(ws) > 1 or ws[0]["text"] != ln["text"]):
            return True
    return False


@router.get("/shadow/dev/transcripts")
def list_transcripts(authorization: str | None = Header(None)):
    _require_token(authorization)
    videos = []
    for v in _scan_videos().values():
        cands = _candidates(v["id"])
        videos.append({
            **v,
            "n_candidates": len(cands),
            "has_words": [_has_real_words(cands[k]) for k in sorted(cands)],
        })
    return {"videos": videos, "tags": TAGS, "dir": str(_gold_dir())}


@router.get("/shadow/dev/transcripts/{video}")
def get_transcript(video: str, session: str, authorization: str | None = Header(None)):
    _require_token(authorization)
    _check_ids(video, session)
    if video not in _scan_videos():
        raise HTTPException(404, "unknown video")
    cands = _candidates(video)
    labels = _label_map(session, video, list(cands))
    return {
        "video": video,
        "candidates": [
            {
                "label": label,
                "has_words": _has_real_words(cands[key]),
                "lines": cands[key],
            }
            for label, key in labels.items()
        ],
    }


class TagBody(BaseModel):
    session: str
    video: str
    label: str = Field(min_length=1, max_length=1)
    tag: TagName
    playerTime: float
    lineIndex: int = Field(ge=-1)
    lineText: str = Field(default="", max_length=500)


class UndoBody(BaseModel):
    session: str


class ScoreBody(BaseModel):
    session: str
    video: str
    label: str = Field(min_length=1, max_length=1)
    score: int = Field(ge=1, le=5)


@router.post("/shadow/dev/transcripts/tag")
def post_tag(body: TagBody, authorization: str | None = Header(None)):
    _require_token(authorization)
    candidate = _resolve(body.session, body.video, body.label)
    _append({
        "ts": _now(), "session": body.session, "video": body.video, "label": body.label,
        "candidate": candidate, "playerTime": body.playerTime, "lineIndex": body.lineIndex,
        "lineText": body.lineText, "tag": body.tag,
    })
    return {"ok": True}


@router.post("/shadow/dev/transcripts/score")
def post_score(body: ScoreBody, authorization: str | None = Header(None)):
    _require_token(authorization)
    candidate = _resolve(body.session, body.video, body.label)
    _append({
        "ts": _now(), "session": body.session, "video": body.video, "label": body.label,
        "candidate": candidate, "tag": f"score:{body.score}",
    })
    return {"ok": True}


@router.post("/shadow/dev/transcripts/undo")
def post_undo(body: UndoBody, authorization: str | None = Header(None)):
    """Remove the last tag line of this session. Scores are not undone."""
    _require_token(authorization)
    _check_ids("undo-check", body.session)
    path = _tags_file()
    with _lock:
        if not path.exists():
            return {"ok": True, "removed": False}
        lines = path.read_text(encoding="utf-8").splitlines()
        for i in range(len(lines) - 1, -1, -1):
            try:
                row = json.loads(lines[i])
            except ValueError:
                continue
            if row.get("session") == body.session and not str(row.get("tag", "")).startswith("score:"):
                del lines[i]
                path.write_text("".join(ln + "\n" for ln in lines), encoding="utf-8")
                return {"ok": True, "removed": True}
    return {"ok": True, "removed": False}
