"""Word onsets from YouTube's ASR track, transferred onto the manual captions
(yt-precise). Pure, Japanese only.

A manual caption track has the right words and rough times; the auto track
has the wrong words and the right times (a tOffsetMs per token). The ASR
tokens become one stream of moras with a time each; every manual line's
moras are matched against the stream near its caption time with difflib,
and the matched chunks become `pieces` (segment.align_pieces anchors) while
the line's start and end move onto the voice. Lines nothing matches keep
their caption times. The rest of the build (split_lines, cues_from_lines,
align_pieces) is the existing pieces pipeline.
"""

from __future__ import annotations

import bisect
import difflib
import statistics

import segment
from youtube import MIN_LINE_S

WINDOW_S = 15.0        # how far from its caption time a line may be found
MIN_BLOCK = 3          # moras in a row before a match counts
MIN_RATIO = 0.5        # matched share of the line's moras, pass 1
MIN_RATIO_2 = 0.35     # pass 2, between two accepted neighbours
PAD_S = 0.1            # breath before the first word and after the last
MONO_SLACK_S = 0.5     # a line may start this much before the previous one ends
STRETCH_SLACK_S = 2.0  # a match spans at most 2x its mora time (or its caption) plus this
TAIL_GAP_S = 1.0       # a child whose voice ends this early gives up its tail
STUB_S = 0.4           # a retimed line shorter than this is a stub
STUB_RUN = 2           # this many stubs in a row fall back to caption times


def _flat_moras(chunks: list[dict]) -> tuple[list[str], list[int]]:
    """Every chunk's moras in order, with the chunk index each belongs to."""
    moras: list[str] = []
    owner: list[int] = []
    for i, c in enumerate(chunks):
        for m in c["moras"]:
            moras.append(m)
            owner.append(i)
    return moras, owner


def mora_stream(tokens: list[dict]) -> tuple[list[str], list[float]]:
    """The ASR tokens as one mora stream: mora k of a token's n moras is at
    start + (end - start) * k / n. A token with no reading is skipped."""
    moras: list[str] = []
    times: list[float] = []
    for tok in tokens:
        ms, _ = _flat_moras(segment.tokenize(tok["text"]))
        n = len(ms)
        if n == 0:
            continue
        start, end = float(tok["start"]), float(tok["end"])
        for k, m in enumerate(ms):
            moras.append(m)
            times.append(start + (end - start) * k / n)
    return moras, times


def _match(lm: list[str], lowner: list[int], moras: list[str], times: list[float],
           lo: float, hi: float, rate: float) -> tuple[dict, float]:
    """Match a line's moras against the stream moras timed in [lo, hi].
    Returns {chunk: [start, end]} for the chunks that matched and the matched
    share of the line's moras."""
    a = bisect.bisect_left(times, lo)
    b = bisect.bisect_right(times, hi)
    if b - a < MIN_BLOCK or not lm:
        return {}, 0.0
    wm = moras[a:b]
    sm = difflib.SequenceMatcher(None, lm, wm, autojunk=False)
    anchors: dict[int, list[float]] = {}
    matched = 0
    for blk in sm.get_matching_blocks():
        if blk.size < MIN_BLOCK:
            continue
        matched += blk.size
        for k in range(blk.size):
            chunk = lowner[blk.a + k]
            t = times[a + blk.b + k]
            span = anchors.get(chunk)
            if span is None:
                anchors[chunk] = [t, t + 1.0 / rate]
            else:
                span[0] = min(span[0], t)
                span[1] = max(span[1], t + 1.0 / rate)
    return anchors, matched / len(lm)


def _accept(anchors: dict, ratio: float, min_ratio: float, n_moras: int, rate: float,
            cap_span: float, prev_end: float | None) -> bool:
    """Enough of the line matched, the match is not stretched (it spans at
    most twice its mora time, or the caption's own span when a block holds
    a pause, plus slack) and it does not start before the previous accepted
    line ends."""
    if not anchors or ratio < min_ratio:
        return False
    first = min(s for s, _ in anchors.values())
    last = max(e for _, e in anchors.values())
    if last - first > max(2.0 * n_moras / rate, cap_span) + STRETCH_SLACK_S:
        return False
    if prev_end is not None and first < prev_end - MONO_SLACK_S:
        return False
    return True


