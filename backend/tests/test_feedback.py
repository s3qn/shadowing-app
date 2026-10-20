"""Tests for POST /shadow/feedback (feedback.py). Calls the route function
directly with UploadFile objects, no TestClient and no network."""

import asyncio
import io
import json

import pytest
from fastapi import BackgroundTasks, HTTPException, UploadFile

import feedback
import main

REAL_TRANSCRIBE_REPORT = feedback.transcribe_report
AUTH = f"Bearer {main.SHADOW_TOKEN}"
JPEG = b"\xff\xd8\xff\xe0" + b"0" * 64
PNG = b"\x89PNG\r\n\x1a\n" + b"0" * 64
HEIC = b"\x00\x00\x00\x18ftypheic" + b"0" * 64
WEBP = b"RIFF\x00\x00\x00\x00WEBP" + b"0" * 64
M4A = b"\x00\x00\x00\x20ftypM4A " + b"0" * 64
META = {"platform": "ios", "deviceBrand": "Apple", "deviceModel": "iPhone 15",
        "osVersion": "18.1", "appVersion": "1.2.3", "buildNumber": "42", "route": "/island"}


@pytest.fixture(autouse=True)
def _env(tmp_path, monkeypatch):
    monkeypatch.setenv("FEEDBACK_DIR", str(tmp_path / "fb"))
    feedback._hits.clear()
    scheduled = []
    monkeypatch.setattr(feedback, "transcribe_report", lambda folder: scheduled.append(folder))
    return scheduled


def up(data: bytes, name="f") -> UploadFile:
    return UploadFile(file=io.BytesIO(data), filename=name)


def post(kind="bug", text="it broke", meta=None, voice=None, images=(), device="dev1", auth=AUTH):
    bg = BackgroundTasks()
    res = asyncio.run(feedback.submit_feedback(
        bg, kind=kind, text=text, meta=json.dumps(META if meta is None else meta),
        voice=voice, images=list(images), authorization=auth, x_shadow_device=device))
    return res, bg


def test_happy_path_layout_and_report(tmp_path):
    res, _ = post(images=[up(JPEG), up(PNG)])
    assert res["kind"] == "bug"
    folder = tmp_path / "fb" / "bugs" / res["id"]
    assert sorted(p.name for p in folder.iterdir()) == ["img-1.jpg", "img-2.png", "meta.json", "report.md"]
    md = (folder / "report.md").read_text()
    for needle in ["it broke", "dev1", "ios", "Apple iPhone 15", "18.1", "1.2.3", "42", "/island", "img-1.jpg"]:
        assert needle in md
    meta = json.loads((folder / "meta.json").read_text())
    assert meta["user_id"] == "dev1" and "received_at" in meta and "ip" not in meta
    lines = (tmp_path / "fb" / "index.jsonl").read_text().splitlines()
    assert json.loads(lines[0])["id"] == res["id"]


def test_suggestion_routes_to_suggestions(tmp_path):
    res, _ = post(kind="suggestion")
    assert (tmp_path / "fb" / "suggestions" / res["id"] / "report.md").exists()
    assert not (tmp_path / "fb" / "bugs").exists()


def test_voice_schedules_transcript(tmp_path, _env):
    res, bg = post(text="", voice=up(M4A))
    assert (tmp_path / "fb" / "bugs" / res["id"] / "voice.m4a").exists()
    asyncio.run(bg())
    assert len(_env) == 1 and _env[0].name == res["id"]


def test_no_voice_schedules_nothing(_env):
    _, bg = post()
    asyncio.run(bg())
    assert _env == []


def test_transcript_patches_report(tmp_path, monkeypatch):
    import transcribe
    monkeypatch.setattr(transcribe, "transcribe", lambda p: {"ok": True, "text": "hello there"})
    res, _ = post(text="", voice=up(M4A))
    folder = tmp_path / "fb" / "bugs" / res["id"]
    REAL_TRANSCRIBE_REPORT(folder)
    assert (folder / "transcript.txt").read_text().strip() == "hello there"
    assert "hello there" in (folder / "report.md").read_text()


def test_transcript_failure_writes_error(tmp_path, monkeypatch):
    import transcribe
    monkeypatch.setattr(transcribe, "transcribe", lambda p: {"ok": False})
    res, _ = post(text="", voice=up(M4A))
    folder = tmp_path / "fb" / "bugs" / res["id"]
    REAL_TRANSCRIBE_REPORT(folder)
    assert (folder / "transcript-error.txt").exists()


def test_all_image_types_sniffed(tmp_path):
    res, _ = post(images=[up(JPEG, "a.png"), up(PNG), up(HEIC), up(WEBP)])
    names = {p.name for p in (tmp_path / "fb" / "bugs" / res["id"]).iterdir()}
    assert {"img-1.jpg", "img-2.png", "img-3.heic", "img-4.webp"} <= names


def test_bad_magic_bytes_rejected():
    with pytest.raises(HTTPException) as e:
        post(images=[up(b"GIF89a" + b"0" * 50)])
    assert e.value.status_code == 400


def test_five_images_rejected():
    with pytest.raises(HTTPException) as e:
        post(images=[up(JPEG) for _ in range(5)])
    assert e.value.status_code == 400


def test_oversize_image_413():
    with pytest.raises(HTTPException) as e:
        post(images=[up(JPEG + b"0" * (feedback.MAX_IMAGE_BYTES + 1))])
    assert e.value.status_code == 413


def test_oversize_voice_413():
    with pytest.raises(HTTPException) as e:
        post(voice=up(M4A + b"0" * feedback.MAX_VOICE_BYTES))
    assert e.value.status_code == 413


def test_long_text_413():
    with pytest.raises(HTTPException) as e:
        post(text="x" * 4001)
    assert e.value.status_code == 413


def test_bad_kind_and_empty_400():
    with pytest.raises(HTTPException) as e:
        post(kind="rant")
    assert e.value.status_code == 400
    with pytest.raises(HTTPException) as e:
        post(text="  ")
    assert e.value.status_code == 400


def test_auth_required():
    with pytest.raises(HTTPException) as e:
        post(auth=None)
    assert e.value.status_code == 401


def test_rate_limit_per_user():
    for _ in range(20):
        post()
    with pytest.raises(HTTPException) as e:
        post()
    assert e.value.status_code == 429
    post(device="other")
