"""Tester feedback inbox: POST /shadow/feedback.

Each report (bug or suggestion, with text, an optional voice note and up to
four screenshots) becomes its own folder under FEEDBACK_DIR so it can be read
with plain file tools. Own bearer check (via suggest) because `main` imports
this module.
"""

import json
import logging
import os
import re
import secrets
import shutil
import tempfile
import threading
import time
from datetime import datetime, timezone
from pathlib import Path

from fastapi import APIRouter, BackgroundTasks, File, Form, Header, HTTPException, UploadFile

import store
from suggest import _require_token

log = logging.getLogger("shadow")

router = APIRouter()

MAX_TEXT_CHARS = 4000
MAX_IMAGES = 4
MAX_VOICE_BYTES = 10 * 1024 * 1024
MAX_IMAGE_BYTES = 8 * 1024 * 1024
RATE_LIMIT = 20
RATE_WINDOW_S = 3600
KINDS = {"bug": "bugs", "suggestion": "suggestions"}

_hits: dict[str, list[float]] = {}
_hits_lock = threading.Lock()


def feedback_dir() -> Path:
    env = os.getenv("FEEDBACK_DIR")
    return Path(env) if env else store.DATA_DIR / "feedback"


def sniff_image(data: bytes) -> str | None:
    """Extension for a jpeg/png/heic/webp payload by magic bytes, else None."""
    if data[:3] == b"\xff\xd8\xff":
        return "jpg"
    if data[:8] == b"\x89PNG\r\n\x1a\n":
        return "png"
    if data[:4] == b"RIFF" and data[8:12] == b"WEBP":
        return "webp"
    if data[4:8] == b"ftyp" and data[8:12] in (
        b"heic", b"heix", b"hevc", b"hevx", b"heim", b"heis", b"mif1", b"msf1",
    ):
        return "heic"
    return None


def sniff_voice(data: bytes) -> str | None:
    if data[4:8] == b"ftyp":
        return "m4a"
    if data[:4] == b"\x1a\x45\xdf\xa3":
        return "webm"
    if data[:2] in (b"\xff\xf1", b"\xff\xf9"):
        return "aac"
    return None


def _rate_check(user: str) -> None:
    now = time.time()
    with _hits_lock:
        recent = [t for t in _hits.get(user, []) if now - t < RATE_WINDOW_S]
        if len(recent) >= RATE_LIMIT:
            _hits[user] = recent
            raise HTTPException(429, "too many reports, try again later")
        recent.append(now)
        _hits[user] = recent


async def _read_capped(f: UploadFile, limit: int) -> bytes:
    data = await f.read(limit + 1)
    if len(data) > limit:
        raise HTTPException(413, "file too large")
    return data


def _slug(s: str) -> str:
    return re.sub(r"[^a-z0-9_-]", "", s.lower())[:24] or "user"


def render_report(meta: dict, text: str, files: list[str], transcript: str = "") -> str:
    def g(k: str) -> str:
        return str(meta.get(k) or "")

    lines = [
        f"# {meta['kind']} report",
        "",
        f"- Kind: {meta['kind']}",
        f"- Time (UTC): {meta['received_at']}",
        f"- User id: {meta['user_id']}",
        f"- Username: {meta.get('username') or ''}",
        f"- Platform: {g('platform')}",
        f"- Device: {g('deviceBrand')} {g('deviceModel')}".rstrip(),
        f"- OS: {g('osVersion')}",
        f"- App version: {g('appVersion')} (build {g('buildNumber')})",
        f"- Route: {g('route')}",
        f"- UI language: {g('uiLanguage')}",
        f"- Learning language: {g('learningLanguage')}",
        f"- Locale: {g('locale')}",
        f"- Guide step: {g('guideStep')}",
        f"- Client time: {g('clientTime')}",
        "",
        "## Text",
        "",
        text or "(none)",
        "",
        "## Transcript",
        "",
        transcript or "(none yet)" if any(f.startswith("voice.") for f in files) else "(no voice note)",
        "",
        "## Files",
        "",
    ]
    lines += [f"- {f}" for f in files] or ["- (none)"]
    return "\n".join(lines) + "\n"


