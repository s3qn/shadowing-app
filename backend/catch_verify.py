"""Catch the word: which target occurrences the audio really carries.

The island's lines can hold words that were never said (creator subtitles
that differ from the speech) or word times squeezed by interpolation inside a
long caption seg. The only audio-derived evidence a YouTube island has is
YouTube's ASR track in audio/<id>/captions.json, with one onset per seg. An
occurrence is verified when its word shows up in that track near its line
time, on an onset we can trust, inside its own line; the target then takes
the ASR time instead of the line's word time. Pure apart from
reference_tokens, which reads the file. No model, no network.
"""

import json
from bisect import bisect_left, bisect_right
from functools import lru_cache
from typing import NamedTuple

import catch
import segment
import store
import youtube

# How far (seconds) an ASR match may sit from the line's word time. Line
# times can be up to 2.3 s off the voice; the nearest match wins.
WINDOW_S = 3.0
# A Japanese word needs this many moras: one mora matches almost anywhere.
MIN_MORAS = 2
# A match is anchored when it starts at mora 0 or 1 of its ASR token...
ANCHOR_MORA = 1
# ...or the token is this short, so interpolation inside it is small...
SHORT_TOKEN_MORAS = 8
# ...and the token spends at most this long per mora (long segs stretched
# over pauses are not trusted).
MAX_S_PER_MORA = 0.4


class Stream(NamedTuple):
    """The reference as parallel lists sorted by time. Japanese: one entry
    per mora (key = the mora, time = its interpolated onset, end = the onset
    of the next mora in the same token or the token's end). Other languages:
    one entry per token (key = catch.word_key). `anchored` says whether a
    match may start at that entry (checks c)."""
    keys: list[str]
    times: list[float]
    ends: list[float]
    anchored: list[bool]


def reference_tokens(island_id: str) -> tuple[list[dict], str]:
    """The ASR tokens of the island's captions.json ({text, start, end} in
    absolute seconds) and where they came from: "asr" for the separate ASR
    track, "auto" when the picked track itself was automatic (its segs carry
    tOffsetMs), "" when there is nothing to check against. Never raises."""
    path = store.AUDIO_DIR / island_id / "captions.json"
    try:
        data = json.loads(path.read_text())
    except (OSError, ValueError):
        return [], ""
    if not isinstance(data, dict):
        return [], ""
    try:
        asr = data.get("asr_events") or []
        if asr:
            tokens = youtube.asr_tokens(asr)
            return (tokens, "asr") if tokens else ([], "")
        events = data.get("events") or []
        if isinstance(events, list) and any(_has_offsets(ev) for ev in events):
            tokens = youtube.asr_tokens(events)
            return (tokens, "auto") if tokens else ([], "")
    except youtube.CaptionsInvalid:
        return [], ""
    return [], ""


def _has_offsets(event) -> bool:
    segs = event.get("segs") if isinstance(event, dict) else None
    return isinstance(segs, list) and any(isinstance(s, dict) and "tOffsetMs" in s for s in segs)


@lru_cache(maxsize=32768)
def _moras(text: str) -> tuple[str, ...]:
    return tuple(segment.moras_of(text))


def anchored_stream(tokens: list[dict], language: str) -> Stream:
    keys: list[str] = []
    times: list[float] = []
    ends: list[float] = []
    anchored: list[bool] = []
    for tok in tokens:
        start, end = float(tok["start"]), float(tok["end"])
        if language != "ja":
            key = catch.word_key(tok["text"], language)
            if key:
                keys.append(key)
                times.append(start)
                ends.append(end)
                anchored.append(True)
            continue
        moras = _moras(tok["text"])
        n = len(moras)
        if not n:
            continue
        step = (end - start) / n
        slow = step > MAX_S_PER_MORA
        for k, mora in enumerate(moras):
            keys.append(mora)
            times.append(start + step * k)
            ends.append(start + step * (k + 1))
            anchored.append(not slow and (k <= ANCHOR_MORA or n <= SHORT_TOKEN_MORAS))
    return Stream(keys, times, ends, anchored)


def _pattern(text: str, language: str) -> list[str]:
    key = catch.word_key(text, language)
    if not key:
        return []
    if language != "ja":
        return [key]
    moras = list(_moras(key))
    return moras if len(moras) >= MIN_MORAS else []


def verify(lines: list[dict], tokens: list[dict], language: str) -> dict[tuple[int, int], tuple[float, float]]:
    """(line_idx, word_index) to the occurrence's (start, end) relative to its
    line's offset, for each candidate word (catch.target_key) that passes:
    (a) its moras (2 or more) appear contiguously in the ASR mora stream, or
    an ASR token has its word_key outside Japanese; (b) the match starts
    within WINDOW_S of the line's word time; (c) the match is anchored (see
    Stream); (d) the ASR time lies inside the word's own line with the late
    tap tolerance. Of the matches passing all four the nearest wins."""
    if not tokens:
        return {}
    stream = anchored_stream(tokens, language)
    keys, times, ends, anchored = stream
    out: dict[tuple[int, int], tuple[float, float]] = {}
    for li, line in enumerate(lines):
        offset = float(line.get("offset") or 0)
        span = catch._span(lines, li)
        for wi, word in enumerate(line.get("words") or []):
            at = word.get("start")
            if isinstance(at, bool) or not isinstance(at, (int, float)):
                continue
            text = word.get("text", "")
            if catch.target_key(text, language) is None:
                continue
            pattern = _pattern(text, language)
            if not pattern:
                continue
            m = len(pattern)
            at = offset + float(at)
            lo = bisect_left(times, at - WINDOW_S)
            hi = bisect_right(times, at + WINDOW_S)
            best: tuple[float, float, float] | None = None
            for p in range(lo, hi):
                if not anchored[p] or keys[p] != pattern[0] or keys[p:p + m] != pattern:
                    continue
                start, end = times[p] - offset, ends[p + m - 1] - offset
                if start < 0 or not catch._fits({"start": start, "end": end}, span):
                    continue
                dist = abs(times[p] - at)
                if best is None or dist < best[0]:
                    best = (dist, start, end)
            if best is not None:
                out[(li, wi)] = (best[1], best[2])
    return out
