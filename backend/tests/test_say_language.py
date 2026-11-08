"""ET-28: the say flow hears Hebrew vs English from the audio instead of
trusting the account's native setting. Every model is a fake; no real
whisper model is ever loaded."""

import asyncio
import sys
from pathlib import Path
from types import ModuleType

import pytest

import generate
import store
import transcribe
from services import build


@pytest.fixture(autouse=True)
def _init_db():
    store.init()


class _Detector:
    def __init__(self, probs=None, boom=False):
        self.probs = probs
        self.boom = boom

    def detect_language(self, audio):
        if self.boom:
            raise RuntimeError("no model")
        return "he", 0.9, list(self.probs.items())


def _detect(monkeypatch, tmp_path, probs=None, boom=False):
    fake = ModuleType("faster_whisper.audio")
    fake.decode_audio = lambda path, sampling_rate=16000: [0.0] * 16000
    monkeypatch.setitem(sys.modules, "faster_whisper.audio", fake)
    monkeypatch.setattr(transcribe, "_get_model", lambda *a: _Detector(probs, boom))
    return transcribe.detect_he_en(tmp_path / "a.wav")


def test_detect_hebrew_wins(monkeypatch, tmp_path):
    assert _detect(monkeypatch, tmp_path, {"he": 0.7, "en": 0.2}) == "he"


def test_detect_english_wins(monkeypatch, tmp_path):
    assert _detect(monkeypatch, tmp_path, {"en": 0.8, "he": 0.05}) == "en"


def test_detect_neither_returns_none(monkeypatch, tmp_path):
    assert _detect(monkeypatch, tmp_path, {"ja": 0.9, "he": 0.02, "en": 0.01}) is None
    assert _detect(monkeypatch, tmp_path, {"he": 0.2, "en": 0.2}) is None


def test_detect_weak_lean_returns_none(monkeypatch, tmp_path):
    assert _detect(monkeypatch, tmp_path, {"en": 0.4, "he": 0.3, "ar": 0.2}) is None


def test_detect_clear_margin_below_confident_p(monkeypatch, tmp_path):
    assert _detect(monkeypatch, tmp_path, {"he": 0.45, "en": 0.05, "ar": 0.4}) == "he"


def test_detect_error_returns_none(monkeypatch, tmp_path):
    assert _detect(monkeypatch, tmp_path, boom=True) is None


# ---- _build_say ------------------------------------------------------------

def _run_say(monkeypatch, detected, native="en", learning="ja", transcript=""):
    calls = {"transcribe": [], "say": [], "detect": 0}

    def fake_detect(wav):
        calls["detect"] += 1
        return detected

    def fake_transcribe(wav, language=None, **kw):
        calls["transcribe"].append((language, kw.get("model")))
        return {"ok": True, "text": "hello"}

    def fake_say(text, learning_, native_, register):
        calls["say"].append(native_)
        return {"intent": "say", "lines": [{"text": "x"}]}

    async def fake_synth(*a, **k):
        return 1

    monkeypatch.setattr(transcribe, "detect_he_en", fake_detect)
    monkeypatch.setattr(transcribe, "transcribe", fake_transcribe)
    monkeypatch.setattr(generate, "say_lines", fake_say)
    monkeypatch.setattr(build, "_synthesize_lines", fake_synth)
    iid = store.create_island("simple", 3, native=native, language=learning)
    asyncio.run(build._build_say(iid, Path("x.wav"), 3, "polite", learning, native,
                                 transcript))
    return iid, calls


def test_hebrew_detected_with_english_account(monkeypatch):
    iid, calls = _run_say(monkeypatch, "he")
    assert calls["transcribe"] == [("he", "he")]
    assert calls["say"] == ["he"]
    assert store.get_island(iid)["native"] == "he"


def test_english_detected_keeps_default_model(monkeypatch):
    iid, calls = _run_say(monkeypatch, "en")
    assert calls["transcribe"] == [("en", "default")]
    assert calls["say"] == ["en"]
    assert store.get_island(iid)["native"] == "en"


def test_undetected_uses_native_setting(monkeypatch):
    iid, calls = _run_say(monkeypatch, None, native="he")
    assert calls["transcribe"] == [("he", "he")]
    assert store.get_island(iid)["native"] == "he"


def test_detected_learning_language_falls_back_to_native(monkeypatch):
    iid, calls = _run_say(monkeypatch, "en", native="he", learning="en")
    assert calls["transcribe"] == [("he", "he")]
    assert store.get_island(iid)["native"] == "he"


