"""Voice previews must answer Range (iOS AVPlayer refuses a plain body),
also when a hosted voice fell back to the free one."""

import io
import wave

from fastapi.testclient import TestClient

import config
import main
import tts_cache
import tts_registry
import voices
from tts_registry import Render

client = TestClient(main.app)
AUTH = {"Authorization": f"Bearer {config.SHADOW_TOKEN}"}


def _wav() -> bytes:
    buf = io.BytesIO()
    with wave.open(buf, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(24000)
        w.writeframes(b"\x01\x00" * 2400)
    return buf.getvalue()


def _preview(monkeypatch, requested: int, rendered: int):
    wav = _wav()
    tts_cache.put(rendered, "x", Render(wav=wav, duration=0.1, voice=rendered))

    async def fake(text, speaker, device="", speed=1.0):
        tts_cache.put(rendered, text, Render(wav=wav, duration=0.1, voice=rendered))
        return Render(wav=wav, duration=0.1, voice=rendered, fallback="" if rendered == requested else "disabled")

    monkeypatch.setattr(voices, "render", fake)
    r = client.get(f"/shadow/voices/{requested}/preview", headers={**AUTH, "X-Shadow-Device": "0123456789abcdef0123456789abcdef", "Range": "bytes=0-1"})
    return r, wav


def test_local_preview_is_206(monkeypatch):
    sid = next(v.id for v in tts_registry.voices_for("en") if not v.hosted)
    r, _ = _preview(monkeypatch, sid, sid)
    assert r.status_code == 206 and r.headers["content-range"].startswith("bytes 0-1/")


def test_fallback_preview_is_206(monkeypatch):
    # Any two ids stand in for "hosted voice" and "free voice it fell back to".
    hosted, free = 10001, 10002
    r, wav = _preview(monkeypatch, hosted, free)
    assert r.status_code == 206 and r.headers["content-range"].startswith("bytes 0-1/")
    full = client.get(f"/shadow/voices/{hosted}/preview", headers={**AUTH, "X-Shadow-Device": "0123456789abcdef0123456789abcdef"})
    assert full.content == wav
