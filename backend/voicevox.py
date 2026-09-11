"""VOICEVOX synthesis plus the mora timeline the shadow player highlights with.

The engine is a local HTTP service (default 127.0.0.1:50021). Synthesis is two
calls: /audio_query turns text into an AudioQuery holding the reading, the
accent phrases and a per-mora duration breakdown, then /synthesis renders that
query to a wav.

The useful part for shadowing is that the AudioQuery already carries exact
per-mora durations, so the karaoke timeline comes free. No forced alignment.
Measured against the rendered wav: summing prePhonemeLength + every mora's
consonant_length + vowel_length + postPhonemeLength predicted a 2.720s file to
within 11ms, and speedScale divides the whole timeline linearly.

Audio is always rendered at speedScale 1.0. The client slows playback down with
its own pitch-corrected rate control and divides these timings by that rate,
which avoids a round trip every time the user moves the speed slider.
"""

import logging
import os

import httpx

log = logging.getLogger(__name__)

VOICEVOX_URL = os.getenv("VOICEVOX_URL", "http://127.0.0.1:50021")
DEFAULT_SPEAKER = int(os.getenv("VOICEVOX_SPEAKER", "3"))
TIMEOUT_S = 60.0


class VoicevoxError(RuntimeError):
    """The engine was unreachable or rejected the request."""


async def list_speakers() -> list[dict]:
    async with httpx.AsyncClient(timeout=TIMEOUT_S) as client:
        r = await client.get(f"{VOICEVOX_URL}/speakers")
        r.raise_for_status()
        return r.json()


async def audio_query(text: str, speaker: int) -> dict:
    async with httpx.AsyncClient(timeout=TIMEOUT_S) as client:
        r = await client.post(
            f"{VOICEVOX_URL}/audio_query",
            params={"text": text, "speaker": speaker},
        )
        r.raise_for_status()
        return r.json()


async def synthesis(query: dict, speaker: int) -> bytes:
    async with httpx.AsyncClient(timeout=TIMEOUT_S) as client:
        r = await client.post(
            f"{VOICEVOX_URL}/synthesis",
            params={"speaker": speaker},
            json=query,
            headers={"Content-Type": "application/json"},
        )
        r.raise_for_status()
        return r.content


def to_hiragana(katakana: str) -> str:
    """VOICEVOX returns readings in katakana. Learners expect hiragana, and the
    two scripts map one to one over the syllabary, so a codepoint shift is a
    faithful conversion. Long-vowel marks and anything outside the range pass
    through untouched."""
    return "".join(
        chr(ord(ch) - 0x60) if "\u30a1" <= ch <= "\u30f6" else ch for ch in katakana
    )


def build_timeline(query: dict) -> list[dict]:
    """Flatten an AudioQuery into absolute mora timings, in seconds.

    Returns [{"text", "start", "end", "phrase"}, ...] where `phrase` indexes the
    accent phrase the mora belongs to, so the player can break lines at natural
    boundaries. Pauses between phrases advance the clock but emit no entry.
    """
    timeline: list[dict] = []
    t = float(query.get("prePhonemeLength", 0.0))

    for phrase_index, phrase in enumerate(query.get("accent_phrases", [])):
        for mora in phrase.get("moras", []):
            dur = float(mora.get("consonant_length") or 0.0) + float(
                mora.get("vowel_length") or 0.0
            )
            mora_text = mora.get("text", "")
            timeline.append(
                {
                    "text": mora_text,
                    "kana": to_hiragana(mora_text),
                    "start": round(t, 4),
                    "end": round(t + dur, 4),
                    "phrase": phrase_index,
                }
            )
            t += dur

        pause = phrase.get("pause_mora")
        if pause:
            t += float(pause.get("consonant_length") or 0.0) + float(
                pause.get("vowel_length") or 0.0
            )

    return timeline


def total_duration(query: dict, timeline: list[dict]) -> float:
    end = timeline[-1]["end"] if timeline else 0.0
    return round(end + float(query.get("postPhonemeLength", 0.0)), 4)


async def speak(text: str, speaker: int | None = None) -> tuple[bytes, list[dict], float, str]:
    """Render one line. Returns (wav bytes, mora timeline, duration, kana reading).

    Raises VoicevoxError if the engine is down, so the caller can mark the
    island failed rather than storing a silent line.
    """
    sid = DEFAULT_SPEAKER if speaker is None else speaker
    try:
        query = await audio_query(text, sid)
        wav = await synthesis(query, sid)
    except httpx.HTTPError as exc:
        raise VoicevoxError(f"VOICEVOX request failed for {text!r}: {exc}") from exc

    timeline = build_timeline(query)
    return wav, timeline, total_duration(query, timeline), query.get("kana", "")
