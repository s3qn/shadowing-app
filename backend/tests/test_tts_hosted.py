"""tts-providers: the hosted adapters against a monkeypatched
`httpx.AsyncClient.post`. No network, no key file (the module never reads
Sean's file here: `SHADOW_TTS_KEY_FILE` points at nothing before import),
and no real key string anywhere in this file."""

from __future__ import annotations

import asyncio
import base64
import io
import os
import wave

import httpx
import pytest

os.environ["SHADOW_TTS_KEY_FILE"] = "/nonexistent/shadow-tts-env"

import tts_hosted  # noqa: E402
import tts_registry  # noqa: E402

FAKE_KEY = "fake-key-for-tests-only"
PCM_100MS = b"\x01\x00" * (tts_hosted.RATE // 10)


@pytest.fixture
def no_keys(monkeypatch):
    for name in tts_hosted.KEY_NAMES:
        monkeypatch.delenv(name, raising=False)


@pytest.fixture
def fake_post(monkeypatch):
    """Patches `httpx.AsyncClient.post`; `calls` keeps every request and the
    test picks the canned reply through `reply`."""
    calls: list[dict] = []
    state = {"reply": None}

    async def post(self, url, headers=None, json=None, params=None, **_):
        calls.append({"url": url, "headers": headers or {}, "json": json or {}, "params": params or {}})
        reply = state["reply"]
        return reply if reply is not None else httpx.Response(200, json={})

    monkeypatch.setattr(httpx.AsyncClient, "post", post)

    class Fake:
        def __init__(self):
            self.calls = calls

        def reply(self, status: int, body: dict | None = None):
            state["reply"] = httpx.Response(status, json=body or {})

    return Fake()


def _provider(name: str):
    return next(p for p in tts_hosted.PROVIDERS if p.name == name)


def _voice(provider_name: str, language: str, k: int = 0) -> tts_registry.Voice:
    return [v for v in _provider(provider_name).voices() if v.language == language][k]


def _render(provider_name: str, text: str, voice: tts_registry.Voice) -> tts_registry.Render:
    return asyncio.run(_provider(provider_name).render(text, voice))


def _wav_facts(wav: bytes) -> tuple[int, int, int, int]:
    with wave.open(io.BytesIO(wav)) as w:
        return w.getframerate(), w.getnchannels(), w.getsampwidth(), w.getnframes()


# --- keys ------------------------------------------------------------------


def test_disabled_without_key_and_without_file(no_keys):
    tts_hosted._load_keys()  # the file does not exist: nothing is set
    for prov in tts_hosted.PROVIDERS:
        assert prov.enabled() is False
        assert os.environ.get(prov.env) is None


def test_load_keys_reads_file_and_keeps_env(no_keys, monkeypatch, tmp_path):
    env_file = tmp_path / "env"
    env_file.write_text("GEMINI_API_KEY=from-file\nINWORLD_API_KEY='from-file'\n# ELEVENLABS_API_KEY=commented\n")
    monkeypatch.setenv("GEMINI_API_KEY", "from-env")
    try:
        tts_hosted._load_keys(env_file)
        assert os.environ["GEMINI_API_KEY"] == "from-env"
        assert os.environ["INWORLD_API_KEY"] == "from-file"
        assert os.environ.get("ELEVENLABS_API_KEY") is None
    finally:
        os.environ.pop("INWORLD_API_KEY", None)


def test_enabled_with_key(no_keys, monkeypatch):
    monkeypatch.setenv("ELEVENLABS_API_KEY", FAKE_KEY)
    enabled = {p.name: p.enabled() for p in tts_hosted.PROVIDERS}
    assert enabled == {"inworld": False, "gemini": False, "elevenlabs": True}


# --- voices and ids ----------------------------------------------------------


def test_two_voices_per_language_in_each_range():
    for prov in tts_hosted.PROVIDERS:
        voices = prov.voices()
        assert len(voices) == 2 * len(tts_hosted.LANGUAGES)
        assert all(v.hosted and not v.native_speed and v.provider == prov.name for v in voices)
        assert all(prov.base_id < v.id < prov.base_id + 1000 for v in voices)
        assert all(v.timing == "none" for v in voices if v.language in tts_hosted.UNSPACED)
    assert _voice("elevenlabs", "ja").id == 22001
    assert _voice("elevenlabs", "ja").name == "Sarah"
    assert _voice("inworld", "ja").id == 20001
    assert _voice("gemini", "ja").id == 21001
    assert _voice("inworld", "he").key == "Yael"
    assert _voice("inworld", "fr").timing == "pieces" and _voice("gemini", "fr").timing == "none"


def test_register_all_keeps_ids_resolvable_without_keys(no_keys):
    tts_hosted.register_all()
    v = tts_registry.voice(22001)
    assert v is not None and v.provider == "elevenlabs" and v.language == "ja"
    assert tts_registry.language_for(20091) == "ar"
    assert not any(v.hosted for v in tts_registry.voices_for("fr"))


def test_register_all_lists_keyed_provider_last(no_keys, monkeypatch):
    monkeypatch.setenv("INWORLD_API_KEY", FAKE_KEY)
    tts_hosted.register_all()
    listed = tts_registry.voices_for("fr")
    hosted = [v for v in listed if v.hosted]
    assert [v.provider for v in hosted] == ["inworld", "inworld"]
    assert hosted == listed[-2:]


# --- Inworld -----------------------------------------------------------------


def test_inworld_render(no_keys, monkeypatch, fake_post):
    monkeypatch.setenv("INWORLD_API_KEY", FAKE_KEY)
    wav = tts_hosted._wav_from_pcm(PCM_100MS)
    fake_post.reply(
        200,
        {
            "audioContent": base64.b64encode(wav).decode(),
            "timestampInfo": {
                "wordAlignment": {
                    "words": ["", "Bonjour", " ", "tout", " ", "le", " ", "monde", "."],
                    "wordStartTimeSeconds": [0, 0.01, 0.03, 0.03, 0.05, 0.05, 0.06, 0.06, 0.09],
                    "wordEndTimeSeconds": [0.01, 0.03, 0.03, 0.05, 0.05, 0.06, 0.06, 0.09, 0.1],
                }
            },
            "usage": {"processedCharactersCount": 21},
        },
    )
    voice = _voice("inworld", "fr")
    render = _render("inworld", "Bonjour tout le monde.", voice)
    assert render.voice == voice.id and render.fallback == ""
    assert render.wav == wav and render.duration == pytest.approx(0.1)
    assert [p["text"] for p in render.pieces] == ["Bonjour", "tout", "le", "monde."]
    assert render.pieces[0] == {"text": "Bonjour", "start": 0.01, "end": 0.03}
    call = fake_post.calls[-1]
    assert call["url"] == tts_hosted.InworldProvider.url
    assert call["headers"]["Authorization"] == f"Basic {FAKE_KEY}"
    assert call["json"]["voiceId"] == "Hélène" and call["json"]["language"] == "fr-FR"
    assert call["json"]["audioConfig"] == {"audioEncoding": "LINEAR16", "sampleRateHertz": 24000}
    assert call["json"]["timestampType"] == "WORD" and call["json"]["modelId"] == "inworld-tts-2"


def test_inworld_japanese_has_no_pieces(no_keys, monkeypatch, fake_post):
    monkeypatch.setenv("INWORLD_API_KEY", FAKE_KEY)
    fake_post.reply(
        200,
        {
            "audioContent": base64.b64encode(tts_hosted._wav_from_pcm(PCM_100MS)).decode(),
            "timestampInfo": {
                "wordAlignment": {"words": ["今日は", "いい"], "wordStartTimeSeconds": [0, 0.05], "wordEndTimeSeconds": [0.05, 0.1]}
            },
        },
    )
    render = _render("inworld", "今日はいい", _voice("inworld", "ja"))
    assert render.pieces == [] and render.duration == pytest.approx(0.1)


# --- ElevenLabs --------------------------------------------------------------


def test_elevenlabs_characters_become_pieces(no_keys, monkeypatch, fake_post):
    monkeypatch.setenv("ELEVENLABS_API_KEY", FAKE_KEY)
    chars = list("Hi there")
    n = len(chars)
    fake_post.reply(
        200,
        {
            "audio_base64": base64.b64encode(PCM_100MS).decode(),
            "alignment": {
                "characters": chars,
                "character_start_times_seconds": [i * 0.01 for i in range(n)],
                "character_end_times_seconds": [(i + 1) * 0.01 for i in range(n)],
            },
        },
    )
    voice = _voice("elevenlabs", "en")
    render = _render("elevenlabs", "Hi there", voice)
    assert render.wav[:4] == b"RIFF" and _wav_facts(render.wav) == (24000, 1, 2, 2400)
    assert render.duration == pytest.approx(0.1)
    assert render.pieces == [
        {"text": "Hi", "start": 0.0, "end": pytest.approx(0.02)},
        {"text": "there", "start": pytest.approx(0.03), "end": pytest.approx(0.08)},
    ]
    call = fake_post.calls[-1]
    assert call["url"].endswith("/v1/text-to-speech/EXAVITQu4vr4xnSDxMaL/with-timestamps")
    assert call["params"] == {"output_format": "pcm_24000"}
    assert call["headers"]["xi-api-key"] == FAKE_KEY
    assert call["json"]["model_id"] == "eleven_v3" and call["json"]["language_code"] == "en"


# --- Gemini ------------------------------------------------------------------


def test_gemini_pcm_becomes_wav(no_keys, monkeypatch, fake_post):
    monkeypatch.setenv("GEMINI_API_KEY", FAKE_KEY)
    fake_post.reply(
        200,
        {
            "steps": [
                {"type": "model_output", "content": [{"type": "audio", "data": base64.b64encode(PCM_100MS).decode()}]}
            ]
        },
    )
    voice = _voice("gemini", "de", 1)
    render = _render("gemini", "Guten Tag.", voice)
    assert render.wav[:4] == b"RIFF" and len(render.wav) == 44 + len(PCM_100MS)
    assert _wav_facts(render.wav) == (24000, 1, 2, 2400)
    assert render.duration == pytest.approx(0.1) and render.pieces == [] and render.voice == voice.id
    call = fake_post.calls[-1]
    assert call["headers"] == {"x-goog-api-key": FAKE_KEY}
    assert call["json"]["model"] == "gemini-3.8-flash-tts"
    assert call["json"]["generation_config"] == {"speech_config": [{"voice": "Puck"}]}
    assert call["json"]["response_format"] == {"type": "audio", "mime_type": "audio/l16", "sample_rate": 24000}


def test_gemini_without_audio_raises(no_keys, monkeypatch, fake_post):
    monkeypatch.setenv("GEMINI_API_KEY", FAKE_KEY)
    fake_post.reply(200, {"steps": [{"type": "model_output", "content": [{"type": "text", "text": "no"}]}]})
    with pytest.raises(tts_hosted.HostedTtsError):
        _render("gemini", "x", _voice("gemini", "en"))


# --- errors ------------------------------------------------------------------


@pytest.mark.parametrize("prov_name", ["inworld", "gemini", "elevenlabs"])
def test_http_error_never_carries_the_key(no_keys, monkeypatch, fake_post, prov_name):
    monkeypatch.setenv(_provider(prov_name).env, FAKE_KEY)
    fake_post.reply(429, {"detail": f"quota exceeded for {FAKE_KEY}"})
    with pytest.raises(tts_hosted.HostedTtsError) as info:
        _render(prov_name, "hello", _voice(prov_name, "en"))
    assert str(info.value) == f"{prov_name}: HTTP 429"
    assert FAKE_KEY not in str(info.value) and "quota" not in str(info.value)


def test_transport_error_becomes_hosted_error(no_keys, monkeypatch):
    monkeypatch.setenv("INWORLD_API_KEY", FAKE_KEY)

    async def post(self, url, **_):
        raise httpx.ConnectTimeout(f"timed out talking to {url} with {FAKE_KEY}")

    monkeypatch.setattr(httpx.AsyncClient, "post", post)
    with pytest.raises(tts_hosted.HostedTtsError) as info:
        _render("inworld", "hello", _voice("inworld", "en"))
    assert str(info.value) == "inworld: ConnectTimeout"


# --- helpers -----------------------------------------------------------------


def test_group_on_whitespace_handles_trailing_space_tokens():
    pieces = tts_hosted._group_on_whitespace(
        ["Hello", ", ", "world", "!", " ", "", "ok"], [0, 1, 2, 3, 4, 5, 6], [1, 2, 3, 4, 5, 6, 7]
    )
    assert pieces == [
        {"text": "Hello,", "start": 0.0, "end": 2.0},
        {"text": "world!", "start": 2.0, "end": 4.0},
        {"text": "ok", "start": 6.0, "end": 7.0},
    ]


def test_ensure_wav_passes_riff_through():
    wav = tts_hosted._wav_from_pcm(PCM_100MS)
    assert tts_hosted._ensure_wav(wav) is wav
    assert tts_hosted._wav_duration(b"RIFF") == 0.0


def test_no_hosted_provider_is_enabled_in_the_suite():
    assert [p.name for p in tts_hosted.PROVIDERS if p.enabled()] == []


def test_empty_audio_raises_for_inworld_and_elevenlabs(no_keys, monkeypatch, fake_post):
    monkeypatch.setenv("INWORLD_API_KEY", FAKE_KEY)
    monkeypatch.setenv("ELEVENLABS_API_KEY", FAKE_KEY)
    fake_post.reply(200, {"audioContent": "", "audio_base64": ""})
    with pytest.raises(tts_hosted.HostedTtsError):
        _render("inworld", "x", _voice("inworld", "en"))
    with pytest.raises(tts_hosted.HostedTtsError):
        _render("elevenlabs", "x", _voice("elevenlabs", "en"))


def test_empty_key_file_var_does_not_fall_through_to_the_real_file(monkeypatch):
    monkeypatch.setenv("SHADOW_TTS_KEY_FILE", "")
    seen = []
    monkeypatch.setattr(tts_hosted.Path, "is_file", lambda self: seen.append(str(self)) or False)
    tts_hosted._load_keys()
    assert not any("shadow-tts" in p for p in seen)
