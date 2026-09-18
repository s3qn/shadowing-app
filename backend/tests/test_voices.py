"""Tests for voices.py: the one integer voice id space across VOICEVOX (ja)
and Kokoro (en, es). Kokoro and VOICEVOX are always monkeypatched here, no
model load and no VOICEVOX server."""

import asyncio
import io
import wave

import pytest

import voices


# ---------------------------------------------------------------------------
# engine_for / language_for / default_speaker
# ---------------------------------------------------------------------------

def test_engine_for_splits_on_the_kokoro_id_space():
    assert voices.engine_for(1) == "voicevox"
    assert voices.engine_for(10001) == "kokoro"


def test_language_for_voicevox_ids_is_always_ja():
    assert voices.language_for(1) == "ja"
    assert voices.language_for(3) == "ja"


def test_language_for_kokoro_ids_matches_the_voice_table():
    assert voices.language_for(10001) == "en"  # af_bella, en-us
    assert voices.language_for(10011) == "es"  # ef_dora, es


def test_default_speaker_by_language():
    assert voices.default_speaker("es") == 10011
    assert voices.default_speaker("en") == 10001
    import voicevox
    assert voices.default_speaker("ja") == voicevox.DEFAULT_SPEAKER


# ---------------------------------------------------------------------------
# list_speakers
# ---------------------------------------------------------------------------

def test_list_speakers_es_shape():
    out = asyncio.run(voices.list_speakers("es"))
    assert len(out) == 1
    speaker = out[0]
    assert speaker["uuid"] == "kokoro-es"
    assert speaker["name"] == "Spanish"
    assert speaker["policy"] == ""
    ids = {s["id"] for s in speaker["styles"]}
    assert ids == {10011, 10012}
    for style in speaker["styles"]:
        assert style["icon"] == ""
        assert "(" in style["name"]


def test_list_speakers_en_shape_has_four_voices():
    out = asyncio.run(voices.list_speakers("en"))
    assert len(out) == 1
    ids = {s["id"] for s in out[0]["styles"]}
    assert ids == {10001, 10002, 10003, 10004}


# ---------------------------------------------------------------------------
# speak
# ---------------------------------------------------------------------------

def _wav_bytes(sample_rate: int, n_samples: int) -> bytes:
    buf = io.BytesIO()
    with wave.open(buf, "wb") as dst:
        dst.setnchannels(1)
        dst.setsampwidth(2)
        dst.setframerate(sample_rate)
        dst.writeframes(b"\x00\x00" * n_samples)
    return buf.getvalue()


def test_speak_routes_a_kokoro_id_to_kokoro_tts(monkeypatch):
    fake_wav = _wav_bytes(24000, 24000)  # 1 second at 24kHz

    def fake_synthesize(text, voice, lang, speed=1.0):
        assert voice == "ef_dora"
        assert lang == "es"
        return fake_wav, 1.0

    monkeypatch.setattr(voices.kokoro_tts, "synthesize", fake_synthesize)

    wav, timeline, duration, kana = asyncio.run(voices.speak("Hola", 10011))

    assert timeline == []
    assert kana == ""
    assert duration == 1.0
    with wave.open(io.BytesIO(wav), "rb") as src:
        assert src.getframerate() == 24000


def test_speak_routes_a_voicevox_id_to_voicevox(monkeypatch):
    async def fake_speak(text, speaker, speed=1.0):
        assert speaker == 3
        return b"wav-bytes", [{"mora": "こ"}], 0.9, "こんにちは"

    monkeypatch.setattr(voices.voicevox, "speak", fake_speak)

    wav, timeline, duration, kana = asyncio.run(voices.speak("こんにちは", 3))

    assert wav == b"wav-bytes"
    assert timeline == [{"mora": "こ"}]
    assert duration == 0.9
    assert kana == "こんにちは"
