"""VOICEVOX synthesis plus the mora timeline the shadow player highlights with.

The engine is a local HTTP service (default 127.0.0.1:50021). Synthesis is two
calls: /audio_query turns text into an AudioQuery holding the reading, the
accent phrases and a per-mora duration breakdown, then /synthesis renders that
query to a wav.

The useful part for shadowing is that the AudioQuery already carries exact
per-mora durations, so the karaoke timeline comes free. No forced alignment.
Measured against the rendered wav: summing prePhonemeLength + every mora's
consonant_length + vowel_length + postPhonemeLength predicted a 2.720s file to
within 11ms, and speedScale divides the whole timeline linearly. The accent
phrases also carry the pitch accent, kept per mora as `high`.

Audio is always rendered at speedScale 1.0. The client slows playback down with
its own pitch-corrected rate control and divides these timings by that rate,
which avoids a round trip every time the user moves the speed slider.
"""

import array
import io
import logging
import os
import wave

import httpx

log = logging.getLogger(__name__)

VOICEVOX_URL = os.getenv("VOICEVOX_URL", "http://127.0.0.1:50021")
DEFAULT_SPEAKER = int(os.getenv("VOICEVOX_SPEAKER", "3"))
TIMEOUT_S = 60.0
# Backfill queries run inside a read the phone is waiting on, so they give up fast.
BACKFILL_TIMEOUT_S = 2.0


class VoicevoxError(RuntimeError):
    """The engine was unreachable or rejected the request."""


async def list_speakers() -> list[dict]:
    async with httpx.AsyncClient(timeout=TIMEOUT_S) as client:
        r = await client.get(f"{VOICEVOX_URL}/speakers")
        r.raise_for_status()
        return r.json()


_SPEAKER_INFO: dict[str, dict] = {}


async def speaker_info(speaker_uuid: str) -> dict:
    """Portrait, per-style icons and the credit policy for one speaker.

    Fetched in url mode so the payload is small; the resource URLs point at the
    engine itself (127.0.0.1), which only the backend can reach. Cached for the
    life of the process, the engine's catalogue does not change while it runs.
    """
    cached = _SPEAKER_INFO.get(speaker_uuid)
    if cached is not None:
        return cached
    async with httpx.AsyncClient(timeout=TIMEOUT_S) as client:
        r = await client.get(
            f"{VOICEVOX_URL}/speaker_info",
            params={"speaker_uuid": speaker_uuid, "resource_format": "url"},
        )
        r.raise_for_status()
    info = r.json()
    _SPEAKER_INFO[speaker_uuid] = info
    return info


async def fetch_resource(url: str) -> bytes:
    """Stream one engine-hosted resource (an icon) back to the caller."""
    async with httpx.AsyncClient(timeout=TIMEOUT_S) as client:
        r = await client.get(url)
        r.raise_for_status()
        return r.content


async def audio_query(text: str, speaker: int, timeout: float = TIMEOUT_S) -> dict:
    async with httpx.AsyncClient(timeout=timeout) as client:
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


def accent_highs(accent: int, count: int) -> list[bool]:
    """High/low for each mora of one accent phrase, from VOICEVOX's `accent`
    (1-based nucleus; equal to the mora count for a flat phrase). Accent 1:
    first mora high, rest low. Otherwise the first mora is low, moras 2..accent
    high, the rest low. Out-of-range values are clamped so a phrase never
    ends up all high or all low by accident."""
    if count <= 0:
        return []
    accent = accent if 1 <= accent <= count else count
    if accent == 1:
        return [True] + [False] * (count - 1)
    return [False] + [True] * (accent - 1) + [False] * (count - accent)


def build_timeline(query: dict) -> list[dict]:
    """Flatten an AudioQuery into absolute mora timings, in seconds.

    Returns [{"text", "start", "end", "phrase"}, ...] where `phrase` indexes the
    accent phrase the mora belongs to, so the player can break lines at natural
    boundaries. Pauses between phrases advance the clock but emit no entry.
    """
    timeline: list[dict] = []
    t = float(query.get("prePhonemeLength", 0.0))

    for phrase_index, phrase in enumerate(query.get("accent_phrases", [])):
        moras = phrase.get("moras", [])
        highs = accent_highs(int(phrase.get("accent") or 0), len(moras))
        for i, mora in enumerate(moras):
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
                    "high": highs[i],
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


