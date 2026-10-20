#!/usr/bin/env bash
# List tester feedback reports newer than the last read, newest first.
# Usage: tools/feedback.sh [--all] [--dir DIR]
# DIR defaults to $FEEDBACK_DIR, else the dev data dir (backend/data/feedback,
# or $SHADOW_DATA_DIR/feedback).
set -euo pipefail
all=0
dir="${FEEDBACK_DIR:-}"
while [ $# -gt 0 ]; do
  case "$1" in
    --all) all=1 ;;
    --dir) dir="$2"; shift ;;
    *) echo "usage: $0 [--all] [--dir DIR]" >&2; exit 2 ;;
  esac
  shift
done
if [ -z "$dir" ]; then
  here="$(cd "$(dirname "$0")/.." && pwd)"
  dir="${SHADOW_DATA_DIR:-$here/backend/data}/feedback"
fi
python3 -I - "$dir" "$all" <<'PY'
import json, sys
from pathlib import Path

root, show_all = Path(sys.argv[1]), sys.argv[2] == "1"
index = root / "index.jsonl"
marker = root / ".last-read"
if not index.exists():
    print("no reports")
    sys.exit(0)
last = "" if show_all or not marker.exists() else marker.read_text().strip()
rows = []
for line in index.read_text(encoding="utf-8").splitlines():
    try:
        rows.append(json.loads(line))
    except ValueError:
        pass
rows.sort(key=lambda r: r.get("received_at", ""), reverse=True)
new = [r for r in rows if r.get("received_at", "") > last]
for r in new:
    folder = root / r["path"]
    snippet = r.get("text", "")
    tr = folder / "transcript.txt"
    if not snippet and tr.exists():
        snippet = tr.read_text(encoding="utf-8")
    snippet = " ".join(snippet.split())[:80]
    print(" | ".join([r["kind"], r["received_at"], r.get("username") or r["user_id"][:8],
                      r.get("device") or r.get("platform") or "?", snippet, str(folder / "report.md")]))
if not new:
    print("no new reports")
if rows:
    marker.write_text(rows[0].get("received_at", "") + "\n")
PY
