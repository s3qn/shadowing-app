"""YouTube links and captions: parsing a video id, reading its title, and
turning the raw json3 caption events the phone fetched into lines.

The server IP is blocked by YouTube, so the phone downloads the caption track
and posts the raw events. Everything here is pure and offline.
"""

from __future__ import annotations

import difflib
import json
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

# Body budget. Raw ASR json3 runs about 60 bytes a token
# ({"utf8", "tOffsetMs", "acAsrConf"}) at up to 4 tokens a second of fast
# Japanese: about 1 MB an hour, so a 4 h video (CAPTIONS_MAX_SECONDS) at
# ASR_MAX_TOKENS is about 4.5 MB with its events. A manual track is about
# 150 KB an hour. The body fits both caps; an ASR track over its own caps is
# dropped and the manual track imports alone.
CAPTIONS_MANUAL_BYTES = 2 * 1024 * 1024
ASR_MAX_BYTES = 5 * 1024 * 1024
CAPTIONS_MAX_BODY = CAPTIONS_MANUAL_BYTES + ASR_MAX_BYTES
CAPTIONS_MAX_EVENTS = 6000
ASR_MAX_EVENTS = 12000
ASR_MAX_SEGS_PER_EVENT = 100
ASR_MAX_TOKENS = 60000
TOKEN_MAX_S = 1.5
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


def stretch_lumps(lines: list[dict]) -> list[dict]:
    """yt-lump: the ASR track sometimes packs 10 s or more of speech into one
    seg with no offsets and a 3 s dDurationMs, while the caption stays on
    screen until the next event. A ja line with no pieces whose moras cannot
    fit at segment.RATE_MAX gets its end moved to the next line's start (at
    most its moras at RATE_MIN), so the split spreads it over the voice
    instead of cramming it into the first seconds. Run before mora_rate: a
    lump would read as the fastest speaker on the track."""
    import segment

    out = []
    for i, ln in enumerate(lines):
        dur = ln["end"] - ln["start"]
        if not ln.get("pieces") and dur > 0:
            n = len(segment.moras_of(ln["text"]))
            if n / dur > segment.RATE_MAX:
                nxt = lines[i + 1]["start"] if i + 1 < len(lines) else math.inf
                end = min(nxt, ln["start"] + n / segment.RATE_MIN)
                if end > ln["end"]:
                    ln = {**ln, "end": round(end, 3)}
        out.append(ln)
    return out


def asr_tokens(events) -> list[dict]:
    """The ASR track's json3 events to `[{text, start, end}]` in absolute
    seconds, sorted by onset: one token per seg with text, onset = tStartMs +
    tOffsetMs. YouTube omits a zero tOffsetMs (the first seg of an event, a
    one-seg event), so a missing offset is 0. A token ends at the next onset,
    at most TOKEN_MAX_S later and never after its own event. Raises
    CaptionsInvalid for the wrong shape, a bad timestamp or offset, or a
    track over its caps (events, segs per event, tokens, ASR_MAX_BYTES)."""
    if not isinstance(events, list) or len(events) > ASR_MAX_EVENTS:
        raise CaptionsInvalid("asr events must be a list of at most %d" % ASR_MAX_EVENTS)
    seen = 0
    raw: list[tuple[float, float, str]] = []
    for ev in events:
        if not isinstance(ev, dict):
            raise CaptionsInvalid("event is not an object")
        segs = ev.get("segs")
        if segs is None:
            continue
        if not isinstance(segs, list):
            raise CaptionsInvalid("segs is not a list")
        seen += len(segs)
        if len(segs) > ASR_MAX_SEGS_PER_EVENT or seen > ASR_MAX_TOKENS:
            raise CaptionsInvalid("asr track over %d segs an event or %d in all"
                                  % (ASR_MAX_SEGS_PER_EVENT, ASR_MAX_TOKENS))
        start_ms = _num(ev.get("tStartMs", 0))
        dur_ms = _num(ev.get("dDurationMs", 0))
        for seg in segs:
            if not isinstance(seg, dict):
                raise CaptionsInvalid("seg is not an object")
            u = seg.get("utf8", "")
            if not isinstance(u, str):
                raise CaptionsInvalid("utf8 is not a string")
            off_ms = _num(seg["tOffsetMs"]) if "tOffsetMs" in seg else 0.0
            text = u.strip()
            if not text or _MARKER_RE.match(text) or text.startswith("♪"):
                continue
            raw.append(((start_ms + off_ms) / 1000.0, (start_ms + dur_ms) / 1000.0, text))
    size = len(json.dumps(events, ensure_ascii=False, separators=(",", ":")).encode()) if events else 0
    if size > ASR_MAX_BYTES:
        raise CaptionsInvalid("asr track over %d bytes" % ASR_MAX_BYTES)
    raw.sort(key=lambda r: r[0])
    out = []
    for i, (onset, event_end, text) in enumerate(raw):
        if i + 1 < len(raw):
            end = min(raw[i + 1][0], event_end, onset + TOKEN_MAX_S)
        else:
            end = event_end
        out.append({"text": text, "start": onset, "end": max(end, onset)})
    return out


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


