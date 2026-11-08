"""Hosted AI voices behind the registry's Provider protocol: Inworld, Gemini
TTS and ElevenLabs (tts-providers, Task B).

Keys come from the process environment or `SHADOW_TTS_KEY_FILE` (default
`~/.config/shadow-tts/env`, mode 600), loaded once at import without
overriding what the environment already holds. A provider without its key
reports `enabled() == False`: the registry then leaves it out of the picker
and `tts_render` falls back to the language's local voice, so a saved hosted
id keeps resolving to a language after the key is gone. Key values never go
into a log line, an exception message or a route body.

Every adapter renders at 1.0 only (`native_speed=False`): `tts_render`
stretches the cached wav for other speeds, so a provider is paid once per
(voice, text). Timings: Inworld word tokens and ElevenLabs characters are
grouped on whitespace into `pieces` for `latin.align`; Gemini has none, so
whisper times it as it does any imported line.
"""

from __future__ import annotations

import base64
import io
import logging
import os
import struct
import wave
from pathlib import Path

import httpx
from dotenv import dotenv_values

import config
from tts_registry import Render, Voice, register

log = logging.getLogger("shadow.tts_hosted")

KEY_NAMES = ("GEMINI_API_KEY", "INWORLD_API_KEY", "ELEVENLABS_API_KEY")
TIMEOUT_S = 30.0
RATE = config.SLICE_RATE

# Id layout per provider: base + 10 * language index + 1 or 2, so every
# hosted provider carries two voices per language (inworld 20001+, gemini
# 21001+, elevenlabs 22001+; 22001 is ElevenLabs Sarah for Japanese).
LANGUAGES = ["ja", "en", "es", "fr", "pt", "zh", "de", "he", "ko", "ar"]
# No spaces between words: a provider's token timing cannot be grouped into
# word pieces for `latin.align`, so these lines go to whisper and the ja/zh
# segmenters like imported audio does (timing "none", no pieces).
UNSPACED = {"ja", "zh"}
LOCALE = {
    "ja": "ja-JP",
    "en": "en-US",
    "es": "es-ES",
    "fr": "fr-FR",
    "pt": "pt-BR",
    "zh": "zh-CN",
    "de": "de-DE",
    "he": "he-IL",
    "ko": "ko-KR",
    "ar": "ar-SA",
}


class HostedTtsError(Exception):
    """A provider answered with an error status or did not answer. The message
    carries the provider name and the HTTP status only, never a body or a key."""


# ---------------------------------------------------------------------------
# Keys
# ---------------------------------------------------------------------------


def _load_keys(path: str | Path | None = None) -> None:
    """Copies the three key names from the key file into the environment,
    without overriding a value the environment already has. A missing or
    unreadable file is the same as an empty one."""
    file = Path(path or os.environ.get("SHADOW_TTS_KEY_FILE", "~/.config/shadow-tts/env")).expanduser()
    if not file.is_file():
        return
    try:
        values = dotenv_values(file)
    except OSError:
        return
    for name in KEY_NAMES:
        value = (values.get(name) or "").strip()
        if value and not (os.environ.get(name) or "").strip():
            os.environ[name] = value


def _key(name: str) -> str:
    return (os.environ.get(name) or "").strip()


# ---------------------------------------------------------------------------
# Audio and timing helpers
# ---------------------------------------------------------------------------


def _wav_from_pcm(pcm: bytes, rate: int = RATE) -> bytes:
    """A 44-byte RIFF header in front of 16-bit mono little-endian PCM."""
    header = struct.pack(
        "<4sI4s4sIHHIIHH4sI",
        b"RIFF",
        36 + len(pcm),
        b"WAVE",
        b"fmt ",
        16,
        1,
        1,
        rate,
        rate * 2,
        2,
        16,
        b"data",
        len(pcm),
    )
    return header + pcm


def _ensure_wav(audio: bytes) -> bytes:
    """Audio as a WAV file: a RIFF payload passes through, headerless PCM
    gets the 24 kHz header."""
    return audio if audio[:4] == b"RIFF" else _wav_from_pcm(audio)


def _wav_duration(wav: bytes) -> float:
    try:
        with wave.open(io.BytesIO(wav)) as w:
            rate = w.getframerate() or RATE
            return w.getnframes() / rate
    except (wave.Error, EOFError):
        return max(0, len(wav) - 44) / (RATE * 2)


