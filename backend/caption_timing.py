"""Word timing of YouTube islands built from captions alone (yt-drift).

A manual caption runs until the next caption, so an even mora spread over
the caption span lights words through the speaker's trailing pause. The
backfill rewrites such lines so their speech ends at mora count / the
island's mora rate (segment.speech_end); the scorer measures that trim
against VOICEVOX islands, whose word times are exact.

Backfill is a dry run unless `apply` is set, writes only lines that still
carry the even signature (so it is idempotent), and guards each write with
the words it read. CLI: scripts/caption_timing.py.

yt-precise adds `transfer`: the ASR track's word onsets moved onto an
island's lines (asr_transfer.attach), with timing-before.json kept for
`restore`, and `score_transfer`, which measures that against VOICEVOX
islands with simulated caption blocks and a simulated ASR track.
"""

from __future__ import annotations

import json
import logging
import os
import random

import asr_transfer
import segment
import store
import youtube

log = logging.getLogger("shadow")

EVEN_TOL_S = 0.002
PAUSE_MAX_S = 2.5
PAUSE_SHARE = 0.75  # of lines get a pause: about 45% end up over 1 s


def is_even(text: str, duration: float, words: list[dict]) -> bool:
    """True when `words` are the even mora spread align_pieces makes with no
    pieces and no speech end: the signature of a line that still needs the
    trim. A trimmed line (last end before `duration`) never matches."""
    even = segment.align_pieces(text, [], duration)
    if not words or len(even) != len(words):
        return False
    return all(
        a["text"] == b.get("text")
        and abs(a["start"] - float(b.get("start", -1))) <= EVEN_TOL_S
        and abs(a["end"] - float(b.get("end", -1))) <= EVEN_TOL_S
        for a, b in zip(even, words)
    )


def island_rate(lines: list[dict]) -> float:
    return segment.mora_rate([(ln["ja"], float(ln["duration"])) for ln in lines])


def _islands(island: str | None, source: str | None, need_timeline: bool) -> list[dict]:
    out = []
    for isl in store.list_islands():
        if island is not None and isl["id"] != island:
            continue
        if isl["status"] != "ready" or isl["language"] != "ja":
            continue
        if source is not None and isl["source"] != source:
            continue
        if source is None and isl["source"] == "youtube":
            continue
        full = store.get_island(isl["id"])
        if full is None:
            continue
        lines = [ln for ln in full["lines"] if ln["ja"] and ln["duration"] > 0]
        if need_timeline:
            lines = [ln for ln in lines if ln["timeline"] and ln["words"]]
        if lines:
            out.append({"id": isl["id"], "title": isl["title"], "lines": lines})
    return out


def backfill(apply: bool = False, island: str | None = None) -> dict:
    """Trim the speech of every even-spread line of every ready ja YouTube
    island (or one island). Dry run unless `apply`. Returns the report:
    per island the lines flagged and written, the rate, the seconds trimmed
    and the silence share of the caption time."""
    report: dict = {"islands": [], "flagged": 0, "written": 0, "apply": apply}
    for isl in _islands(island, "youtube", need_timeline=False):
        lines = isl["lines"]
        rate = island_rate(lines)
        caption_s = sum(float(ln["duration"]) for ln in lines)
        row = {"id": isl["id"], "title": isl["title"], "lines": len(lines), "flagged": 0,
               "written": 0, "rate": rate, "trimmed_s": 0.0, "caption_s": caption_s,
               "silence_share": 0.0}
        for ln in lines:
            text, duration = ln["ja"], float(ln["duration"])
            end = segment.speech_end(text, duration, rate)
            if end is None or not is_even(text, duration, ln["words"]):
                continue
            row["flagged"] += 1
            row["trimmed_s"] += duration - end
            if apply:
                words = segment.align_pieces(text, [], duration, speech_end=end)
                if store.set_words(isl["id"], ln["idx"], words, expected=ln["words"]):
                    row["written"] += 1
                else:
                    log.warning("caption_timing: island %s line %d changed under us, skipped",
                                isl["id"], ln["idx"])
        if caption_s > 0:
            row["silence_share"] = row["trimmed_s"] / caption_s
        report["islands"].append(row)
        report["flagged"] += row["flagged"]
        report["written"] += row["written"]
    return report


