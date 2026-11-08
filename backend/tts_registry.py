"""One voice registry every render goes through. A provider registers its
voices once; the rest of the backend asks `voice(id)`, `provider_for(id)`,
`language_for(id)` and `default_voice(language)` and never names an engine.

Ids stay integers (the client's settings and `islands.speaker` carry an int):
VOICEVOX below 10000, Kokoro 10001-10999, worker engines 11001-11999,
Inworld 20001+, Gemini 21001+, ElevenLabs 22001+.
"""

from __future__ import annotations

import asyncio
from dataclasses import dataclass, field
from typing import Protocol, runtime_checkable

import kokoro_tts
import tts_budget
import voicevox


@dataclass(frozen=True)
class Voice:
    id: int
    provider: str          # the provider's short name: "kokoro", "elevenlabs"
    language: str          # the learning language it speaks: "ja", "fr", ...
    name: str              # display name: "Siwis"
    sub: str = ""          # sublabel: "female", "US, male"
    key: str = ""          # the provider's own voice name or id
    timing: str = "none"   # "mora" | "phoneme" | "pieces" | "none"
    native_speed: bool = False  # True: the provider re-renders at speed (VOICEVOX)
    hosted: bool = False


@dataclass
class Render:
    wav: bytes
    duration: float
    timeline: list = field(default_factory=list)   # mora timeline (VOICEVOX)
    kana: str = ""
    phonemes: list = field(default_factory=list)   # [{"phoneme", "start", "end"}]
    pieces: list = field(default_factory=list)     # [{"text", "start", "end"}]
    voice: int = 0                                 # the voice that really rendered
    fallback: str = ""                             # "" | "budget" | "error" | "disabled"


@runtime_checkable
class Provider(Protocol):
    name: str
    label: str
    hosted: bool

    def enabled(self) -> bool: ...
    def voices(self) -> list[Voice]: ...
    async def render(self, text: str, voice: Voice, speed: float = 1.0) -> Render: ...


DEFAULT_VOICE: dict[str, int] = {
    "ja": voicevox.DEFAULT_SPEAKER,
    "en": 10001,
    "es": 10011,
    "fr": 10021,
    "pt": 10031,
    "zh": 11102,  # Melo: Kokoro's zh (10041) failed the CER gate, see the tts-providers report
    "de": 11001,
    "he": 11002,
    "ko": 11101,
    "ar": 11201,
}

_PROVIDERS: dict[str, Provider] = {}
_VOICES: dict[int, Voice] = {}


def register(provider: Provider) -> None:
    """Add a provider and its voices. Registering the same name twice
    replaces it (a test may register a fake over the real one)."""
    old = _PROVIDERS.get(provider.name)
    if old is not None:
        for v in list(_VOICES.values()):
            if v.provider == old.name:
                del _VOICES[v.id]
    _PROVIDERS[provider.name] = provider
    for v in provider.voices():
        _VOICES[v.id] = v


def providers() -> list[Provider]:
    return list(_PROVIDERS.values())


def provider(name: str) -> Provider | None:
    return _PROVIDERS.get(name)


def enabled(prov: Provider) -> bool:
    """`prov.enabled()` with the dev switch applied: `hosted_off` makes every
    hosted provider report disabled."""
    if prov.hosted and tts_budget.DEV_FORCE == "hosted_off":
        return False
    return prov.enabled()


def voice(voice_id: int) -> Voice | None:
    """The voice behind an id, or None for an id nobody registered (a hosted
    voice whose key is gone). Ids below 10000 are VOICEVOX speakers, listed
    by the VOICEVOX server itself, so they resolve without a table."""
    v = _VOICES.get(voice_id)
    if v is None and voice_id in RETIRED_VOICES:
        v = _VOICES.get(default_voice(RETIRED_VOICES[voice_id]))
    if v is None and 0 <= voice_id < 10000 and "voicevox" in _PROVIDERS:
        v = Voice(voice_id, "voicevox", "ja", "", timing="mora", native_speed=True)
    return v


def provider_for(voice_id: int) -> Provider | None:
    v = voice(voice_id)
    return _PROVIDERS.get(v.provider) if v else None


