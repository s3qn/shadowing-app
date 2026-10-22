"""Label and score the context-aware ASR repair (youtube-asr-context-repair).

  python scripts/repair_score.py label --island ID [--seed N] [--n 50]
  python scripts/repair_score.py score --island ID [--context ctx.json] [--old]

`label` samples lines of an island, prints each with a youtu.be link at its
time, and writes the skeleton tests/fixtures/repair_ref_<island>.json
([{idx, start, asr, truth: ""}]) for a person (or Claude with a frame) to
fill `truth` in. `score` runs repair.repair_lines on the island's lines
read-only (the model is called; the store is never written) and prints
before/after character error rate on the labelled lines, right, harmful and
missed fixes, wrong lines marked sure, the sure/unsure/unchecked counts, the
model calls, the wall and the wall per video minute. `--old` scores the
deleted corrector instead, from audio/<id>/corrections.json. Run from
backend/. Point SHADOW_DATA_DIR at a copy to be safe.
"""

import argparse
import json
import random
import sys
import time
from pathlib import Path

# backend/ goes first so `import repair` finds the module, not this script.
ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from dotenv import load_dotenv  # noqa: E402

load_dotenv(ROOT / ".env")

import repair  # noqa: E402
import store  # noqa: E402

FIXTURES = ROOT / "tests" / "fixtures"


def _lines(island_id: str) -> list[dict]:
    island = store.get_island(island_id)
    if island is None:
        sys.exit(f"no island {island_id}")
    return island["lines"]


def _video_id(island_id: str) -> str:
    video = store.get_video(island_id) or {}
    return video.get("video_id", "")


def cer(truth: str, text: str) -> float:
    """Character error rate of `text` against `truth` (Levenshtein / len)."""
    if not truth:
        return 0.0 if not text else 1.0
    prev = list(range(len(text) + 1))
    for i, a in enumerate(truth, 1):
        cur = [i]
        for j, b in enumerate(text, 1):
            cur.append(min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a != b)))
        prev = cur
    return prev[-1] / len(truth)


def label(args) -> None:
    lines = _lines(args.island)
    video_id = _video_id(args.island)
    rng = random.Random(args.seed)
    picked = sorted(rng.sample(range(len(lines)), min(args.n, len(lines))))
    rows = []
    for idx in picked:
        line = lines[idx]
        start = float(line.get("offset") or 0.0)
        print(f"{idx:5d} {start:8.1f}s https://youtu.be/{video_id}?t={int(start)}  {line['ja']}")
        rows.append({"idx": idx, "start": round(start, 2), "asr": line["ja"], "truth": ""})
    FIXTURES.mkdir(parents=True, exist_ok=True)
    out = FIXTURES / f"repair_ref_{args.island}.json"
    if out.exists() and not args.force:
        print(f"\n{out} exists, not overwritten (use --force)")
        return
    out.write_text(json.dumps(rows, ensure_ascii=False, indent=1))
    print(f"\nskeleton written: {out} ({len(rows)} lines, fill `truth`)")


def _old_result(island_id: str, texts: list[str]) -> dict:
    """The deleted corrector's accepted candidates, from its audit file, in
    the shape repair_lines returns (no verdicts)."""
    path = store.AUDIO_DIR / island_id / "corrections.json"
    try:
        entries = json.loads(path.read_text()).get("entries", [])
    except (OSError, ValueError):
        sys.exit(f"no corrections.json for {island_id}")
    accepted = {e["idx"]: e["after"] for e in entries if e.get("accepted")}
    lines = [{"idx": i, "before": t, "text": accepted.get(i, t), "changed": i in accepted,
              "sure": None, "candidate": accepted.get(i), "reason": "", "why": "", "batch": None}
             for i, t in enumerate(texts)]
    return {"version": 0, "glossary": [], "lines": lines,
            "stats": {"batches": 0, "failed_batches": 0, "candidates": len(entries),
                      "accepted": len(accepted), "sure": 0, "unsure": 0, "unchecked": len(texts), "wall_s": 0}}


def score(args) -> None:
    lines = _lines(args.island)
    texts = [l["ja"] for l in lines]
    ref_path = FIXTURES / f"repair_ref_{args.island}.json"
    try:
        ref = [r for r in json.loads(ref_path.read_text()) if r.get("truth")]
    except (OSError, ValueError):
        ref = []
    if args.context:
        context = repair.clean_context(json.loads(Path(args.context).read_text()))
    else:
        context = (store.get_repair(_video_id(args.island)) or {}).get("context") or {}
    t0 = time.monotonic()
    if args.old:
        result = _old_result(args.island, texts)
        calls = 0
    else:
        calls = 0

        def counted(prompt, schema, **kw):
            nonlocal calls
            calls += 1
            import llm
            return llm.complete(prompt, schema, **kw)

        result = repair.repair_lines(texts, context, llm_call=counted)
    wall = time.monotonic() - t0
    by_idx = {e["idx"]: e for e in result["lines"]}
    minutes = max(float((store.get_video(args.island) or {}).get("duration") or 0.0), 1.0) / 60.0

    before = after = 0.0
    right = harmful = missed = sure_wrong = 0
    for r in ref:
        e = by_idx.get(r["idx"])
        if e is None:
            continue
        b, a = cer(r["truth"], e["before"]), cer(r["truth"], e["text"])
        before += b
        after += a
        if e["changed"]:
            if a < b:
                right += 1
            elif a > b:
                harmful += 1
        elif b > 0:
            missed += 1
        if e["sure"] == 1 and a > 0:
            sure_wrong += 1
    stats = result["stats"]
    n = max(len(ref), 1)
    print(f"island {args.island}: {len(texts)} lines, {len(ref)} labelled, glossary {len(result['glossary'])} terms")
    print(f"CER before {before / n:.3f} after {after / n:.3f}")
    print(f"fixes: right {right}, harmful {harmful}, missed {missed}; wrong lines marked sure: {sure_wrong}")
    print(f"candidates {stats['candidates']}, accepted {stats['accepted']}, sure {stats['sure']}, "
          f"unsure {stats['unsure']}, unchecked {stats['unchecked']}, failed batches {stats['failed_batches']}")
    print(f"model calls {calls}, wall {wall:.1f}s, {wall / minutes:.1f}s per video minute")
    for e in result["lines"]:
        if e["candidate"] is not None:
            mark = "ACCEPT" if e["changed"] else "reject"
            print(f"  {mark:6s} {e['idx']:5d} {e['reason']:18s} {e['before']} -> {e['candidate']}  ({e['why']})")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = parser.add_subparsers(dest="cmd", required=True)
    p = sub.add_parser("label")
    p.add_argument("--island", required=True)
    p.add_argument("--seed", type=int, default=1)
    p.add_argument("--n", type=int, default=50)
    p.add_argument("--force", action="store_true")
    p.set_defaults(fn=label)
    p = sub.add_parser("score")
    p.add_argument("--island", required=True)
    p.add_argument("--context")
    p.add_argument("--old", action="store_true")
    p.set_defaults(fn=score)
    args = parser.parse_args()
    args.fn(args)


if __name__ == "__main__":
    main()