def format_backfill(report: dict) -> str:
    head = "apply" if report["apply"] else "dry run"
    out = [f"caption_timing backfill ({head}): {len(report['islands'])} islands,"
           f" {report['flagged']} lines flagged, {report['written']} written",
           f"{'island':<14} {'lines':>5} {'flag':>5} {'wrote':>5} {'rate':>5} {'trim s':>7} {'silence':>7}  title"]
    for r in report["islands"]:
        out.append(f"{r['id']:<14} {r['lines']:>5} {r['flagged']:>5} {r['written']:>5} {r['rate']:>5.1f}"
                   f" {r['trimmed_s']:>7.1f} {r['silence_share']:>6.0%}  {r['title'][:40]}")
    return "\n".join(out)


# --- scorer ---------------------------------------------------------------

def _lit_at(words: list[dict], t: float) -> int | None:
    for i, w in enumerate(words):
        if w["start"] <= t < w["end"]:
            return i
    return None


def _overlap(truth: list[dict], cand: list[dict], span: float) -> float:
    """Share of `span` where the lit word index of `cand` equals that of
    `truth`; nothing lit on both sides (the pause) counts as a match."""
    edges = sorted({0.0, span} | {w[k] for w in truth + cand for k in ("start", "end")})
    edges = [e for e in edges if 0.0 <= e <= span]
    match = 0.0
    for a, b in zip(edges, edges[1:]):
        if b <= a:
            continue
        mid = (a + b) / 2
        if _lit_at(truth, mid) == _lit_at(cand, mid):
            match += b - a
    return match / span if span > 0 else 0.0


def _stats(overlaps: list[float], errors: list[float]) -> dict:
    if not overlaps:
        return {"overlap": 0.0, "mean_err": 0.0, "p90_err": 0.0}
    errs = sorted(errors)
    p90 = errs[int(0.9 * (len(errs) - 1) + 0.5)] if errs else 0.0
    return {"overlap": sum(overlaps) / len(overlaps),
            "mean_err": sum(errs) / len(errs) if errs else 0.0, "p90_err": p90}


def score(seed: int = 1, island: str | None = None) -> dict:
    """Measure the trim against islands with exact word times (every ready ja
    island with a timeline and a non-youtube source, or one island). Each
    line becomes a simulated caption span = duration + a seeded random pause;
    the rate is estimated from those spans so estimation error counts.
    `before` is the even spread over the span, `after` the same with
    speech_end. Per island and in total: overlap share, mean and p90 |word
    start error| in seconds."""
    rng = random.Random(seed)
    result: dict = {"islands": [], "total": {"lines": 0}}
    acc = {"before": ([], []), "after": ([], [])}
    for isl in _islands(island, None, need_timeline=True):
        sim = []
        for ln in isl["lines"]:
            pause = rng.uniform(0.0, PAUSE_MAX_S) if rng.random() < PAUSE_SHARE else 0.0
            sim.append((ln, round(float(ln["duration"]) + pause, 3)))
        rate = segment.mora_rate([(ln["ja"], span) for ln, span in sim])
        per = {"before": ([], []), "after": ([], [])}
        n = 0
        for ln, span in sim:
            text, truth = ln["ja"], ln["words"]
            before = segment.align_pieces(text, [], span)
            after = segment.align_pieces(text, [], span, speech_end=segment.speech_end(text, span, rate))
            if [w["text"] for w in truth] != [w["text"] for w in before]:
                continue
            n += 1
            for key, cand in (("before", before), ("after", after)):
                per[key][0].append(_overlap(truth, cand, span))
                per[key][1].extend(abs(c["start"] - t["start"]) for c, t in zip(cand, truth))
        if n == 0:
            continue
        result["islands"].append({"id": isl["id"], "title": isl["title"], "lines": n, "rate": rate,
                                  "before": _stats(*per["before"]), "after": _stats(*per["after"])})
        result["total"]["lines"] += n
        for key in ("before", "after"):
            acc[key][0].extend(per[key][0])
            acc[key][1].extend(per[key][1])
    result["total"]["before"] = _stats(*acc["before"])
    result["total"]["after"] = _stats(*acc["after"])
    return result


def format_score(result: dict) -> str:
    def cell(s: dict) -> str:
        return f"{s['overlap']:>7.1%} {s['mean_err']:>6.2f} {s['p90_err']:>6.2f}"

    out = [f"{'island':<14} {'lines':>5} {'rate':>5}  {'overlap':>7} {'mean':>6} {'p90':>6}"
           f"  -> {'overlap':>7} {'mean':>6} {'p90':>6}  title"]
    for r in result["islands"]:
        out.append(f"{r['id']:<14} {r['lines']:>5} {r['rate']:>5.1f}  {cell(r['before'])}"
                   f"  -> {cell(r['after'])}  {r['title'][:40]}")
    t = result["total"]
    if t["lines"]:
        out.append(f"{'total':<14} {t['lines']:>5} {'':>5}  {cell(t['before'])}  -> {cell(t['after'])}")
    else:
        out.append("no island with exact word times to score")
    return "\n".join(out)


