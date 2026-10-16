"""YouTube links and captions: parsing a video id, reading its title, and
turning the raw json3 caption events the phone fetched into lines.

The server IP is blocked by YouTube, so the phone downloads the caption track
and posts the raw events. Everything here is pure and offline.
"""

from __future__ import annotations

import logging
import math
import re
from urllib.parse import parse_qs, quote, urlsplit

import httpx

import cues as cues_mod

log = logging.getLogger("shadow")

VIDEO_ID_RE = re.compile(r"[A-Za-z0-9_-]{11}")
HOSTS = {"youtube.com", "www.youtube.com", "m.youtube.com", "music.youtube.com"}
PATH_PREFIXES = ("shorts", "live", "embed", "v")

CAPTIONS_MAX_BODY = 3 * 1024 * 1024
CAPTIONS_MAX_EVENTS = 6000
CAPTIONS_MAX_LINES = 1000
CAPTION_MAX_CHARS = 300
CAPTIONS_MAX_SECONDS = 4 * 3600
MIN_LINE_S = 0.2
MIN_KEPT_S = 0.6
MERGE_PREV_MAX_S = 3.0
_MARKER_RE = re.compile(r"^\[.*\]$")
_WS_RE = re.compile(r"\s+")


def parse_video_id(text: str) -> str | None:
    """The 11 character id from a YouTube link, or None for anything else."""
    text = (text or "").strip()
    if not text:
        return None
    if "://" not in text:
        text = "https://" + text
    try:
        parts = urlsplit(text)
    except ValueError:
        return None
    if parts.scheme not in ("http", "https"):
        return None
    host = (parts.hostname or "").lower()
    segments = [s for s in parts.path.split("/") if s]
    candidate = None
    if host == "youtu.be":
        if len(segments) == 1:
            candidate = segments[0]
    elif host in HOSTS:
        if segments == ["watch"]:
            candidate = (parse_qs(parts.query).get("v") or [None])[0]
        elif len(segments) == 2 and segments[0] in PATH_PREFIXES:
            candidate = segments[1]
    if candidate and VIDEO_ID_RE.fullmatch(candidate):
        return candidate
    return None


def watch_url(video_id: str) -> str:
    return f"https://www.youtube.com/watch?v={video_id}"


def oembed_info(video_id: str) -> dict:
    """Title, author and thumbnail from YouTube's public oEmbed endpoint.
    Empty strings when it cannot be reached."""
    out = {"title": "", "author": "", "thumbnail": ""}
    try:
        r = httpx.get(
            "https://www.youtube.com/oembed?url=" + quote(watch_url(video_id), safe="") + "&format=json",
            timeout=5.0,
        )
        r.raise_for_status()
        data = r.json()
        out["title"] = str(data.get("title") or "")
        out["author"] = str(data.get("author_name") or "")
        out["thumbnail"] = str(data.get("thumbnail_url") or "")
    except Exception:
        pass
    return out


class CaptionsInvalid(ValueError):
    """The posted events are malformed or out of bounds."""


def _num(value) -> float:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise CaptionsInvalid("timestamp is not a number")
    f = float(value)
    if not math.isfinite(f) or f < 0 or f / 1000.0 > CAPTIONS_MAX_SECONDS:
        raise CaptionsInvalid("timestamp out of range")
    return f


def _pieces(timed: list[tuple[float, str]], event_end: float) -> list[dict]:
    """Seg onsets to `[{text, start, end}]` in absolute seconds. Piece end is
    the next onset, the last piece ends with the event. Non-monotonic onsets
    are dropped."""
    kept: list[tuple[float, str]] = []
    for onset, u in timed:
        if kept and onset < kept[-1][0]:
            continue
        kept.append((onset, u))
    out = []
    for i, (onset, u) in enumerate(kept):
        end = kept[i + 1][0] if i + 1 < len(kept) else event_end
        out.append({"text": u.strip(), "start": onset, "end": end})
    return out


