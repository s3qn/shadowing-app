"""Timed text lines from outside VOICEVOX: an .srt file, or whisper segments.

Pure functions, no I/O. A cue is a dict `{"start", "end", "text"}` in
absolute seconds, plus an optional `"words"` list of
`{"text", "start", "end"}` (also absolute seconds) once whisper's words have
been attached to it. These feed `main._build_from_cues`, which slices audio
and calls `segment.align_pieces` per cue; this module only produces the cue
list and its timing bounds.
"""

import re

_TIMING_RE = re.compile(
    r"(\d{1,2}):(\d{2}):(\d{2})[,.](\d{1,3})\s*-->\s*(\d{1,2}):(\d{2}):(\d{2})[,.](\d{1,3})"
)
_TAG_RE = re.compile(r"<[^>]*>")
_ASS_RE = re.compile(r"\{[^}]*\}")
_WS_RE = re.compile(r"[ \t]+")
_CJK_RE = re.compile("[　-ヿ一-鿿＀-￯]")
_WRAP_PAIRS = (("（", "）"), ("(", ")"), ("［", "］"), ("[", "]"))
_SENTENCE_END = set("。！？、")


def _timestamp_seconds(hours: str, minutes: str, seconds: str, millis: str) -> float:
    frac = int(millis.ljust(3, "0")) / 1000
    return int(hours) * 3600 + int(minutes) * 60 + int(seconds) + frac


def parse_srt(text: str) -> list[dict]:
    """An .srt file's text into cues, sorted by start. Never raises: a block
    without an index or a timing line is skipped rather than failing the
    whole file.
    """
    text = text.lstrip("﻿").replace("\r\n", "\n").replace("\r", "\n")
    cues: list[dict] = []
    for block in re.split(r"\n\s*\n", text.strip()):
        lines = block.split("\n")
        idx = 0
        if idx < len(lines) and lines[idx].strip().isdigit():
            idx += 1
        if idx >= len(lines):
            continue
        match = _TIMING_RE.search(lines[idx])
        if not match:
            continue
        g = match.groups()
        start = _timestamp_seconds(*g[0:4])
        end = _timestamp_seconds(*g[4:8])
        cue_text = clean_cue_text("\n".join(lines[idx + 1 :]))
        if not cue_text or end <= start:
            continue
        cues.append({"start": start, "end": end, "text": cue_text})
    cues.sort(key=lambda c: c["start"])
    return cues


def clean_cue_text(raw: str) -> str:
    """Strip markup and normalise whitespace in one subtitle cue's text.

    janome glues a trailing space or newline onto the token before it
    (`は `, `聞いて\\n`), which is why whitespace must be gone before
    `segment` sees it. A cue that is entirely a bracketed sound effect or
    speaker note (`（ドアの音）`, `[笑い]`) becomes an empty string so
    `parse_srt` drops it.
    """
    text = _TAG_RE.sub("", raw)
    text = _ASS_RE.sub("", text)
    lines = [_WS_RE.sub(" ", ln).strip() for ln in text.split("\n")]
    lines = [ln for ln in lines if ln]
    result = ""
    for ln in lines:
        if not result:
            result = ln
        elif _CJK_RE.match(result[-1]) and _CJK_RE.match(ln[0]):
            result += ln
        else:
            result += " " + ln
    result = result.strip()
    for open_c, close_c in _WRAP_PAIRS:
        if len(result) >= 2 and result.startswith(open_c) and result.endswith(close_c):
            return ""
    return result


def window(cues: list[dict], start_s: float, total: float) -> list[dict]:
    """Cues shifted into an imported clip's own time base.

    The source media may be trimmed to `[start_s, start_s + total]` before
    slicing (the 30-minute import cap, or a `start_min` offset). Every cue is
    shifted by `-start_s` so its times are relative to the trimmed audio, a
    cue that falls entirely outside `[0, total]` is dropped, and an end that
    spills past `total` is clamped to it. Does not mutate the input cues.
    """
    out: list[dict] = []
    for cue in cues:
        start = cue["start"] - start_s
        end = cue["end"] - start_s
        if end <= 0 or start >= total:
            continue
        start = max(start, 0.0)
        end = min(end, total)
        if end <= start:
            continue
        out.append({**cue, "start": round(start, 3), "end": round(end, 3)})
    return out