# --- yt-precise: ASR transfer -----------------------------------------------

SPAN_TOL_S = 0.005


def _backup_path(island_id: str):
    return store.AUDIO_DIR / island_id / "timing-before.json"


def _island_lines(island_id: str) -> list[dict]:
    full = store.get_island(island_id)
    if full is None:
        raise ValueError(f"no such island: {island_id}")
    return [ln for ln in full["lines"] if ln["ja"]]


def transfer(island_id: str, tokens: list[dict], apply: bool = False) -> dict:
    """Retime one video island's lines from ASR `tokens` (youtube.asr_tokens).
    Dry run unless `apply`: then timing-before.json is written once (never
    overwritten), every anchored line gets words from its pieces and a new
    span, a loose line whose span the clamp moved gets the mora clock over
    the new span, and each write is guarded by the words it read. Returns
    the attach report plus `tokens`, `written` and per-line `rows`."""
    stored = _island_lines(island_id)
    lines = [{"idx": ln["idx"], "text": ln["ja"], "start": float(ln["offset"]),
              "end": float(ln["offset"]) + float(ln["duration"])} for ln in stored]
    rate = island_rate(stored)
    new, report = asr_transfer.attach(lines, tokens, rate)
    report.update({"id": island_id, "tokens": len(tokens), "rate": rate, "apply": apply,
                   "written": 0, "rows": []})
    backed_up = False
    guarded = set(report["guarded"])
    for i, (old, ln, nl) in enumerate(zip(stored, lines, new)):
        anchored = bool(nl.get("pieces"))
        moved = abs(nl["start"] - ln["start"]) > SPAN_TOL_S or abs(nl["end"] - ln["end"]) > SPAN_TOL_S
        row = {"idx": old["idx"], "text": old["ja"], "old": ln["start"], "new": nl["start"],
               "shift": round(nl["start"] - ln["start"], 3), "ratio": nl["asr_ratio"],
               "anchored": anchored, "guarded": i in guarded, "written": False}
        report["rows"].append(row)
        # a guarded line keeps its old timing, whatever the clamp left of it
        if not apply or row["guarded"] or not (anchored or moved):
            continue
        if not backed_up:
            _write_backup(island_id, stored)
            backed_up = True
        duration = round(nl["end"] - nl["start"], 3)
        if anchored:
            pieces = [{"text": p["text"], "start": p["start"] - nl["start"], "end": p["end"] - nl["start"]}
                      for p in nl["pieces"]]
            words = segment.align_pieces(old["ja"], pieces, duration)
        else:
            words = segment.align_pieces(old["ja"], [], duration,
                                         speech_end=segment.speech_end(old["ja"], duration, rate))
        if store.set_words(island_id, old["idx"], words, expected=old["words"]):
            store.set_line_span(island_id, old["idx"], nl["start"], duration)
            row["written"] = True
            report["written"] += 1
        else:
            log.warning("caption_timing: island %s line %d changed under us, skipped",
                        island_id, old["idx"])
    return report


class RestoreError(ValueError):
    """No timing-before.json to restore, or one that cannot be read."""


def _write_backup(island_id: str, stored: list[dict]) -> None:
    """timing-before.json, written once: a temp file moved into place, so a
    crash never leaves a half backup that blocks the real one."""
    path = _backup_path(island_id)
    if path.exists():
        return
    path.parent.mkdir(parents=True, exist_ok=True)
    blob = {"island": island_id, "lines": [
        {"idx": ln["idx"], "offset": ln["offset"], "duration": ln["duration"], "words": ln["words"]}
        for ln in stored]}
    tmp = path.with_name(path.name + ".tmp")
    try:
        tmp.write_text(json.dumps(blob, ensure_ascii=False))
        os.replace(tmp, path)
    finally:
        tmp.unlink(missing_ok=True)