def _run_say_probs(monkeypatch, tmp_path, probs, native):
    """_build_say through the real detect_he_en, with a fake encoder."""
    fake = ModuleType("faster_whisper.audio")
    fake.decode_audio = lambda path, sampling_rate=16000: [0.0] * 16000
    monkeypatch.setitem(sys.modules, "faster_whisper.audio", fake)
    monkeypatch.setattr(transcribe, "_get_model", lambda *a: _Detector(probs))
    seen = {}

    def fake_transcribe(wav, language=None, **kw):
        seen["call"] = (language, kw.get("model"))
        return {"ok": True, "text": "hello"}

    monkeypatch.setattr(transcribe, "transcribe", fake_transcribe)
    monkeypatch.setattr(generate, "say_lines",
                        lambda *a: {"intent": "say", "lines": [{"text": "x"}]})

    async def fake_synth(*a, **k):
        return 1

    monkeypatch.setattr(build, "_synthesize_lines", fake_synth)
    iid = store.create_island("simple", 3, native=native, language="ja")
    asyncio.run(build._build_say(iid, tmp_path / "a.wav", 3, "polite", "ja", native))
    return iid, seen["call"]


def test_hebrew_account_weak_english_detection_stays_hebrew(monkeypatch, tmp_path):
    iid, call = _run_say_probs(monkeypatch, tmp_path, {"en": 0.4, "he": 0.3}, "he")
    assert call == ("he", "he")
    assert store.get_island(iid)["native"] == "he"


def test_english_account_confident_hebrew_detection_becomes_hebrew(monkeypatch, tmp_path):
    iid, call = _run_say_probs(monkeypatch, tmp_path, {"he": 0.8, "en": 0.1}, "en")
    assert call == ("he", "he")
    assert store.get_island(iid)["native"] == "he"


def test_dev_transcript_skips_detection(monkeypatch):
    iid, calls = _run_say(monkeypatch, "he", transcript="typed text")
    assert calls["detect"] == 0
    assert calls["transcribe"] == []
    assert calls["say"] == ["en"]


# ---- model registry and idle unload ---------------------------------------

def test_he_model_cached_unloads_only_when_idle_and_reloads(monkeypatch):
    made = []

    class FakeWhisper:
        def __init__(self, size, **kw):
            made.append((size, kw))

    fake = ModuleType("faster_whisper")
    fake.WhisperModel = FakeWhisper
    monkeypatch.setitem(sys.modules, "faster_whisper", fake)
    monkeypatch.setattr(transcribe, "_MODELS", {})
    monkeypatch.setattr(transcribe, "_HE_USERS", 0)
    monkeypatch.setattr(transcribe, "_HE_TIMER", None)

    first = transcribe._get_model("he")
    assert transcribe._get_model("he") is first
    assert len(made) == 1
    assert made[0][0] == transcribe.HE_MODEL_ID
    assert made[0][1]["num_workers"] == 1

    transcribe._he_begin()
    assert transcribe._unload_he_if_idle() is False
    assert "he" in transcribe._MODELS

    monkeypatch.setattr(transcribe, "IVRIT_IDLE_S", 3600)
    transcribe._he_end()
    transcribe._HE_TIMER.cancel()
    assert transcribe._unload_he_if_idle() is True
    assert "he" not in transcribe._MODELS

    assert transcribe._get_model("he") is not first
    assert len(made) == 2


def test_stale_unload_timer_does_nothing(monkeypatch):
    monkeypatch.setattr(transcribe, "_MODELS", {"he": object()})
    monkeypatch.setattr(transcribe, "_HE_USERS", 1)
    monkeypatch.setattr(transcribe, "_HE_TIMER", None)
    monkeypatch.setattr(transcribe, "IVRIT_IDLE_S", 3600)
    transcribe._he_end()
    stale = transcribe._HE_GEN
    transcribe._he_begin()
    transcribe._he_end()
    transcribe._HE_TIMER.cancel()
    assert transcribe._unload_he_if_idle(stale) is False
    assert "he" in transcribe._MODELS
    assert transcribe._unload_he_if_idle(transcribe._HE_GEN) is True


def test_he_load_failure_falls_back_to_default_with_he_language(monkeypatch, tmp_path):
    seen = {}

    class Default:
        def transcribe(self, path, **kw):
            seen.update(kw)
            return iter([]), type("I", (), {"language": "he"})()

    def get(name="medium"):
        if name == "he":
            raise RuntimeError("download failed")
        return Default()

    monkeypatch.setattr(transcribe, "_get_model", get)
    monkeypatch.setattr(transcribe, "IVRIT_IDLE_S", 3600)
    monkeypatch.setattr(transcribe, "_HE_TIMER", None)
    wav = tmp_path / "a.wav"
    wav.write_bytes(b"x")
    res = transcribe.transcribe(wav, "en", model="he")
    transcribe._HE_TIMER.cancel()
    assert res["ok"] is True
    assert seen["language"] == "he"