def _group_on_whitespace(tokens: list, starts: list, ends: list) -> list[dict]:
    """Word pieces for `latin.align` from a provider's token timing (Inworld
    word tokens, which include punctuation and whitespace entries, or
    ElevenLabs characters). Tokens run together until whitespace; a token
    that ends in whitespace (", ") closes the piece it joined."""
    pieces: list[dict] = []
    text = ""
    start = 0.0
    end = 0.0
    for tok, s, e in zip(tokens, starts, ends):
        tok = str(tok)
        if not tok.strip():
            if text:
                pieces.append({"text": text, "start": start, "end": end})
            text = ""
            continue
        if not text:
            start = float(s)
        text += tok.strip()
        end = float(e)
        if tok[-1].isspace():
            pieces.append({"text": text, "start": start, "end": end})
            text = ""
    if text:
        pieces.append({"text": text, "start": start, "end": end})
    return pieces


def _pieces_for(voice: Voice, tokens: list, starts: list, ends: list) -> list[dict]:
    """Word pieces for a spaced language; none for ja and zh (see UNSPACED)."""
    if voice.language in UNSPACED:
        return []
    return _group_on_whitespace(tokens, starts, ends)


async def _post(name: str, url: str, *, headers: dict, body: dict, params: dict | None = None) -> httpx.Response:
    """One POST with the shared timeout. Transport errors and 4xx/5xx become
    `HostedTtsError` with the provider name and the status or error class."""
    async with httpx.AsyncClient(timeout=TIMEOUT_S) as client:
        try:
            resp = await client.post(url, headers=headers, json=body, params=params)
        except httpx.HTTPError as exc:
            raise HostedTtsError(f"{name}: {type(exc).__name__}") from None
    if resp.status_code >= 400:
        raise HostedTtsError(f"{name}: HTTP {resp.status_code}")
    return resp


# ---------------------------------------------------------------------------
# Providers
# ---------------------------------------------------------------------------


class _HostedProvider:
    name = ""
    label = ""
    hosted = True
    env = ""
    base_id = 0
    timing = "none"
    # language -> [(provider voice key, display name, sublabel), ...]; "*" is
    # a table shared by every language (Gemini and ElevenLabs voices are
    # multilingual).
    table: dict[str, list[tuple[str, str, str]]] = {}

    def enabled(self) -> bool:
        return bool(_key(self.env))

    def voices(self) -> list[Voice]:
        out = []
        for index, language in enumerate(LANGUAGES):
            rows = self.table.get(language) or self.table.get("*") or []
            for k, (key, name, sub) in enumerate(rows[:2], start=1):
                out.append(
                    Voice(
                        id=self.base_id + 10 * index + k,
                        provider=self.name,
                        language=language,
                        name=name,
                        sub=sub,
                        key=key,
                        timing="none" if language in UNSPACED else self.timing,
                        native_speed=False,
                        hosted=True,
                    )
                )
        return out

    async def render(self, text: str, voice: Voice, speed: float = 1.0) -> Render:
        raise NotImplementedError


class InworldProvider(_HostedProvider):
    """Inworld TTS, https://docs.inworld.ai/api-reference/ttsAPI/texttospeech/synthesize-speech.
    LINEAR16 comes back with a WAV header; WORD timestamps give every token
    of the input in order."""

    name = "inworld"
    label = "Inworld"
    env = "INWORLD_API_KEY"
    base_id = 20000
    timing = "pieces"
    url = "https://api.inworld.ai/tts/v1/voice"
    table = {
        "ja": [("Asuka", "Asuka", "female"), ("Haruto", "Haruto", "male")],
        "en": [("Ashley", "Ashley", "female"), ("Dennis", "Dennis", "male")],
        "es": [("Gabriela", "Gabriela", "female"), ("Nacho", "Nacho", "male")],
        "fr": [("Hélène", "Hélène", "female"), ("Alain", "Alain", "male")],
        "pt": [("Beatriz", "Beatriz", "female"), ("Davi", "Davi", "male")],
        "zh": [("Mei", "Mei", "female"), ("Ming", "Ming", "male")],
        "de": [("Carina", "Carina", "female"), ("Tobias", "Tobias", "male")],
        "he": [("Yael", "Yael", "female"), ("Oren", "Oren", "male")],
        "ko": [("Minji", "Minji", "female"), ("Seojun", "Seojun", "male")],
        "ar": [("Nour", "Nour", "female"), ("Omar", "Omar", "male")],
    }

    async def render(self, text: str, voice: Voice, speed: float = 1.0) -> Render:
        body = {
            "text": text,
            "voiceId": voice.key,
            "modelId": os.getenv("SHADOW_TTS_INWORLD_MODEL") or "inworld-tts-2",
            "language": LOCALE.get(voice.language, voice.language),
            "audioConfig": {"audioEncoding": "LINEAR16", "sampleRateHertz": RATE},
            "timestampType": "WORD",
        }
        resp = await _post(self.name, self.url, headers={"Authorization": f"Basic {_key(self.env)}"}, body=body)
        data = resp.json()
        raw = base64.b64decode(data.get("audioContent") or "")
        if not raw:
            raise HostedTtsError(f"{self.name}: no audio in the response")
        wav = _ensure_wav(raw)
        words = (data.get("timestampInfo") or {}).get("wordAlignment") or {}
        pieces = _pieces_for(
            voice,
            words.get("words") or [],
            words.get("wordStartTimeSeconds") or [],
            words.get("wordEndTimeSeconds") or [],
        )
        return Render(wav=wav, duration=_wav_duration(wav), pieces=pieces, voice=voice.id)


