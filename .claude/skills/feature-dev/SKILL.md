---
name: feature-dev
description: >-
  Build and on-device test one or more features of the shadowing-app, isolated
  per feature. Use whenever the user asks to add/build/prototype app feature(s)
  and try them on a phone, including a single prompt that names SEVERAL
  features. Decomposes the request, gives each feature its own git worktree and
  a Plan+build subagent, serves them ONE AT A TIME over a tunnel with a QR on
  dev.sean.build, then gates each on Accept (merge to local main) / Adjust
  (iterate) / Delete (discard). No slash command. This triggers from natural
  feature requests.
---

# feature-dev

Isolated feature development with on-device QR testing. Each feature lives in
its own worktree and is owned by its own subagent; **you (the main session)
mediate every user gate**. Subagents cannot talk to the user directly.

Scripts live in `scripts/` here; the serve/QR half is the `serve-tunnel` skill.
`REPO` = the shadowing-app checkout root.

## Flow

### 1. Decompose
Split the request into features `[f1..fN]`. Slugify each name (lowercase,
non-alphanumerics → `-`). If it's clearly one feature, N = 1, same flow.

### 2. Plan (one subagent per feature, in parallel)
Spawn one **Plan** subagent per feature (single message, multiple Agent calls).
Each returns a short plan for its feature only. Then **GATE 1**: present all
plans to the user with `AskUserQuestion` (multiSelect): "which to build?".

### 3. Build, then serve ONE at a time
For each approved feature, spawn a **build subagent** (general-purpose) whose
brief is: own this feature end-to-end. It must:

```bash
WT=$(bash "$SKILL_DIR/scripts/worktree-create.sh" "<feature name>")   # captures worktree path
# ...edit files under $WT to build the feature, IN-PLACE and UNCOMMITTED...
bash "$REPO/.claude/skills/serve-tunnel/scripts/serve.sh" "$WT" "<feature name>"

# Then write a test checklist for THIS feature so it shows under the QR on the
# dashboard. Base the items on what you actually built this session: the main
# happy path, each new UI element/field, edge cases and error states, anything
# risky. Short "verify X" phrases; use the feature's own slug.
echo '["verify …","verify …"]' \
  | node "$REPO/.claude/skills/serve-tunnel/scripts/write-checklist.js" --slug "<slug>"
```

Features can be **built** in parallel (worktrees are independent), but only one
can be **served**: `serve.sh` refuses with exit 2 while a tunnel is active,
because the ngrok free tier has one usable domain. So bring a tunnel up, test
it, Accept/Delete to free the slot, then serve the next. Keep each subagent
alive (you'll continue it on Adjust).

On **Adjust**, re-run `write-checklist.js` if the change adds anything new to
test (it replaces the slug's items and resets the boxes).

### 4. Test gate: per feature
When a feature is `ready` (its QR is on `https://dev.sean.build`), ask the user
with `AskUserQuestion`: **Accept / Adjust / Delete**.

- **Accept**: the feature's subagent (or you) runs:
  ```bash
  bash "$SKILL_DIR/scripts/worktree-accept.sh" "<feature name>" "feat: <subject>"
  ```
  Commits in the worktree, fast-forwards **local main** (rebases first if main
  advanced), stops the tunnel, removes the worktree. **Nothing is pushed.** This
  is the only authorized commit point. The freed slot lets a queued feature serve.

- **Adjust**: relay the user's change request to that feature's build subagent
  (continue it via `SendMessage`, don't spawn a new one. It holds the worktree
  context). It edits in place, re-runs `serve.sh` for the same feature (re-QRs),
  then you return to this gate.

- **Delete**: run:
  ```bash
  bash "$SKILL_DIR/scripts/worktree-delete.sh" "<feature name>"
  ```
  Discards the worktree, branch, tunnel, and state entry.

## Rules

- Edits land **in-place, uncommitted**; `worktree-accept.sh` is the sole commit.
- Never `pkill` tunnels globally: teardown is per-slug (`stop-tunnel.js`), so
  anything else running on this machine survives.
- Worktrees live at `../shadowing-app-worktrees/<slug>` (outside the repo).
- Prereq: a ngrok v3 agent authenticated with your own token, and the
  dev.sean.build dashboard running for QRs.

## Verification checklist (per feature)
- [ ] Worktree created; `node_modules` and `.env` resolve (once the app has them).
- [ ] `serve.sh` reported a `ready` URL; QR visible on dev.sean.build.
- [ ] Accept → feature commit is on local main, worktree gone, slot freed.
- [ ] Delete → worktree, branch, and state entry all gone.