def _timed(ln: dict, chunks: list[dict], anchors: dict, rate: float) -> tuple[float, float, list[dict]]:
    """Start, end and absolute pieces of an accepted line: the anchors, plus
    the moras before the first and after the last at the mora rate, plus a
    breath each side."""
    idxs = sorted(anchors)
    head = sum(len(c["moras"]) for c in chunks[:idxs[0]])
    tail = sum(len(c["moras"]) for c in chunks[idxs[-1] + 1:])
    start = anchors[idxs[0]][0] - head / rate - PAD_S
    end = anchors[idxs[-1]][1] + tail / rate + PAD_S
    pieces = []
    for j, i in enumerate(idxs):
        s, e = anchors[i]
        if j + 1 < len(idxs):
            nxt = anchors[idxs[j + 1]][0]
            if nxt > s:
                e = min(e, nxt)
        pieces.append({"text": chunks[i]["text"], "start": round(s, 3), "end": round(e, 3)})
    return start, end, pieces


def _chain(cands: list[tuple[float, float, float] | None]) -> list[bool]:
    """Which candidate matches to keep: `cands[i]` is (start, end, weight) of
    line i's match or None. Keeps the heaviest chain in line order where
    each kept match starts no earlier than the previous kept one's end
    minus MONO_SLACK_S (weighted longest increasing subsequence)."""
    idx = [i for i, c in enumerate(cands) if c is not None]
    best: dict[int, tuple[float, int | None]] = {}
    for k, i in enumerate(idx):
        start, _, weight = cands[i]
        score, back = weight, None
        for j in idx[:k]:
            if start >= cands[j][1] - MONO_SLACK_S and best[j][0] + weight > score:
                score, back = best[j][0] + weight, j
        best[i] = (score, back)
    keep = [False] * len(cands)
    at = max(idx, key=lambda i: best[i][0]) if idx else None
    while at is not None:
        keep[at] = True
        at = best[at][1]
    return keep


def _layout(lines: list[dict], found: list) -> list[tuple[float, float]]:
    """Final (start, end) of every line: its match, or its caption times,
    clamped after the previous line and before the next match, at least
    MIN_LINE_S long."""
    n = len(lines)
    nxt_starts: list[float | None] = [None] * n
    for i in range(n - 2, -1, -1):
        nxt_starts[i] = found[i + 1][0] if found[i + 1] is not None else nxt_starts[i + 1]
    spans: list[tuple[float, float]] = []
    prev_end: float | None = None
    for i in range(n):
        nxt_start = nxt_starts[i]
        start, end = found[i][:2] if found[i] is not None else (lines[i]["start"], lines[i]["end"])
        if prev_end is not None:
            start = max(start, prev_end)
        if nxt_start is not None:
            end = min(end, nxt_start)
        end = max(end, start + MIN_LINE_S)
        spans.append((round(start, 3), round(end, 3)))
        prev_end = spans[-1][1]
    return spans


def _stub_runs(lines: list[dict], spans: list[tuple[float, float]]) -> list[list[int]]:
    """Runs of STUB_RUN or more consecutive lines the layout made shorter
    than STUB_S that were at least that long before."""
    runs: list[list[int]] = []
    cur: list[int] = []
    for i, (start, end) in enumerate(spans):
        if end - start < STUB_S <= lines[i]["end"] - lines[i]["start"]:
            cur.append(i)
            continue
        if len(cur) >= STUB_RUN:
            runs.append(cur)
        cur = []
    if len(cur) >= STUB_RUN:
        runs.append(cur)
    return runs


def _guard_stubs(lines: list[dict], found: list) -> list[int]:
    """Never squeeze a span of lines into stubs. For each stub run plus the
    nearest match on either side, the matches the heaviest consistent chain
    leaves out (a loose line counts at its caption times, at half weight)
    are given up. A run with no such match keeps its old timing. Repeats
    until nothing changes. Edits `found`; returns the indices whose retime
    must not be written (given up, or left in a run), sorted."""
    guarded: set[int] = set()
    n = len(lines)
    while True:
        changed = False
        for run in _stub_runs(lines, _layout(lines, found)):
            before = next((j for j in range(run[0] - 1, -1, -1) if found[j] is not None), None)
            after = next((j for j in range(run[-1] + 1, n) if found[j] is not None), None)
            seg = [j for j in (before, *run, after) if j is not None]
            cands = [(found[j][0], found[j][1], 1.0) if found[j] is not None
                     else (lines[j]["start"], lines[j]["end"], 0.5) for j in seg]
            culprits = [j for j, keep in zip(seg, _chain(cands)) if not keep and found[j] is not None]
            if culprits:
                guarded.update(culprits)
                for j in culprits:
                    found[j] = None
                changed = True
            else:
                guarded.update(run)
        if not changed:
            return sorted(guarded)


