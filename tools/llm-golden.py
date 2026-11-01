#!/usr/bin/env python3
"""Golden check for the subtitle repair pass on a cheaper model.

Replays the batches of every stored repair result (the `video_repairs` rows
the dev backend produced through the CLI) through llm.complete on the API
backend under the tag `repair-golden` (Haiku by ROUTES; `--tier sonnet` to
compare both tiers), and writes .claude/runs/llm-golden-<date>.md: per
batch what the CLI changed, what the new model changed, where they agree,
every differing line as `n | before | cli | new`, totals, and tokens and
USD read back from the new `llm_calls` rows. Its calls count toward the
monthly cap on purpose.

Refuses to run unless SHADOW_LLM=api is set and an API key resolves. Reads
the islands.db the dev backend uses (SHADOW_DATA_DIR, else backend/data).

    SHADOW_LLM=api backend/.venv/bin/python tools/llm-golden.py --batches 20
"""

import argparse
import datetime as dt
import json
import os
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
BACKEND = ROOT / "backend"
sys.path.insert(0, str(BACKEND))

from dotenv import load_dotenv  # noqa: E402  (needs BACKEND's venv on sys.path first)

load_dotenv(BACKEND / ".env")


def collect_batches(store, repair) -> list[dict]:
    """Every BATCH-sized range of every repaired video, with the prompt the
    pass sent and the lines the CLI's result changed (post-gate)."""
    with store.connect() as conn:
        rows = conn.execute(
            "SELECT video_id, context, result FROM video_repairs WHERE result != ''"
        ).fetchall()
    out: list[dict] = []
    for row in rows:
        try:
            result = json.loads(row["result"])
            context = json.loads(row["context"] or "{}")
        except ValueError:
            continue
        entries = (result or {}).get("lines") or []
        if not entries:
            continue
        texts = [e["before"] for e in entries]
        terms = repair.glossary(context)
        title = context.get("title") or ""
        for start in range(0, len(texts), repair.BATCH):
            end = min(start + repair.BATCH, len(texts))
            cli = {e["idx"]: e["text"] for e in entries[start:end] if e.get("changed")}
            out.append({
                "video_id": row["video_id"], "start": start, "end": end, "texts": texts,
                "glossary": set(terms), "cli": cli,
                "prompt": repair._batch_prompt(texts, start, end, title, terms),
            })
    return out


def model_changes(reply, batch: dict, repair) -> dict[int, str]:
    """The new model's accepted changes for one batch, judged by the same
    gate the pass uses, keyed by line index."""
    changed: dict[int, str] = {}
    for item in reply or []:
        if not isinstance(item, dict):
            continue
        n = item.get("n")
        if isinstance(n, bool) or not isinstance(n, int) or not batch["start"] < n <= batch["end"]:
            continue
        text = (item.get("text") or "").strip() if isinstance(item.get("text"), str) else ""
        before = batch["texts"][n - 1]
        if text and text != before and repair.gate(before, text, batch["glossary"])[0]:
            changed[n - 1] = text
    return changed