def _read_backup(island_id: str) -> list[dict]:
    path = _backup_path(island_id)
    if not path.exists():
        raise RestoreError(f"no timing-before.json for island {island_id}: nothing to restore")
    try:
        lines = json.loads(path.read_text())["lines"]
        if not isinstance(lines, list):
            raise TypeError("lines is not a list")
        for ln in lines:
            if not (isinstance(ln["idx"], int) and isinstance(ln["offset"], (int, float))
                    and isinstance(ln["duration"], (int, float)) and isinstance(ln["words"], list)):
                raise TypeError("a line has the wrong shape")
    except (OSError, ValueError, TypeError, KeyError) as exc:
        raise RestoreError(f"timing-before.json of island {island_id} is unreadable ({exc}); nothing restored")
    return lines


def restore(island_id: str) -> int:
    """Put back the words and spans timing-before.json holds. Returns the
    number of lines restored; raises RestoreError, before any write, when
    the backup is missing or unreadable."""
    lines = _read_backup(island_id)
    for ln in lines:
        store.set_words(island_id, ln["idx"], ln["words"])
        store.set_line_span(island_id, ln["idx"], ln["offset"], ln["duration"])
    return len(lines)


def tokens_from_captions_json(island_id: str) -> list[dict]:
    """The ASR tokens of audio/<id>/captions.json, [] without the file."""
    path = store.AUDIO_DIR / island_id / "captions.json"
    if not path.exists():
        return []
    return youtube.asr_tokens(json.loads(path.read_text()).get("asr_events") or [])


def format_transfer(report: dict) -> str:
    head = "apply" if report["apply"] else "dry run"
    out = [f"caption_timing transfer ({head}) island {report['id']}: {report['tokens']} tokens,"
           f" {report['anchored']} of {report['lines']} lines anchored, {report['written']} written,"
           f" {len(report['guarded'])} guarded (old timing kept, retime made stubs),"
           f" median ratio {report['median_ratio']:.2f}, median shift {report['median_shift_s']:.2f} s,"
           f" max {report['max_shift_s']:.2f} s, rate {report['rate']:.1f}",
           f"{'idx':>4} {'old':>8} {'new':>8} {'shift':>7} {'ratio':>5} {'':2} text"]
    for r in report["rows"]:
        mark = "g" if r["guarded"] else "*" if r["anchored"] else " "
        wrote = "w" if r["written"] else " "
        out.append(f"{r['idx']:>4} {r['old']:>8.2f} {r['new']:>8.2f} {r['shift']:>+7.2f} {r['ratio']:>5.2f}"
                   f" {mark}{wrote} {r['text'][:36]}")
    return "\n".join(out)


# --- yt-precise: scorer --------------------------------------------------------

CAPTION_LEAD_MAX_S = 0.5    # a manual caption appears up to this early
BLOCK_GAP_MAX_S = 0.8       # pause between the lines of one caption block
INNER_PAUSE_SHARE = 0.2     # blocks with a long pause inside
INNER_PAUSE_S = (4.0, 10.0)
ASR_JITTER_S = 0.15
ASR_RESPELL_SHARE = 0.1
ASR_DROP_SHARE = 0.05
WITHIN_S = 0.5


def _simulate(lines: list[dict], rng: random.Random) -> tuple[list[dict], list[dict], list[tuple[float, float, list[float]]]]:
    """Caption blocks of 1 to 3 lines plus a pause (some with a long pause
    inside), ASR tokens from the exact words (jittered, some respelled, some
    dropped) and, per block, the true time of each character of its text."""
    blocks: list[dict] = []
    tokens: list[dict] = []
    clocks: list[tuple[float, float, list[float]]] = []
    t = 1.0
    i = 0
    while i < len(lines):
        members = lines[i:i + rng.randint(1, 3)]
        i += len(members)
        pause_at = rng.randint(1, len(members) - 1) if len(members) > 1 and rng.random() < INNER_PAUSE_SHARE else -1
        cap_start = t - rng.uniform(0.0, CAPTION_LEAD_MAX_S)
        text = ""
        char_times: list[float] = []
        for k, ln in enumerate(members):
            if k == pause_at:
                t += rng.uniform(*INNER_PAUSE_S)
            elif k:
                t += rng.uniform(0.1, BLOCK_GAP_MAX_S)
            for w in ln["words"]:
                ws, we = t + float(w["start"]), t + float(w["end"])
                n = max(len(w["text"]), 1)
                char_times.extend(ws + (we - ws) * c / n for c in range(len(w["text"])))
                if rng.random() < ASR_DROP_SHARE:
                    continue
                tok_text = segment.reading(w["text"]) if rng.random() < ASR_RESPELL_SHARE else w["text"]
                jitter = rng.gauss(0.0, ASR_JITTER_S)
                tokens.append({"text": tok_text, "start": ws + jitter, "end": max(we + jitter, ws + jitter + 0.05)})
            text += ln["ja"]
            t += float(ln["duration"])
        cap_end = t + (rng.uniform(0.0, PAUSE_MAX_S) if rng.random() < PAUSE_SHARE else 0.0)
        blocks.append({"start": round(cap_start, 3), "end": round(cap_end, 3), "text": text})
        clocks.append((cap_start, cap_end, char_times))
        t = cap_end + rng.uniform(0.0, CAPTION_LEAD_MAX_S) + 0.1
    tokens.sort(key=lambda tok: tok["start"])
    return blocks, tokens, clocks


