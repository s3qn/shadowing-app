#!/usr/bin/env bash
# accept-push.sh <feature name> <commit-message-file> [--done "<bullet>"] [--drop-next N]
# The whole accept in one call: optionally move a FEATURES.md item to Done in
# the worktree, commit and merge through worktree-accept.sh, push main, restore
# main's node_modules if package.json changed, restart the backend if backend/
# changed, and print one summary line. Exists to keep each accept cheap.
set -euo pipefail
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../../.." && pwd)"
NAME="${1:?usage: accept-push.sh <feature> <message-file> [--done bullet] [--drop-next N]}"
MSG_FILE="${2:?usage: accept-push.sh <feature> <message-file> [--done bullet] [--drop-next N]}"
shift 2
DONE=""; DROP=""
while [ $# -gt 0 ]; do
  case "$1" in
    --done) DONE="$2"; shift 2;;
    --drop-next) DROP="$2"; shift 2;;
    *) echo "accept-push: unknown option $1" >&2; exit 1;;
  esac
done
slugify() { echo "$1" | tr '[:upper:]' '[:lower:]' | sed -E 's/[^a-z0-9]+/-/g; s/^-+|-+$//g'; }
WT="$(cd "$REPO/.." && pwd)/shadowing-app-worktrees/$(slugify "$NAME")"
[ -d "$WT" ] || { echo "accept-push: no worktree at $WT" >&2; exit 1; }

if [ -n "$DONE" ] || [ -n "$DROP" ]; then
  DONE="$DONE" DROP="$DROP" python3 - "$WT/FEATURES.md" <<'PY'
import os, re, sys
path = sys.argv[1]; s = open(path, encoding="utf-8").read()
done, drop = os.environ["DONE"], os.environ["DROP"]
head, nxt, ideas = s.partition("## Next (approved, in order)")[0], "", s.partition("## Ideas (not approved)")[2]
nxt = s[s.index("## Next (approved, in order)"):s.index("## Ideas (not approved)")]
if drop:
    items = re.split(r"\n(?=\d+\. )", nxt.split("\n", 1)[1].strip("\n"))
    items = [i for i in items if i.strip() and not i.startswith("(empty")]
    n = int(drop) - 1
    if 0 <= n < len(items): del items[n]
    body = "\n".join(re.sub(r"^\d+\. ", f"{k+1}. ", it) for k, it in enumerate(items)) or "(empty: pick from Ideas)"
    nxt = "## Next (approved, in order)\n\n" + body + "\n\n"
if done:
    lines = ["- " + done[:76]] if len(done) <= 76 else []
    if not lines:
        words, cur, out = done.split(), "- ", []
        for w in words:
            if len(cur) + len(w) + 1 > 78: out.append(cur.rstrip()); cur = "  " + w + " "
            else: cur += w + " "
        out.append(cur.rstrip()); lines = out
    head = head.rstrip("\n") + "\n" + "\n".join(lines) + "\n\n"
open(path, "w", encoding="utf-8").write(head + nxt + "## Ideas (not approved)" + ideas)
print("FEATURES.md updated")
PY
fi

BEFORE="$(git -C "$REPO" rev-parse HEAD)"
bash "$REPO/.claude/skills/feature-dev/scripts/worktree-accept.sh" "$NAME" "$(cat "$MSG_FILE")" 2>&1 | grep -E "merged|cleaned|error|no changes|no worktree" || true
AFTER="$(git -C "$REPO" rev-parse HEAD)"
git -C "$REPO" push origin main 2>&1 | tail -1
CHANGED="$(git -C "$REPO" diff --name-only "$BEFORE" "$AFTER")"
if echo "$CHANGED" | grep -qx "package.json"; then (cd "$REPO" && npm install >/dev/null 2>&1) && echo "npm install: done"; fi
if echo "$CHANGED" | grep -q "^backend/"; then
  fuser -k 8020/tcp >/dev/null 2>&1 || true; sleep 1
  (cd "$REPO/backend" && nohup ./run.sh > /tmp/shadow-backend.log 2>&1 &)
  for i in $(seq 1 15); do curl -s -m 2 http://127.0.0.1:8020/health >/dev/null && { echo "backend restarted"; break; }; sleep 1; done
fi
echo "accepted $(git -C "$REPO" log --oneline -1) | tunnels: $(node "$REPO/.claude/skills/serve-tunnel/scripts/count-active.js")"
