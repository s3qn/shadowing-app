"""tts_local against a stub worker script: spawn, request, idle stop, one
engine at a time, a crash surfaces as LocalTtsError. No model, no systemd:
the command builder is patched. Plus the Arabic tashkeel step as a pure
function."""

import asyncio
import io
import sys
import textwrap
import wave

import pytest

import tts_local
import tts_worker

STUB = textwrap.dedent("""
    import json, sys, wave
    engine = sys.argv[1]
    print(json.dumps({"ready": True}), flush=True)
    for raw in sys.stdin:
        req = json.loads(raw)
        if req["text"] == "crash":
            sys.exit(3)
        with wave.open(req["out"], "wb") as w:
            w.setnchannels(1); w.setsampwidth(2); w.setframerate(24000)
            w.writeframes(b"\\x00\\x00" * 12000)
        print(json.dumps({"duration": 0.5, "engine": engine}), flush=True)
""")


@pytest.fixture
def stub(monkeypatch, tmp_path):
    script = tmp_path / "stub_worker.py"
    script.write_text(STUB, encoding="utf-8")
    monkeypatch.setattr(tts_local, "build_command",
                        lambda engine, scope: [sys.executable, str(script), engine])
    monkeypatch.setattr(tts_local, "mem_available_mb", lambda: 8000)
    monkeypatch.setattr(tts_local, "IDLE_S", 0.1)
    monkeypatch.setattr(tts_local, "_worker", None)
    monkeypatch.setattr(tts_local, "_idle_task", None)
    monkeypatch.setattr(tts_local, "_lock", asyncio.Lock())
    yield script


def test_request_renders_through_the_worker_then_idles_out(stub):
    async def run():
        wav, duration = await tts_local.request("bluetts", "שלום", "noa", "he")
        proc = tts_local._worker.proc
        assert tts_local._worker.engine == "bluetts"
        await asyncio.sleep(0.4)
        assert tts_local._worker is None
        assert proc.returncode is not None
        return wav, duration

    wav, duration = asyncio.run(run())
    assert duration == 0.5
    with wave.open(io.BytesIO(wav), "rb") as w:
        assert (w.getframerate(), w.getnchannels()) == (24000, 1)


def test_second_engine_stops_the_first(stub, monkeypatch):
    monkeypatch.setattr(tts_local, "IDLE_S", 60)

    async def run():
        await tts_local.request("bluetts", "a", "noa", "he")
        first = tts_local._worker.proc
        await tts_local.request("melo", "b", "KR", "ko")
        assert tts_local._worker.engine == "melo"
        await first.wait()
        assert first.returncode is not None
        await tts_local._stop()

    asyncio.run(run())


def test_low_memory_refuses_to_start(stub, monkeypatch):
    monkeypatch.setattr(tts_local, "mem_available_mb", lambda: 1000)
    with pytest.raises(tts_local.LocalTtsError, match="low memory"):
        asyncio.run(tts_local.request("nabra", "a", "af_msa", "ar"))
    assert tts_local._worker is None


def test_crash_surfaces_as_local_tts_error(stub, monkeypatch):
    monkeypatch.setattr(tts_local, "IDLE_S", 60)

    async def run():
        with pytest.raises(tts_local.LocalTtsError):
            await tts_local.request("nabra", "crash", "af_msa", "ar")
        # The next request starts a fresh worker instead of a dead one.
        wav, _ = await tts_local.request("nabra", "fine", "af_msa", "ar")
        assert wav[:4] == b"RIFF"
        await tts_local._stop()

    asyncio.run(run())


def test_arabic_prepare_normalises_then_diacritises():
    seen = {}

    def normalize(text):
        seen["norm"] = text
        return text.replace("آ", "ا"), None

    def diacritize(text, taskeen_threshold):
        seen["dia"] = (text, taskeen_threshold)
        return text + "َ"

    out = tts_worker.arabic_prepare("آنا", normalize, diacritize)
    assert seen == {"norm": "آنا", "dia": ("انا", 0.8)}
    assert out == "اناَ"


def test_queued_requests_drain_before_the_engine_switches(stub, monkeypatch):
    monkeypatch.setattr(tts_local, "IDLE_S", 60)
    order = []

    async def run():
        await tts_local.request("bluetts", "warm", "noa", "he")

        async def one(engine, key, lang, label):
            await tts_local.request(engine, label, key, lang)
            order.append(engine)

        await asyncio.gather(
            one("bluetts", "noa", "he", "a"),
            one("melo", "KR", "ko", "m"),
            one("bluetts", "noa", "he", "b"),
        )
        await tts_local._stop()

    asyncio.run(run())
    assert order == ["bluetts", "bluetts", "melo"]