SPLIT_MAX_CHARS = 25
SPLIT_MAX_S = 6.0
SPLIT_MIN_CHARS = 6
SPLIT_HARD_CHARS = 40
SPLIT_MIN_CHILD = 2
CLAUSE_ENDS = ("けど", "から", "とか", "って", "ので")
_PUNCT_END = "、。？！,.?!"


def _char_clock(text: str, pieces: list[dict] | None, start: float, end: float,
                owners: list[int | None] | None = None) -> list[float]:
    """One time per character of `text`: from the pieces when given, else linear.
    When `owners` is a list it is filled with the piece index each char matched."""
    n = len(text)
    times: list[float | None] = [None] * n
    if owners is not None:
        owners[:] = [None] * n
    if pieces:
        flat, owner = [], []
        for pi, p in enumerate(pieces):
            for k, ch in enumerate(p["text"]):
                if not ch.isspace():
                    flat.append(ch)
                    owner.append((pi, k))
        idx = [i for i, ch in enumerate(text) if not ch.isspace()]
        sm = difflib.SequenceMatcher(None, "".join(text[i] for i in idx), "".join(flat), autojunk=False)
        for blk in sm.get_matching_blocks():
            for off in range(blk.size):
                pi, k = owner[blk.b + off]
                p = pieces[pi]
                m = max(len(p["text"]), 1)
                times[idx[blk.a + off]] = p["start"] + (p["end"] - p["start"]) * k / m
                if owners is not None:
                    owners[idx[blk.a + off]] = pi
    known = [i for i, t in enumerate(times) if t is not None]
    if not known:
        return [start + (end - start) * i / max(n, 1) for i in range(n)]
    out = []
    for i in range(n):
        if times[i] is not None:
            out.append(times[i])
            continue
        lo = max((k for k in known if k < i), default=None)
        hi = min((k for k in known if k > i), default=None)
        t0, i0 = (times[lo], lo) if lo is not None else (start, -1)
        t1, i1 = (times[hi], hi) if hi is not None else (end, n)
        out.append(t0 + (t1 - t0) * (i - i0) / (i1 - i0))
    return out


def _is_boundary(chunk_text: str) -> bool:
    t = chunk_text.rstrip()
    if not t:
        return False
    if t[-1] in _PUNCT_END:
        return True
    return t.rstrip(_PUNCT_END).endswith(CLAUSE_ENDS)


def _mora_clock(text: str, chunks: list[dict], start: float, end: float, rate: float) -> list[float]:
    """One time per character of `text` from the mora clock: each chunk takes
    its mora count over `rate` seconds (characters inside a chunk linear), the
    whole squeezed to fit the line when the speech would overrun it. A chunk
    with no reading counts its letters as moras; punctuation takes no time."""
    n = len(text)
    weights = []
    for c in chunks:
        w = len(c["moras"])
        if w == 0:
            w = sum(1 for ch in c["text"] if ch.isalnum())
        weights.append(w)
    total = sum(weights)
    if total == 0 or rate <= 0:
        return [start + (end - start) * i / max(n, 1) for i in range(n)]
    scale = min(1.0, (end - start) / (total / rate))
    out: list[float] = []
    before = 0.0
    for c, w in zip(chunks, weights):
        m = max(len(c["text"]), 1)
        for k in range(len(c["text"])):
            out.append(start + (before + w * k / m) / rate * scale)
        before += w
    return out