def cell(text: str) -> str:
    return (text or "").replace("|", "\\|").replace("\n", " ")


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--batches", type=int, default=20, help="batches to replay (default 20)")
    ap.add_argument("--tier", default="",
                    help="route repair-golden to this tier or model id (default: ROUTES, haiku)")
    args = ap.parse_args()

    if os.getenv("SHADOW_LLM") != "api":
        print("refusing: set SHADOW_LLM=api (this check bills the API on purpose)", file=sys.stderr)
        return 2
    if args.tier:
        os.environ["SHADOW_LLM_ROUTE_REPAIR_GOLDEN"] = args.tier

    import llm
    import repair
    import store

    if not llm._api_key():
        print("refusing: no API key resolves (ANTHROPIC_API_KEY, CLAUDE_API_KEY or SHADOW_LLM_KEY_FILE)",
              file=sys.stderr)
        return 2

    store.init()
    batches = collect_batches(store, repair)
    if not batches:
        print(f"no video_repairs rows with a result in {store.DATA_DIR}", file=sys.stderr)
        return 1
    # Batches where the CLI changed something first: they are the ones that
    # tell the models apart.
    batches.sort(key=lambda b: -len(b["cli"]))
    batches = batches[: max(args.batches, 0)]
    label = args.tier or "haiku"
    model = llm.model_for("repair-golden")
    with store.connect() as conn:
        last_id = conn.execute("SELECT COALESCE(MAX(id), 0) FROM llm_calls").fetchone()[0]

    totals = {"cli_changed": 0, f"{label}_changed": 0, "same": 0, "cli_only": 0,
              f"{label}_only": 0, "failed": 0}
    table = [f"| batch | cli_changed | {label}_changed | same | cli_only | {label}_only |",
             "|---|---|---|---|---|---|"]
    diffs: list[str] = []
    for b in batches:
        name = f"{b['video_id']} {b['start'] + 1}-{b['end']}"
        print(f"{name}: {len(b['cli'])} CLI changes, asking {model}...", flush=True)
        reply = llm.complete(b["prompt"], repair.SCHEMA, tag="repair-golden", timeout=90,
                             ref=b["video_id"])
        if reply is None:
            totals["failed"] += 1
            table.append(f"| {name} | {len(b['cli'])} | failed | | | |")
            continue
        new = model_changes(reply, b, repair)
        cli = b["cli"]
        same = sum(1 for i in cli if new.get(i) == cli[i])
        cli_only = sum(1 for i in cli if i not in new)
        new_only = sum(1 for i in new if i not in cli)
        totals["cli_changed"] += len(cli)
        totals[f"{label}_changed"] += len(new)
        totals["same"] += same
        totals["cli_only"] += cli_only
        totals[f"{label}_only"] += new_only
        table.append(f"| {name} | {len(cli)} | {len(new)} | {same} | {cli_only} | {new_only} |")
        rows = []
        for i in sorted(set(cli) | set(new)):
            if cli.get(i) == new.get(i):
                continue
            rows.append(f"| {i + 1} | {cell(b['texts'][i])} | {cell(cli.get(i, ''))} | {cell(new.get(i, ''))} |")
        if rows:
            diffs.append(f"### {name}\n\n| n | before | cli | {label} |\n|---|---|---|---|\n" + "\n".join(rows))

    with store.connect() as conn:
        calls, tin, tout, usd = conn.execute(
            "SELECT COUNT(*), COALESCE(SUM(input_tokens), 0), COALESCE(SUM(output_tokens), 0),"
            " COALESCE(SUM(usd), 0) FROM llm_calls WHERE tag='repair-golden' AND id > ?",
            (last_id,),
        ).fetchone()

    today = dt.date.today().isoformat()
    videos = len({b["video_id"] for b in batches})
    report = "\n".join([
        f"# llm-golden {today}",
        "",
        f"Model `{model}` (tag repair-golden) against the CLI's stored results."
        f" Batches: {len(batches)}, videos: {videos}, gate and glossary as in the pass.",
        "",
        *table,
        "",
        "## Totals",
        "",
        *[f"- {k}: {v}" for k, v in totals.items()],
        f"- API calls: {calls}, tokens {tin} in / {tout} out, ${usd:.4f}",
        "",
        "## Differences",
        "",
        "\n\n".join(diffs) or "None: every accepted change matched.",
        "",
    ])
    out_dir = ROOT / ".claude" / "runs"
    out_dir.mkdir(parents=True, exist_ok=True)
    out = out_dir / f"llm-golden-{today}.md"
    out.write_text(report)
    print(f"\nwrote {out}")
    print("  " + ", ".join(f"{k} {v}" for k, v in totals.items()) + f", ${usd:.4f}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