def json3_to_lines(events) -> list[dict]:
    """Raw json3 `events` to `[{start, end, text}]`: sorted, non-overlapping,
    capped. Raises CaptionsInvalid for the wrong shape, a non-finite or
    out-of-range timestamp. Returns [] when nothing usable is left."""
    if not isinstance(events, list) or len(events) > CAPTIONS_MAX_EVENTS:
        raise CaptionsInvalid("events must be a list of at most %d" % CAPTIONS_MAX_EVENTS)
    raw: list[dict] = []
    for ev in events:
        if not isinstance(ev, dict):
            raise CaptionsInvalid("event is not an object")
        segs = ev.get("segs")
        if segs is None:
            continue
        if not isinstance(segs, list):
            raise CaptionsInvalid("segs is not a list")
        start_ms = _num(ev.get("tStartMs", 0))
        dur_ms = _num(ev.get("dDurationMs", 0))
        parts = []
        timed: list[tuple[float, str]] = []
        has_offsets = False
        bad_offset = False
        for seg in segs:
            if not isinstance(seg, dict):
                raise CaptionsInvalid("seg is not an object")
            u = seg.get("utf8", "")
            if not isinstance(u, str):
                raise CaptionsInvalid("utf8 is not a string")
            parts.append(u)
            off_ms = 0.0
            if "tOffsetMs" in seg:
                has_offsets = True
                try:
                    off_ms = _num(seg["tOffsetMs"])
                except CaptionsInvalid:
                    # A bad offset only costs this event its pieces.
                    bad_offset = True
            if u.strip():
                timed.append(((start_ms + off_ms) / 1000.0, u))
        text = _WS_RE.sub(" ", "".join(parts).replace("\n", " ")).strip()
        text = cues_mod.clean_cue_text(text)
        if not text or _MARKER_RE.match(text) or text.startswith("♪"):
            continue
        start = start_ms / 1000.0
        end = start + dur_ms / 1000.0
        entry = {"start": start, "end": end, "text": text[:CAPTION_MAX_CHARS]}
        if has_offsets and not bad_offset and len(timed) >= 2:
            entry["pieces"] = _pieces(timed, end)
        raw.append(entry)
    raw.sort(key=lambda r: r["start"])
    out: list[dict] = []
    for line in raw:
        if out and line["start"] < out[-1]["end"]:
            out[-1]["end"] = max(line["start"], out[-1]["start"])
        if line["end"] - line["start"] < MIN_LINE_S:
            prev = out[-1] if out else None
            if prev is not None and prev["end"] - prev["start"] < MERGE_PREV_MAX_S:
                prev["text"] = (prev["text"] + " " + line["text"])[:CAPTION_MAX_CHARS]
                prev["end"] = max(prev["end"], line["end"])
                if prev.get("pieces") and line.get("pieces"):
                    prev["pieces"].extend(line["pieces"])
                else:
                    # Half the anchors would skew the even spread.
                    prev.pop("pieces", None)
                continue
            line["end"] = line["start"] + MIN_KEPT_S
        out.append(line)
    # Clipping can leave a previous line with no length at all.
    out = [ln for ln in out if ln["end"] - ln["start"] > 0]
    return out[:CAPTIONS_MAX_LINES]


def cues_from_lines(lines: list[dict]) -> list[dict]:
    """Lines to the cue shape the build uses. `pieces` are seg onsets relative
    to the line start, clamped to the line; empty when the track has none."""
    cues = []
    for ln in lines:
        dur = ln["end"] - ln["start"]
        pieces = []
        for pc in ln.get("pieces", []):
            a = min(max(pc["start"] - ln["start"], 0.0), dur)
            b = min(max(pc["end"] - ln["start"], 0.0), dur)
            if b > a:
                pieces.append({"text": pc["text"], "start": a, "end": b})
        cues.append({"start": ln["start"], "end": ln["end"], "text": ln["text"],
                     "words": [], "pieces": pieces})
    return cues