def _child_errors(children: list[dict], blocks: list[dict],
                  clocks: list[tuple[float, float, list[float]]]) -> list[float]:
    """|start error| of every child against the true time of its first
    character. Children are contiguous substrings of their block's text."""
    errors: list[float] = []
    bi, pos = 0, 0
    for ch in children:
        while bi < len(blocks) and ch["start"] >= blocks[bi]["end"] - 1e-6 and bi + 1 < len(blocks) \
                and ch["start"] >= blocks[bi + 1]["start"] - 1e-6:
            bi += 1
            pos = 0
        text = blocks[bi]["text"]
        at = text.find(ch["text"].strip(), pos)
        if at < 0:
            continue
        pos = at + len(ch["text"].strip())
        errors.append(abs(ch["start"] - clocks[bi][2][at]))
    return errors


def _err_stats(errors: list[float]) -> dict:
    if not errors:
        return {"lines": 0, "mean": 0.0, "p90": 0.0, "max": 0.0, "within": 0.0}
    errs = sorted(errors)
    return {"lines": len(errs), "mean": sum(errs) / len(errs),
            "p90": errs[int(0.9 * (len(errs) - 1) + 0.5)], "max": errs[-1],
            "within": sum(1 for e in errs if e <= WITHIN_S) / len(errs)}


def score_transfer(seed: int = 1, island: str | None = None) -> dict:
    """Measure the ASR transfer against islands with exact word times (every
    ready ja island with a timeline and a non-youtube source, or one). Lines
    are laid out as manual caption blocks with a simulated ASR track
    (_simulate); `before` is the caption times plus split_lines at the mora
    rate, `after` is asr_transfer.attach then the same split. Per island and
    in total: mean, p90 and max |line start error| in seconds and the share
    of lines within WITHIN_S."""
    rng = random.Random(seed)
    result: dict = {"islands": [], "total": {}}
    acc = {"before": [], "after": []}
    for isl in _islands(island, None, need_timeline=True):
        lines = [ln for ln in isl["lines"]
                 if "".join(w["text"] for w in ln["words"]) == ln["ja"]]
        if not lines:
            continue
        blocks, tokens, clocks = _simulate(lines, rng)
        rate = segment.mora_rate([(b["text"], b["end"] - b["start"]) for b in blocks])
        before = youtube.split_lines(blocks, rate=rate)
        attached, _ = asr_transfer.attach(blocks, tokens, rate)
        after = asr_transfer.trim_tails(youtube.split_lines(attached, rate=rate))
        per = {"before": _child_errors(before, blocks, clocks),
               "after": _child_errors(after, blocks, clocks)}
        result["islands"].append({"id": isl["id"], "title": isl["title"], "rate": rate,
                                  "before": _err_stats(per["before"]), "after": _err_stats(per["after"])})
        for key in ("before", "after"):
            acc[key].extend(per[key])
    result["total"] = {"before": _err_stats(acc["before"]), "after": _err_stats(acc["after"])}
    return result


def format_score_transfer(result: dict) -> str:
    def cell(s: dict) -> str:
        return f"{s['lines']:>5} {s['mean']:>5.2f} {s['p90']:>5.2f} {s['max']:>6.2f} {s['within']:>5.0%}"

    head = f"{'lines':>5} {'mean':>5} {'p90':>5} {'max':>6} {'<0.5':>5}"
    out = [f"{'island':<14} {'rate':>4}  {head}  -> {head}  title"]
    for r in result["islands"]:
        out.append(f"{r['id']:<14} {r['rate']:>4.1f}  {cell(r['before'])}  -> {cell(r['after'])}  {r['title'][:32]}")
    t = result["total"]
    if t and t["before"]["lines"]:
        out.append(f"{'total':<14} {'':>4}  {cell(t['before'])}  -> {cell(t['after'])}")
    else:
        out.append("no island with exact word times to score")
    return "\n".join(out)