def language_for(voice_id: int) -> str:
    """The learning language one voice id speaks; "" for an unknown id."""
    if 0 <= voice_id < 10000:
        return "ja"
    v = _VOICES.get(voice_id)
    return v.language if v else RETIRED_VOICES.get(voice_id, "")


def default_voice(language: str) -> int:
    return DEFAULT_VOICE.get(language, voicevox.DEFAULT_SPEAKER)


def voices_for(language: str) -> list[Voice]:
    """Every registered voice for one language from enabled providers: the
    language's default provider first, local ones next, hosted last."""
    default = _VOICES.get(default_voice(language))
    default_provider = default.provider if default else ""
    out = []
    for prov in _PROVIDERS.values():
        if not enabled(prov):
            continue
        out.extend(v for v in prov.voices() if v.language == language)

    def rank(v: Voice) -> tuple:
        return (v.hosted, v.provider != default_provider, v.id)

    return sorted(out, key=rank)


# ---------------------------------------------------------------------------
# Local in-process providers
# ---------------------------------------------------------------------------

class VoicevoxProvider:
    name = "voicevox"
    label = "VOICEVOX"
    hosted = False

    def enabled(self) -> bool:
        return True

    def voices(self) -> list[Voice]:
        # The VOICEVOX server owns its speaker list; `voice()` resolves ids.
        return []

    async def render(self, text: str, voice: Voice, speed: float = 1.0) -> Render:
        wav, timeline, duration, kana = await voicevox.speak(text, voice.id, speed)
        return Render(wav=wav, duration=duration, timeline=timeline, kana=kana, voice=voice.id)


# id: (kokoro voice name, display name, sublabel, kokoro lang code)
KOKORO_VOICES: dict[int, tuple[str, str, str, str]] = {
    10001: ("af_bella", "Bella", "US, female", "en-us"),
    10002: ("am_michael", "Michael", "US, male", "en-us"),
    10003: ("bf_emma", "Emma", "UK, female", "en-gb"),
    10004: ("bm_george", "George", "UK, male", "en-gb"),
    10011: ("ef_dora", "Dora", "female", "es"),
    10012: ("em_alex", "Alex", "male", "es"),
    10021: ("ff_siwis", "Siwis", "female", "fr-fr"),
    10031: ("pf_dora", "Dora", "female", "pt-br"),
    10032: ("pm_alex", "Alex", "male", "pt-br"),
}

# Kokoro's zh voices (10041 Xiaobei, 10042 Yunjian) speak garbage and were
# removed from the list. A saved id still resolves, to the zh default.
RETIRED_VOICES: dict[int, str] = {10041: "zh", 10042: "zh"}

# Kokoro's lang code, keyed down to the learning language the app speaks of.
KOKORO_LANG_TO_LEARNING = {
    "en-us": "en", "en-gb": "en", "es": "es", "fr-fr": "fr", "pt-br": "pt", "cmn": "zh",
}


class KokoroProvider:
    name = "kokoro"
    label = "Kokoro"
    hosted = False

    def enabled(self) -> bool:
        return True

    def voices(self) -> list[Voice]:
        return [
            Voice(vid, self.name, KOKORO_LANG_TO_LEARNING[lang], name, sub, key, timing="phoneme")
            for vid, (key, name, sub, lang) in KOKORO_VOICES.items()
        ]

    async def render(self, text: str, voice: Voice, speed: float = 1.0) -> Render:
        key, _, _, lang = KOKORO_VOICES[voice.id]
        if speed != 1.0:
            wav, duration = await asyncio.to_thread(kokoro_tts.synthesize, text, key, lang, speed)
            return Render(wav=wav, duration=duration, voice=voice.id)
        wav, duration, timings = await asyncio.to_thread(
            kokoro_tts.synthesize_timed, text, key, lang
        )
        return Render(wav=wav, duration=duration, phonemes=timings, voice=voice.id)


register(VoicevoxProvider())
register(KokoroProvider())
# Worker engines register from tts_local; hosted ones from tts_hosted.register_all()
# at main.py's "# tts-providers: hosted providers register here" line.
