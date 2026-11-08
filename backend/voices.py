"""The voice facade the routes and builders call: one integer voice id space
across every provider in `tts_registry`, rendered through `tts_render`
(shared cache, budgets, fallback to the free voice). The signatures here
are the ones every caller has always used."""

import kokoro_tts
import tts_local
import tts_registry
import tts_render
import voicevox
from tts_registry import Render

# Every error a local render can raise; the routes turn these into 502.
VOICE_ERRORS = (voicevox.VoicevoxError, kokoro_tts.KokoroError, tts_local.LocalTtsError)

# The voice a language starts with: the registry's table, kept here under the
# name lang-core's callers use.
DEFAULT_SPEAKER: dict[str, int] = tts_registry.DEFAULT_VOICE


def has_voice(language: str) -> bool:
    """True when the language's default voice can render here: an in-process
    voice (VOICEVOX or Kokoro), or a worker engine whose python and models
    are installed. The first-run starter islands are baked with it, so a
    language whose default is a missing worker or a hosted voice is not
    offered yet."""
    if language == "ja":
        return True
    v = tts_registry.voice(tts_registry.DEFAULT_VOICE.get(language, -1))
    if v is None or v.language != language:
        return False
    if v.provider in ("kokoro", "voicevox"):
        return True
    prov = tts_registry.provider(v.provider)
    return isinstance(prov, tts_local.LocalWorkerProvider) and prov.enabled()


def engine_for(speaker: int) -> str:
    v = tts_registry.voice(speaker)
    return v.provider if v else "voicevox"


def language_for(speaker: int) -> str:
    """The learning language one voice id speaks ('ja' for every VOICEVOX
    id, "" for an id nobody registered)."""
    return tts_registry.language_for(speaker)


def default_speaker(language: str) -> int:
    return tts_registry.default_voice(language)


def _entry(prov, language: str, styles: list[dict]) -> dict:
    out = {
        "uuid": f"{prov.name}-{language}",
        "name": prov.label,
        "policy": "",
        "styles": styles,
        "kind": "hosted" if prov.hosted else "local",
    }
    if prov.hosted:
        import dependencies

        out["limit"] = dependencies.DAILY_CAPS["hosted_tts"]
    return out


async def list_speakers(language: str) -> list[dict]:
    """Every speaker for one learning language, in the shape
    `/shadow/speakers` has always returned: a list of
    {uuid, name, policy, styles: [{id, name, icon}]} plus `kind`
    ("local" | "hosted") and, for hosted, `limit` lines a day. ja is the
    VOICEVOX list as before; every other provider is one entry with a style
    per voice."""
    out: list[dict] = []
    if language == "ja":
        raw = await voicevox.list_speakers()
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
                    "kind": "local",
                }
            )
    by_provider: dict[str, list[dict]] = {}
    for v in tts_registry.voices_for(language):
        if v.provider == "voicevox":
            continue
        by_provider.setdefault(v.provider, []).append(
            {"id": v.id, "name": f"{v.name} ({v.sub})" if v.sub else v.name, "icon": ""}
        )
    for name, styles in by_provider.items():
        out.append(_entry(tts_registry.provider(name), language, styles))
    return out


async def render(text: str, speaker: int, device: str = "", speed: float = 1.0) -> Render:
    """One line in one voice: see tts_render.render. `voice` on the result is
    the voice that really rendered and `fallback` why it differs."""
    return await tts_render.render(text, speaker, device, speed)


async def speak(text: str, speaker: int, speed: float = 1.0) -> tuple[bytes, list[dict], float, str]:
    """Render one line. Returns (wav bytes, mora timeline, duration, kana
    reading), the shape voicevox.speak returns; only a VOICEVOX voice has a
    timeline and kana."""
    out = await render(text, speaker, "", speed)
    return out.wav, out.timeline, out.duration, out.kana