class GeminiProvider(_HostedProvider):
    """Gemini TTS through the Interactions endpoint the speech-generation docs
    document for the 3.8 TTS models (https://ai.google.dev/gemini-api/docs/speech-generation).
    Headerless 16-bit 24 kHz PCM is asked for and wrapped here; the model
    detects the language from the text."""

    name = "gemini"
    label = "Gemini"
    env = "GEMINI_API_KEY"
    base_id = 21000
    url = "https://generativelanguage.googleapis.com/v1beta/interactions"
    table = {"*": [("Kore", "Kore", "female"), ("Puck", "Puck", "male")]}

    async def render(self, text: str, voice: Voice, speed: float = 1.0) -> Render:
        body = {
            "model": os.getenv("SHADOW_TTS_GEMINI_MODEL") or "gemini-3.8-flash-tts",
            "input": [{"type": "user_input", "content": [{"type": "text", "text": text}]}],
            "response_format": {"type": "audio", "mime_type": "audio/l16", "sample_rate": RATE},
            "generation_config": {"speech_config": [{"voice": voice.key}]},
        }
        resp = await _post(self.name, self.url, headers={"x-goog-api-key": _key(self.env)}, body=body)
        data = resp.json()
        encoded = ""
        for step in data.get("steps") or []:
            if step.get("type") != "model_output":
                continue
            for part in step.get("content") or []:
                if part.get("type") == "audio" and part.get("data"):
                    encoded = part["data"]
        if not encoded:
            raise HostedTtsError(f"{self.name}: no audio in the response")
        wav = _ensure_wav(base64.b64decode(encoded))
        return Render(wav=wav, duration=_wav_duration(wav), voice=voice.id)


class ElevenLabsProvider(_HostedProvider):
    """ElevenLabs eleven_v3 with character timestamps
    (https://elevenlabs.io/docs/api-reference/text-to-speech/convert-with-timestamps),
    headerless pcm_24000 wrapped here. `language_code` pins the language for
    the models that honour it (Hebrew needs it); the others ignore it."""

    name = "elevenlabs"
    label = "ElevenLabs"
    env = "ELEVENLABS_API_KEY"
    base_id = 22000
    timing = "pieces"
    url = "https://api.elevenlabs.io/v1/text-to-speech/{voice}/with-timestamps"
    table = {
        "*": [
            ("EXAVITQu4vr4xnSDxMaL", "Sarah", "female"),
            ("JBFqnCBsd6RMkjVDRZzb", "George", "male"),
        ]
    }

    async def render(self, text: str, voice: Voice, speed: float = 1.0) -> Render:
        body = {
            "text": text,
            "model_id": os.getenv("SHADOW_TTS_ELEVENLABS_MODEL") or "eleven_v3",
            "language_code": voice.language,
        }
        resp = await _post(
            self.name,
            self.url.format(voice=voice.key),
            headers={"xi-api-key": _key(self.env)},
            body=body,
            params={"output_format": f"pcm_{RATE}"},
        )
        data = resp.json()
        raw = base64.b64decode(data.get("audio_base64") or "")
        if not raw:
            raise HostedTtsError(f"{self.name}: no audio in the response")
        wav = _ensure_wav(raw)
        alignment = data.get("alignment") or {}
        pieces = _pieces_for(
            voice,
            alignment.get("characters") or [],
            alignment.get("character_start_times_seconds") or [],
            alignment.get("character_end_times_seconds") or [],
        )
        return Render(wav=wav, duration=_wav_duration(wav), pieces=pieces, voice=voice.id)


PROVIDERS = (InworldProvider(), GeminiProvider(), ElevenLabsProvider())


def register_all() -> None:
    """Registers the three hosted providers, keyed or not: the registry hides
    a disabled provider from the picker and `tts_render` falls back for it,
    while a saved hosted id still resolves to its language."""
    for prov in PROVIDERS:
        register(prov)
    log.info("hosted voices: %s", ", ".join(f"{p.name} {'on' if p.enabled() else 'off'}" for p in PROVIDERS))


_load_keys()
