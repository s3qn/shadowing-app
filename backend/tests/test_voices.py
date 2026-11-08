"""Tests for voices.py: the facade over tts_registry and tts_render. Kokoro
and VOICEVOX are always monkeypatched here, no model load and no VOICEVOX
server."""

import asyncio
import io
import wave

import tts_fakes
import tts_local
import tts_registry
import voices


# ---------------------------------------------------------------------------
# engine_for / language_for / default_speaker
# ---------------------------------------------------------------------------

def test_engine_for_names_the_provider():
    assert voices.engine_for(1) == "voicevox"
    assert voices.engine_for(10001) == "kokoro"
    assert voices.engine_for(11002) == "bluetts"
    assert voices.engine_for(11101) == "melo"
    assert voices.engine_for(11201) == "nabra"


def test_language_for_voicevox_ids_is_always_ja():
    assert voices.language_for(1) == "ja"
    assert voices.language_for(3) == "ja"


def test_language_for_other_ids_matches_the_voice_table():
    assert voices.language_for(10001) == "en"  # af_bella, en-us
    assert voices.language_for(10011) == "es"  # ef_dora, es
    assert voices.language_for(10021) == "fr"
    assert voices.language_for(10041) == "zh"
    assert voices.language_for(11001) == "de"
    assert voices.language_for(11002) == "he"


def test_default_speaker_by_language():
    import voicevox
    assert voices.default_speaker("es") == 10011
    assert voices.default_speaker("en") == 10001
    assert voices.default_speaker("ja") == voicevox.DEFAULT_SPEAKER
    for lang, vid in tts_registry.DEFAULT_VOICE.items():
        assert voices.default_speaker(lang) == vid


# ---------------------------------------------------------------------------
# list_speakers
# ---------------------------------------------------------------------------

def _local(entries):
    """The local entries only: hosted adapters register when their key is set."""
    return [e for e in entries if e["kind"] == "local"]


def test_list_speakers_es_shape():
    out = _local(asyncio.run(voices.list_speakers("es")))
    assert len(out) == 1
    speaker = out[0]
    assert speaker["uuid"] == "kokoro-es"
    assert speaker["name"] == "Kokoro"
    assert speaker["policy"] == ""
    assert speaker["kind"] == "local"
    assert "limit" not in speaker
    ids = {s["id"] for s in speaker["styles"]}
    assert ids == {10011, 10012}
    for style in speaker["styles"]:
        assert style["icon"] == ""
        assert "(" in style["name"]


def test_list_speakers_en_shape_has_four_voices():
    out = _local(asyncio.run(voices.list_speakers("en")))
    assert len(out) == 1
    ids = {s["id"] for s in out[0]["styles"]}
    assert ids == {10001, 10002, 10003, 10004}


def test_list_speakers_new_languages_hold_their_default(monkeypatch):
    monkeypatch.setattr(tts_local.LocalWorkerProvider, "enabled", lambda self: True)
    for lang in ("fr", "pt", "zh", "de", "he", "ko", "ar"):
        out = asyncio.run(voices.list_speakers(lang))
        ids = {s["id"] for entry in out for s in entry["styles"]}
        assert tts_registry.DEFAULT_VOICE[lang] in ids, lang
        assert out[0]["kind"] == "local"


def test_list_speakers_hosted_entry_comes_last_with_a_limit(monkeypatch):
    tts_fakes.hosted(monkeypatch)
    out = asyncio.run(voices.list_speakers("fr"))
    assert [e["uuid"] for e in out][0] == "kokoro-fr"
    hosted = next(e for e in out if e["uuid"] == "fakehosted-fr")
    assert out.index(hosted) > 0
    assert hosted["name"] == "Fakehosted"
    assert hosted["kind"] == "hosted"
    assert hosted["limit"] == 60
    assert [s["id"] for s in hosted["styles"]] == [22001]


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

    def fake_timed(text, voice, lang):
        assert voice == "ef_dora"
        assert lang == "es"
        return fake_wav, 1.0, [{"phoneme": "o", "start": 0.0, "end": 1.0}]

    monkeypatch.setattr(tts_registry.kokoro_tts, "synthesize_timed", fake_timed)

    wav, timeline, duration, kana = asyncio.run(voices.speak("Hola", 10011))

    assert timeline == []
    assert kana == ""
    assert duration == 1.0
    with wave.open(io.BytesIO(wav), "rb") as src:
        assert src.getframerate() == 24000
    out = asyncio.run(voices.render("Hola", 10011))
    assert out.phonemes == [{"phoneme": "o", "start": 0.0, "end": 1.0}]
    assert (out.voice, out.fallback) == (10011, "")


def test_speak_routes_a_voicevox_id_to_voicevox(monkeypatch):
    async def fake_speak(text, speaker, speed=1.0):
        assert speaker == 3
        return b"wav-bytes", [{"mora": "こ"}], 0.9, "こんにちは"

    monkeypatch.setattr(tts_registry.voicevox, "speak", fake_speak)

    wav, timeline, duration, kana = asyncio.run(voices.speak("こんにちは", 3))

    assert wav == b"wav-bytes"
    assert timeline == [{"mora": "こ"}]
    assert duration == 0.9
    assert kana == "こんにちは"


def test_speak_at_speed_re_renders_a_voicevox_voice_but_stretches_kokoro(monkeypatch):
    seen = []

    async def fake_speak(text, speaker, speed=1.0):
        seen.append(("voicevox", speed))
        return b"W", [], 1.0, ""

    def fake_timed(text, voice, lang):
        seen.append(("kokoro", 1.0))
        return _wav_bytes(24000, 24000), 1.0, []

    monkeypatch.setattr(tts_registry.voicevox, "speak", fake_speak)
    monkeypatch.setattr(tts_registry.kokoro_tts, "synthesize_timed", fake_timed)
    monkeypatch.setattr(tts_registry.kokoro_tts, "_stretch_wav",
                        lambda wav, speed: seen.append(("stretch", speed)) or _wav_bytes(24000, 30000))
    asyncio.run(voices.speak("やあ", 3, 0.8))
    _, _, duration, _ = asyncio.run(voices.speak("Hola", 10011, 0.8))
    assert seen == [("voicevox", 0.8), ("kokoro", 1.0), ("stretch", 0.8)]
    assert duration == 1.25