def transcribe_report(folder: Path) -> None:
    """Transcribes the voice note with the shared whisper model and patches
    report.md. Never raises: a failure writes transcript-error.txt."""
    try:
        import transcribe

        voice = next(folder.glob("voice.*"), None)
        if voice is None:
            return
        res = transcribe.transcribe(voice)
        if not res.get("ok"):
            raise RuntimeError("transcription failed")
        text = (res.get("text") or "").strip()
        (folder / "transcript.txt").write_text(text + "\n", encoding="utf-8")
        report = folder / "report.md"
        body = report.read_text(encoding="utf-8")
        body = body.replace("(none yet)", text or "(no speech heard)", 1)
        report.write_text(body, encoding="utf-8")
    except Exception as e:
        log.exception("feedback transcript failed")
        try:
            (folder / "transcript-error.txt").write_text(str(e) + "\n", encoding="utf-8")
        except Exception:
            pass


@router.post("/shadow/feedback")
async def submit_feedback(
    background: BackgroundTasks,
    kind: str = Form(...),
    text: str = Form(""),
    meta: str = Form("{}"),
    voice: UploadFile | None = File(None),
    images: list[UploadFile] = File(default_factory=list),
    authorization: str | None = Header(None),
    x_shadow_device: str = Header(""),
) -> dict:
    _require_token(authorization)
    if kind not in KINDS:
        raise HTTPException(400, "kind must be bug or suggestion")
    if not x_shadow_device:
        raise HTTPException(401, "missing device id")
    if len(text) > MAX_TEXT_CHARS:
        raise HTTPException(413, "text too long")
    if len(images) > MAX_IMAGES:
        raise HTTPException(400, "at most 4 images")
    try:
        client = json.loads(meta or "{}")
        if not isinstance(client, dict):
            raise ValueError
    except ValueError:
        raise HTTPException(400, "meta must be a JSON object")

    voice_data = await _read_capped(voice, MAX_VOICE_BYTES) if voice else b""
    image_data = []
    for f in images:
        data = await _read_capped(f, MAX_IMAGE_BYTES)
        if not data:
            continue
        ext = sniff_image(data)
        if ext is None:
            raise HTTPException(400, "images must be jpeg, png, heic or webp")
        image_data.append((ext, data))
    voice_ext = None
    if voice_data:
        voice_ext = sniff_voice(voice_data)
        if voice_ext is None:
            raise HTTPException(400, "unsupported voice format")
    if not text.strip() and not voice_data and not image_data:
        raise HTTPException(400, "empty report")

    _rate_check(x_shadow_device)

    import user_profile

    try:
        username = user_profile.get_username(x_shadow_device) or ""
    except Exception:
        username = ""
    now = datetime.now(timezone.utc)
    received = now.strftime("%Y-%m-%dT%H:%M:%SZ")
    name = _slug(username or x_shadow_device[:8])
    fid = f"{now.strftime('%Y%m%d-%H%M%S')}-{name}-{secrets.token_hex(3)}"
    full = {
        **client,
        "kind": kind,
        "user_id": x_shadow_device,
        "username": username,
        "received_at": received,
    }
    files = []
    root = feedback_dir()
    target_parent = root / KINDS[kind]
    target_parent.mkdir(parents=True, exist_ok=True)
    tmp = Path(tempfile.mkdtemp(prefix=".tmp-", dir=target_parent))
    try:
        if voice_data:
            (tmp / f"voice.{voice_ext}").write_bytes(voice_data)
            files.append(f"voice.{voice_ext}")
        for i, (ext, data) in enumerate(image_data, 1):
            (tmp / f"img-{i}.{ext}").write_bytes(data)
            files.append(f"img-{i}.{ext}")
        files += ["meta.json", "report.md"]
        (tmp / "meta.json").write_text(json.dumps(full, indent=2, ensure_ascii=False), encoding="utf-8")
        (tmp / "report.md").write_text(render_report(full, text, files), encoding="utf-8")
        final = target_parent / fid
        os.rename(tmp, final)
    except Exception:
        shutil.rmtree(tmp, ignore_errors=True)
        raise
    entry = {
        "id": fid, "kind": kind, "received_at": received, "user_id": x_shadow_device,
        "username": username, "path": f"{KINDS[kind]}/{fid}",
        "text": text[:200], "platform": client.get("platform"),
        "device": f"{client.get('deviceBrand') or ''} {client.get('deviceModel') or ''}".strip(),
        "has_voice": bool(voice_data), "images": len(image_data),
    }
    with open(root / "index.jsonl", "a", encoding="utf-8") as fh:
        fh.write(json.dumps(entry, ensure_ascii=False) + "\n")
    if voice_data:
        background.add_task(transcribe_report, final)
    return {"id": fid, "kind": kind}