def needs_accent(timeline: list[dict]) -> bool:
    """True for a stored timeline from before pitch marks: moras with no
    `high` key at all. A `high` of None means a backfill already gave up."""
    return bool(timeline) and any("high" not in m for m in timeline)


def backfill_accent(timeline: list[dict], query: dict) -> list[dict] | None:
    """Copy `high` from a fresh AudioQuery of the same text onto a stored
    timeline. Returns None when the fresh moras do not line up one to one
    with the stored ones (nothing safe to copy). Timings are never touched:
    the stored ones are what the wav on disk was rendered from."""
    fresh = build_timeline(query)
    if len(fresh) != len(timeline) or any(f["text"] != m["text"] for m, f in zip(timeline, fresh)):
        return None
    return [{**m, "high": f["high"]} for m, f in zip(timeline, fresh)]


def pad_wav(wav: bytes, pad_ms: int) -> bytes:
    """The same wav with `pad_ms` of silence appended, as PCM in the file's own
    format. Zero or negative padding returns the input unchanged."""
    if pad_ms <= 0:
        return wav
    with wave.open(io.BytesIO(wav)) as src:
        params = src.getparams()
        frames = src.readframes(src.getnframes())

    frames_to_add = round(params.framerate * pad_ms / 1000)
    silence = b"\x00" * (frames_to_add * params.sampwidth * params.nchannels)

    out = io.BytesIO()
    with wave.open(out, "wb") as dst:
        dst.setparams(params)
        dst.writeframes(frames + silence)
    return out.getvalue()


def slice_wav(wav: bytes, start_ms: int, end_ms: int, fade_ms: int = 5) -> bytes:
    """The frames between `start_ms` and `end_ms` of `wav` as a wav in the
    file's own format, with a linear fade of `fade_ms` at both cuts so a
    cut inside a word does not click. `end_ms` past the file is clamped to
    it. Raises ValueError when the span is empty after clamping."""
    with wave.open(io.BytesIO(wav)) as src:
        params = src.getparams()
        frames = src.readframes(src.getnframes())

    start_frame = round(params.framerate * start_ms / 1000)
    end_frame = min(params.nframes, round(params.framerate * end_ms / 1000))
    if start_ms < 0 or start_frame >= end_frame:
        raise ValueError("empty span")

    frame_bytes = params.sampwidth * params.nchannels
    sliced = frames[start_frame * frame_bytes: end_frame * frame_bytes]

    if params.sampwidth == 2:
        n_frames = end_frame - start_frame
        fade = min(round(params.framerate * fade_ms / 1000), n_frames // 2)
        if fade > 0:
            samples = array.array("h")
            samples.frombytes(sliced)
            nchannels = params.nchannels
            for i in range(fade):
                scale = i / fade
                head = i
                tail = n_frames - 1 - i
                for ch in range(nchannels):
                    samples[head * nchannels + ch] = round(samples[head * nchannels + ch] * scale)
                    samples[tail * nchannels + ch] = round(samples[tail * nchannels + ch] * scale)
            sliced = samples.tobytes()

    out = io.BytesIO()
    with wave.open(out, "wb") as dst:
        dst.setparams(params)
        dst.writeframes(sliced)
    return out.getvalue()


async def speak(text: str, speaker: int | None = None,
                speed: float = 1.0) -> tuple[bytes, list[dict], float, str]:
    """Render one line. Returns (wav bytes, mora timeline, duration, kana reading).

    `speed` is VOICEVOX's speedScale: slower speech is synthesized natively,
    which sounds far better than time-stretching the 1.0 render on the phone.
    The timeline returned is always for speed 1.0; callers divide by `speed`.

    Raises VoicevoxError if the engine is down, so the caller can mark the
    island failed rather than storing a silent line.
    """
    sid = DEFAULT_SPEAKER if speaker is None else speaker
    try:
        query = await audio_query(text, sid)
        if speed != 1.0:
            query["speedScale"] = speed
        wav = await synthesis(query, sid)
        if speed != 1.0:
            query["speedScale"] = 1.0
    except httpx.HTTPError as exc:
        raise VoicevoxError(f"VOICEVOX request failed for {text!r}: {exc}") from exc

    timeline = build_timeline(query)
    return wav, timeline, total_duration(query, timeline), query.get("kana", "")