def _split_one(ln: dict, max_chars: int, max_s: float, rate: float | None = None) -> list[dict]:
    import segment

    text = ln["text"]
    chunks = segment.tokenize(text)
    if "".join(c["text"] for c in chunks) != text:
        return [ln]
    # A chunk can end in the digits of a number whose counter opens the next
    # chunk ("か。7" | "時"): cut after the punctuation, never inside a number.
    split: list[str] = []
    for c in chunks:
        m = re.match(r"^(.*[{}])(\d+)$".format(_PUNCT_END), c["text"])
        split.extend(m.groups() if m else [c["text"]])
    ends, pos = [], 0
    for t in split:
        pos += len(t)
        ends.append(pos)
    ends = ends[:-1]
    bounds = [(e, _is_boundary(t)) for e, t in zip(ends, split)]
    bounds = [(e, b) for e, b in bounds if not text[e - 1:e].isdigit()]
    owners: list[int | None] = []
    if rate is not None and not ln.get("pieces"):
        clock = _mora_clock(text, chunks, ln["start"], ln["end"], rate)
    else:
        clock = _char_clock(text, ln.get("pieces"), ln["start"], ln["end"], owners)
    size = lambda a, b: len(re.sub(r"\s", "", text[a:b]))

    def t_at(k: int) -> float:
        return round(clock[k], 3)

    cuts, a = [], 0
    while True:
        rem_s = ln["end"] - (t_at(a) if a else ln["start"])
        if size(a, len(text)) <= max_chars and rem_s <= max_s:
            break

        def ok_cut(k: int) -> bool:
            left_s = t_at(k) - (t_at(a) if a else ln["start"])
            right_s = ln["end"] - t_at(k)
            return left_s >= MIN_KEPT_S and right_s >= MIN_KEPT_S

        def fits(k: int) -> bool:
            left_s = t_at(k) - (t_at(a) if a else ln["start"])
            return size(a, k) <= max_chars and left_s <= max_s

        cands = [e for e, b in bounds if b and e > a and ok_cut(e)]
        pick = None
        within = [e for e in cands if fits(e) and size(a, e) >= SPLIT_MIN_CHARS]
        if within:
            pick = within[-1]
        else:
            after = [e for e in cands if not fits(e)]
            if after:
                pick = after[0]
            elif size(a, len(text)) > SPLIT_HARD_CHARS:
                allc = [e for e, _ in bounds if e > a and ok_cut(e)]
                if allc:
                    pick = min(allc, key=lambda e: abs(size(a, e) - max_chars))
        if pick is None:
            break
        cuts.append(pick)
        a = pick
    # Keep cut times strictly increasing, then fold any child too thin to
    # tap (whitespace or a lone 「ね。」) into its neighbour.
    mono, prev = [], ln["start"]
    for k in cuts:
        if prev < t_at(k) < ln["end"]:
            mono.append(k)
            prev = t_at(k)
    cuts = mono
    while cuts:
        edges = [0] + cuts + [len(text)]
        thin = next((i for i in range(len(edges) - 1)
                     if sum(ch.isalnum() for ch in text[edges[i]:edges[i + 1]]) < SPLIT_MIN_CHILD), None)
        if thin is None:
            break
        del cuts[max(thin - 1, 0)]
    if not cuts:
        return [ln]
    edges = [0] + cuts + [len(text)]
    times = [ln["start"]] + [t_at(k) for k in cuts] + [ln["end"]]
    bare = lambda s: re.sub(r"\s", "", s)
    out = []
    for i in range(len(edges) - 1):
        s, e = edges[i], edges[i + 1]
        while s < e and text[s].isspace():
            s += 1
        while e > s and text[e - 1].isspace():
            e -= 1
        child = {"start": times[i], "end": times[i + 1], "text": text[s:e]}
        if "pieces" in ln:
            lo = times[i] if i else float("-inf")
            hi = times[i + 1] if i < len(edges) - 2 else float("inf")
            kept = [p for p in ln["pieces"] if lo <= p["start"] < hi]
            if not kept or bare("".join(p["text"] for p in kept)) != bare(child["text"]):
                kept = _child_pieces(text, s, e, owners, clock, times[i], times[i + 1])
            child["pieces"] = kept
        out.append(child)
    return out


def _child_pieces(text: str, s: int, e: int, owners: list[int | None], clock: list[float],
                  t0: float, t1: float) -> list[dict]:
    """Pieces covering exactly text[s:e], cut where the source piece changes,
    timed from the char clock and clamped into [t0, t1)."""
    groups: list[list] = []
    for k in range(s, e):
        o = owners[k] if k < len(owners) else None
        if not groups or (o is not None and groups[-1][1] is not None and o != groups[-1][1]):
            groups.append([k, o])
        elif groups[-1][1] is None:
            groups[-1][1] = o
    out, prev = [], t0
    for j, (g0, _) in enumerate(groups):
        g1 = groups[j + 1][0] if j + 1 < len(groups) else e
        st = t0 if j == 0 else min(max(round(clock[g0], 3), prev), t1)
        out.append({"text": text[g0:g1], "start": st, "end": t1})
        if j:
            out[j - 1]["end"] = st
        prev = st
    return out


def split_lines(lines: list[dict], max_chars: int = SPLIT_MAX_CHARS, max_s: float = SPLIT_MAX_S,
                rate: float | None = None) -> list[dict]:
    """Split long ja lines at clause ends, never inside a janome chunk. Pure.
    Cut times come from the pieces when a line has them, else from the mora
    clock at `rate` moras per second (segment.mora_rate), else linear."""
    out: list[dict] = []
    for ln in lines:
        text = ln["text"]
        if len(re.sub(r"\s", "", text)) <= max_chars and ln["end"] - ln["start"] <= max_s:
            out.append(ln)
        else:
            out.extend(_split_one(ln, max_chars, max_s, rate))
    return out