def attach_words(cues: list[dict], words: list[dict], total: float,
                 pad_before: float = 0.15, pad_after: float = 0.30) -> list[dict]:
    """Hand each whisper word to the cue whose audio slice holds it.

    `cues` must be sorted by start (as `parse_srt` returns them), and `total`
    and the pads must be what `slice_bounds` will be called with, since each
    cue's window here is exactly `slice_bounds(cues, i, total)`. A word goes
    to a cue only when its midpoint lies inside that cue's `[start, end)`
    slice, so a word is never attached to a line whose audio does not contain
    it. Where two slices overlap, a cue whose own (unpadded) span holds the
    midpoint is preferred, then the earlier cue. A word whose midpoint is in
    no slice is dropped.

    `words` is whisper's flat list of `{"text", "start", "end"}` in absolute
    seconds. Does not mutate the input cues.
    """
    out = [dict(c, words=[]) for c in cues]
    bounds = [slice_bounds(cues, i, total, pad_before, pad_after) for i in range(len(cues))]
    for word in words:
        mid = (word["start"] + word["end"]) / 2
        holders = [i for i, (start, end) in enumerate(bounds) if start <= mid < end]
        if not holders:
            continue
        inside = [i for i in holders if cues[i]["start"] <= mid <= cues[i]["end"]]
        best = (inside or holders)[0]
        out[best]["words"].append({"text": word["text"], "start": word["start"], "end": word["end"]})
    return out


def slice_bounds(cues: list[dict], i: int, total: float, pad_before: float = 0.15, pad_after: float = 0.30) -> tuple[float, float]:
    """The `[start, end)` window in the source audio to slice for `cues[i]`.

    Pads each side unless a neighbouring cue overlaps that side, in which
    case the pad is simply not applied; always clamped to `0` and `total`.
    """
    cue = cues[i]
    if i > 0 and cues[i - 1]["end"] > cue["start"]:
        start = cue["start"]
    else:
        start = max(cue["start"] - pad_before, 0.0)
        if i > 0:
            start = max(start, cues[i - 1]["end"])
    if i < len(cues) - 1 and cues[i + 1]["start"] < cue["end"]:
        end = cue["end"]
    else:
        end = min(cue["end"] + pad_after, total)
        if i < len(cues) - 1:
            end = min(end, cues[i + 1]["start"])
    return round(start, 3), round(end, 3)


def _piece(words: list[dict]) -> dict:
    text = "".join(w["text"] for w in words).strip()
    return {"start": words[0]["start"], "end": words[-1]["end"], "text": text, "words": words}


def _split_one(words: list[dict], max_seconds: float, min_gap: float) -> list[dict]:
    pieces: list[dict] = []
    remaining = words
    while True:
        if len(remaining) <= 1:
            pieces.append(_piece(remaining))
            return pieces
        piece_start = remaining[0]["start"]
        cutoff = piece_start + max_seconds
        if remaining[-1]["end"] - piece_start <= max_seconds:
            pieces.append(_piece(remaining))
            return pieces
        candidates = [k for k, w in enumerate(remaining) if w["end"] <= cutoff]
        if not candidates:
            candidates = [0]
        best = candidates[-1]
        for k in reversed(candidates):
            w = remaining[k]
            ends_sentence = w["text"] and w["text"][-1] in _SENTENCE_END
            gap_ok = k + 1 < len(remaining) and remaining[k + 1]["start"] - w["end"] >= min_gap
            if ends_sentence or gap_ok:
                best = k
                break
        pieces.append(_piece(remaining[: best + 1]))
        remaining = remaining[best + 1 :]
        if not remaining:
            return pieces


def split_long(cues: list[dict], max_seconds: float = 8.0, min_gap: float = 0.35) -> list[dict]:
    """Cut a cue longer than `max_seconds` at a word boundary, repeatedly.

    Only cues that carry `words` are split; the boundary is the latest one
    before `max_seconds` from the piece's own start whose word ends with
    `。！？、` or whose gap to the next word is at least `min_gap`, falling
    back to the last boundary before `max_seconds` when none qualify. A cue
    with a single word is left as is, even over length. Stage 2 (whisper
    segments as cues) uses this; it lives here so the module is complete and
    tested once.
    """
    out: list[dict] = []
    for cue in cues:
        words = cue.get("words")
        if not words or cue["end"] - cue["start"] <= max_seconds:
            out.append(cue)
            continue
        out.extend(_split_one(words, max_seconds, min_gap))
    return out
