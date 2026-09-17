"""One integer voice id space across two engines: VOICEVOX for ja (ids below
10000, unchanged) and Kokoro for en and es (ids from 10000 up)."""

import asyncio

import kokoro_tts
import voicevox

# (kokoro voice name, display name, sublabel, kokoro lang code)
KOKORO_VOICES: dict[int, tuple[str, str, str, str]] = {
    10001: ("af_bella", "Bella", "US, female", "en-us"),
    10002: ("am_michael", "Michael", "US, male", "en-us"),
    10003: ("bf_emma", "Emma", "UK, female", "en-gb"),
    10004: ("bm_george", "George", "UK, male", "en-gb"),
    10011: ("ef_dora", "Dora", "female", "es"),
    10012: ("em_alex", "Alex", "male", "es"),
}

# Kokoro's lang code, keyed down to the learning language the app speaks of.
_KOKORO_LANG_TO_LEARNING = {"en-us": "en", "en-gb": "en", "es": "es"}

_LANGUAGE_NAME = {"en": "English", "es": "Spanish"}


def engine_for(speaker: int) -> str:
    return "kokoro" if speaker in KOKORO_VOICES else "voicevox"


def language_for(speaker: int) -> str:
    """The learning language one voice id speaks: 'ja', 'en' or 'es'."""
    if speaker in KOKORO_VOICES:
        return _KOKORO_LANG_TO_LEARNING[KOKORO_VOICES[speaker][3]]
    return "ja"


def default_speaker(language: str) -> int:
    if language == "en":
        return 10001
    if language == "es":
        return 10011
    return voicevox.DEFAULT_SPEAKER


async def list_speakers(language: str) -> list[dict]:
    """Every speaker for one learning language, in the shape
    `/shadow/speakers` has always returned: a list of
    {uuid, name, policy, styles: [{id, name, icon}]}."""
    if language == "ja":
        raw = await voicevox.list_speakers()
        out = []
        for s in raw:
            info = await voicevox.speaker_info(s["speaker_uuid"])
            out.append(
                {
                    "uuid": s["speaker_uuid"],
                    "name": s["name"],
                    "policy": info.get("policy", ""),
                    "styles": [
                        {
                            "id": st["id"],
                            "name": st["name"],
                            "icon": f"/shadow/speakers/{s['speaker_uuid']}/icon/{st['id']}",
                        }
                        for st in s["styles"]
                    ],
                }
            )
        return out

    styles = [
        {"id": sid, "name": f"{name} ({sub})", "icon": ""}
        for sid, (_, name, sub, lang) in KOKORO_VOICES.items()
        if _KOKORO_LANG_TO_LEARNING[lang] == language
    ]
    return [
        {
            "uuid": f"kokoro-{language}",
            "name": _LANGUAGE_NAME.get(language, language),
            "policy": "",
            "styles": styles,
        }
    ]


async def speak(text: str, speaker: int, speed: float = 1.0) -> tuple[bytes, list[dict], float, str]:
    """Render one line through whichever engine `speaker` belongs to. Returns
    (wav bytes, mora timeline, duration, kana reading), the same shape
    voicevox.speak returns; a Kokoro voice has no mora timeline or kana, so
    those come back empty and word timing is found later by whisper
    (see latin.align)."""
    if speaker in KOKORO_VOICES:
        name, _, _, lang = KOKORO_VOICES[speaker]
        wav, duration = await asyncio.to_thread(kokoro_tts.synthesize, text, name, lang, speed)
        return wav, [], duration, ""
    return await voicevox.speak(text, speaker, speed)