def attach(lines: list[dict], tokens: list[dict], rate: float) -> tuple[list[dict], dict]:
    """Move every caption line onto the ASR voice it matches. `lines` are
    `[{start, end, text, ...}]` in absolute seconds (any other keys are
    kept); `rate` is segment.mora_rate of the caption lines. Returns new
    lines, each with `asr_ratio`, the accepted ones with `pieces` and new
    `start`/`end`, the rest with their caption times clamped between their
    neighbours; and a report {lines, anchored, median_ratio, median_shift_s,
    max_shift_s, guarded}, `guarded` the lines _guard_stubs put back on
    their caption times."""
    rate = rate if rate > 0 else segment.RATE_DEFAULT
    moras, times = mora_stream(tokens)
    out = [dict(ln) for ln in lines]
    n = len(out)
    prepared: list[tuple[list[dict], list[str], list[int]]] = []
    for ln in out:
        chunks = segment.tokenize(ln["text"])
        if "".join(c["text"] for c in chunks) != ln["text"]:
            chunks = []
        lm, lowner = _flat_moras(chunks)
        prepared.append((chunks, lm, lowner))
    found: list[tuple[float, float, list[dict]] | None] = [None] * n
    ratios = [0.0] * n

    if moras:
        # Pass 1: every line is looked for on its own in its window, then
        # the heaviest chain of matches in time order is kept. One false
        # match (a short line repeated later) then costs only itself, never
        # the correct lines after it.
        cands: list[tuple[float, float, float] | None] = [None] * n
        timed: list[tuple[float, float, list[dict]] | None] = [None] * n
        for i, ln in enumerate(out):
            chunks, lm, lowner = prepared[i]
            anchors, ratio = _match(lm, lowner, moras, times,
                                    ln["start"] - WINDOW_S, ln["end"] + WINDOW_S, rate)
            ratios[i] = ratio
            if _accept(anchors, ratio, MIN_RATIO, len(lm), rate, ln["end"] - ln["start"], None):
                timed[i] = _timed(ln, chunks, anchors, rate)
                cands[i] = (timed[i][0], timed[i][1], ratio * len(lm))
        for i, keep in enumerate(_chain(cands)):
            if keep:
                found[i] = timed[i]
        # Pass 2: a line still loose between two accepted neighbours is
        # looked for only between them, with a lower bar.
        for i in range(n):
            if found[i] is not None:
                continue
            prev = next((j for j in range(i - 1, -1, -1) if found[j] is not None), None)
            nxt = next((j for j in range(i + 1, n) if found[j] is not None), None)
            if prev is None or nxt is None:
                continue
            chunks, lm, lowner = prepared[i]
            lo, hi = found[prev][1] - 1.0, found[nxt][0] + 1.0
            anchors, ratio = _match(lm, lowner, moras, times, lo, hi, rate)
            if _accept(anchors, ratio, MIN_RATIO_2, len(lm), rate,
                       out[i]["end"] - out[i]["start"], found[prev][1]):
                start, end, pieces = _timed(out[i], chunks, anchors, rate)
                if start < found[nxt][0]:
                    found[i] = (start, end, pieces)
                    ratios[i] = ratio

    guarded = _guard_stubs(lines, found)
    spans = _layout(lines, found)
    shifts: list[float] = []
    for i, ln in enumerate(out):
        ln["asr_ratio"] = round(ratios[i], 3)
        if found[i] is not None:
            shifts.append(found[i][0] - lines[i]["start"])
            ln["pieces"] = found[i][2]
        ln["start"], ln["end"] = spans[i]
    anchored = sum(1 for f in found if f is not None)
    report = {
        "lines": n,
        "anchored": anchored,
        "median_ratio": round(statistics.median(ratios), 3) if ratios else 0.0,
        "median_shift_s": round(statistics.median(abs(s) for s in shifts), 3) if shifts else 0.0,
        "max_shift_s": round(max((abs(s) for s in shifts), default=0.0), 3),
        "guarded": guarded,
    }
    return out, report


def trim_tails(lines: list[dict]) -> list[dict]:
    """After split_lines: a child whose last chunk is anchored and whose
    voice ends more than TAIL_GAP_S before the child's end gives the gap up,
    so the last word is not lit through a pause inside a caption block.
    Pure; lines without pieces are returned as they are."""
    out = []
    for ln in lines:
        pieces = ln.get("pieces") or []
        if pieces:
            last = pieces[-1]
            bare = lambda s: "".join(ch for ch in s if not ch.isspace())
            voice_end = last["end"] + PAD_S
            if bare(ln["text"]).endswith(bare(last["text"])) and ln["end"] - voice_end > TAIL_GAP_S:
                ln = dict(ln, end=round(max(voice_end, ln["start"] + MIN_LINE_S), 3))
        out.append(ln)
    return out
