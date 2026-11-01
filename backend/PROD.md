# Production backend

Runs on 127.0.0.1:8030, separate from the dev backend on :8020 that
`serve-wave.sh` and `restore-main.sh` replace. TestFlight testers reach it at
`https://shadow.sean.build/shadow`, never at `dev.sean.build`.

## Layout

Everything lives under `SHADOW_PROD_HOME` (default `/home/sean/shadow-prod`), outside this repo:
- `env`: settings and the bearer token, mode 600, never committed. Template
  is `backend/prod.env.example`.
- `app`: a git worktree of this repo, detached at whatever ref was last
  deployed. Its `backend/.venv` is a symlink into `venvs`.
- `venvs/<hash>`: one venv per requirements set, separate from the dev venv.
  A deploy builds a new one when the requirements change and keeps the
  current and previous ones.
- `data`: islands db, audio, takes, aec.
- `logs/backend.log`: tmux mode only, appended forever. Rotate it by hand
  (`truncate -s 0 ~/shadow-prod/logs/backend.log`) or with a logrotate
  `copytruncate` rule. Systemd logs go to journalctl.

## First deploy

```
mkdir -p ~/shadow-prod
cp backend/prod.env.example ~/shadow-prod/env
chmod 600 ~/shadow-prod/env
# edit ~/shadow-prod/env, fill in SHADOW_TOKEN:
#   python3 -c "import secrets; print(secrets.token_urlsafe(32))"
backend/deploy-prod.sh
```
Creates the worktree, builds the venv, runs the test suite, and starts the
backend in a tmux session named `shadow-prod`.

## Redeploy

`backend/deploy-prod.sh [ref]` (`ref` defaults to `main`). Refuses to deploy
over uncommitted changes in the prod worktree, an env file that is not mode
600, port 8020 or the `shadow-backend` session. A failed install or test run
puts the checkout back and leaves the running process alone. If the new
release does not report its sha on `/health` within 60 s, the previous
release is checked out and restarted, and the deploy exits 1.

## Health checks

Local: `curl -s http://127.0.0.1:8030/health`. Public:
`curl -s https://shadow.sean.build/shadow/health`. Both report
`"env": "prod"` and the deployed short sha as `"release"`.

## tmux vs systemd

`deploy-prod.sh` starts in tmux (`tmux attach -t shadow-prod` shows logs) and
restarts through tmux until the systemd unit is installed. To move to
systemd, install the whole autostart chain at once (VOICEVOX, this backend,
cloudflared and the dashboard). Full story in
[../OPERATIONS.md](../OPERATIONS.md):
```
tmux kill-session -t =shadow-prod
fuser -k 8030/tcp
backend/systemd/install-units.sh
loginctl enable-linger sean
systemctl --user start shadow-voicevox shadow-prod shadow-dashboard shadow-cloudflared
```
Once `systemctl --user is-active shadow-prod` says active, `deploy-prod.sh`
restarts through systemd instead of tmux. Logs move to
`journalctl --user -u shadow-prod -f`. The unit hardcodes
`/home/sean/shadow-prod`, so a deploy with any other `SHADOW_PROD_HOME`
always uses tmux.

## cloudflared

The public route is a second hostname, `shadow.sean.build`, on the existing
`dev-dashboard` tunnel, not a second tunnel. Once:
```
cloudflared tunnel route dns dev-dashboard shadow.sean.build
cp ~/.cloudflared/config.yml ~/.cloudflared/config.yml.bak
```
In `~/.cloudflared/config.yml`, add this rule under `ingress:`, before the
final `- service: http_status:404` rule:
```
  - hostname: shadow.sean.build
    path: ^/shadow(/.*)?$
    service: http://localhost:8030
```
Check it:
```
cloudflared tunnel ingress validate
cloudflared tunnel ingress rule https://shadow.sean.build/shadow/health
```
Restart cloudflared as two separate commands (dev.sean.build drops for a few
seconds). Never `kill $(pgrep -f ...)`: the pattern matches the calling shell.
```
pkill -x cloudflared
cd ~ && nohup cloudflared tunnel run dev-dashboard > ~/cloudflared.log 2>&1 &
```

## Kill switches and budgets

Defined in `backend/guardrails.py`. Energy is on by default (`SHADOW_ENERGY=0`
turns it off): 60 units per device per UTC day, 3000 globally.

Daily AI-build budgets (UTC day, counted in the `builds` table, owner exempt):
`SHADOW_USER_AI_BUILDS` (default 5, create plus rework per device) and
`SHADOW_GLOBAL_AI_BUILDS` (default 100, all devices). Errors: 429
`daily_budget` / `global_budget`, with `limit` and `refill_at`.

Kill switches live in `<SHADOW_DATA_DIR>/admin.json` (prod:
`~/shadow-prod/data/admin.json`, or the path in `SHADOW_ADMIN_FILE`). The file
is re-read when it changes, no restart. Keys, all on when missing:
```
echo '{"ai_jobs": false}' > ~/shadow-prod/data/admin.json     # pause AI
echo '{"imports": false}' > ~/shadow-prod/data/admin.json     # pause imports
echo '{"signups": false}' > ~/shadow-prod/data/admin.json     # no new users
rm ~/shadow-prod/data/admin.json                               # all back on
```
A file that does not parse keeps the last good values and logs a warning.
A key reads as off for `false`, `0`, `"false"`, `"off"`, `"no"` or `"0"`.
`SHADOW_KILL=signups,ai,imports` in the env is a second way to turn them off.

`ai_jobs` off also stops queued and background AI work (repair jobs, startup
repair resume, caption translation, catch-meaning refills): `llm.complete`
checks it before every call. A call already in flight finishes. The hard
stop is `SHADOW_LLM=off` in `~/shadow-prod/env` plus a restart: no call
leaves the process after that.

| Switch | Blocks | Reply |
|---|---|---|
| `ai_jobs` | every build slot, explain, word, pick, catch meanings, repair, and every queued or background `llm.complete` call | 503 `ai_paused` (background calls answer None) |
| `imports` | file, podcast and YouTube imports | 503 `imports_paused` |
| `signups` | first request of a user the backend has never seen | 403 `signups_paused` |

Confirm: `curl -s -H "Authorization: Bearer $T" -H "X-Shadow-Device: $D"
https://shadow.sean.build/shadow/energy` returns `on`, `daily_max`,
`daily_left`, `granted_left`, `refill_at`, `builds_max`, `builds_left`.
Every block is one warning line in the backend log.

### Every route or job that can call the AI

Order inside a build slot: switch, per-kind cap, AI-build budget, energy,
slot row. Cache hits return before any slot, so they cost nothing.

| Route or job | Charge | Budget / cap | Exempt when |
|---|---|---|---|
| POST /shadow/islands (create from recording or topic, incl. expand_topic and translation) | create 5 | build slot, create cap, AI-build budget | never |
| POST /shadow/phrases/import | phrases 1 | build slot (create) | starter template or shared cache hit |
| POST /shadow/grammar/import | create 5 | build slot (create) | the point already is an island |
| POST /shadow/islands/import (file) | import 10 | build slot, `imports` switch | never |
| POST /shadow/podcasts/import | import 10 | build slot, `imports` switch | never |
| POST /shadow/youtube/captions (import, then translate and repair job) | import 10 | build slot, `imports` switch | never. The repair job it starts is covered by this charge |
| POST /shadow/islands/{id}/regenerate | regenerate 3 | build slot (rework) | never |
| POST /shadow/islands/{id}/revoice | revoice 1 | build slot (rework) | never |
| explain (sentence) | explain 2 | use cap 100, `ai_jobs` | explain cache hit |
| explain word | word 1 | use cap 100, `ai_jobs` | word context cache hit |
| POST /shadow/islands/{id}/ai-picks (podcast line picks) | pick 3 | use cap 20, `ai_jobs` | has cards (409 before the call) |
| GET /shadow/catch/islands/{id}/words (catch meanings) | word 1 per request | cap 200, `ai_jobs` | every meaning cached (shared per video). A refused slot serves cached meanings only |
| GET /shadow/catch/islands/{id}/meaning | word 1 | cap 200, `ai_jobs` | meaning cached. A refused slot returns an empty meaning |
| POST /shadow/islands/{id}/repair (old video) | none | cap 20, `ai_jobs`; the slot row is written only after the repair claim is won | repair done at this version, already queued, or attempts spent |
| repair resume at startup (`_repair_recover`) | none | none | only re-runs jobs already paid for by their import |
| catch verify, ASR retime, align, VOICEVOX, whisper | none | none | local models, no AI call |
| suggestions relay | none | none | posts to Discord, no AI |

The llm-api dollar caps sit inside `llm.complete`, so they always run last.

A build that fails before it makes any line (create, file, podcast and
YouTube import, regenerate, phrases, grammar) gives back its energy and its
build slot, which is also its AI-build budget.

Repair sends at most `SHADOW_REPAIR_MAX_LINES` lines of one import (default
1500) to the model; the rest keep their captions unrepaired, and the job ends
`done` with `repair_error` `capped`.

## After a reboot

With the systemd units installed and lingering on, nothing to do. Check with
`backend/systemd/shadow-health.sh`, see [../OPERATIONS.md](../OPERATIONS.md).

Without them, VOICEVOX and cloudflared are not services and the tmux session
does not survive a reboot. Start, in order:
1. VOICEVOX: `~/voicevox/run --host 127.0.0.1 --port 50021`
2. Production backend:
   `backend/deploy-prod.sh $(git -C ~/shadow-prod/app rev-parse HEAD)`
3. cloudflared: the `nohup` command above.

## LLM API backend

Prod never shells out to the claude CLI: `run-prod.sh` refuses to start unless
the env file carries `SHADOW_LLM=api`. The key comes from `ANTHROPIC_API_KEY=`
(or `CLAUDE_API_KEY=`) in `~/shadow-prod/env`, or from the file named by
`SHADOW_LLM_KEY_FILE` (default `~/.config/kageneko/env`, mode 600). The
backend never logs, prints or stores the key.

Every API call writes one `llm_calls` row (tag, model, tokens, USD, island or
video id). `SHADOW_LLM_MONTHLY_USD` (default 30) stops calls for the rest of
the UTC month once the sum reaches it; the app shows its existing "AI
unavailable" states and cached answers keep working. Warnings at 50% and 90%
of the cap go to the Discord webhook. Raise the cap and restart to reopen.
`SHADOW_LLM_DAILY_USD` (default 5) does the same per UTC day, from the same
rows.

The SDK retries a failed request once (`SHADOW_LLM_RETRIES`, default 1). A
call that times out is booked high, since it may still be billed: prompt
characters / 2 input tokens and the full `max_tokens` output.

The month's bill in one curl (owner device only):

```bash
curl -s -H "Authorization: Bearer $SHADOW_TOKEN" -H "X-Shadow-Device: <owner>" \
  127.0.0.1:8030/shadow/llm/spend
```

Routes per tag live in `backend/llm.py` `ROUTES`; `SHADOW_LLM_ROUTE_<TAG>`
(`haiku`, `sonnet` or a model id) pins one without a deploy. Repair stays on
Sonnet until the golden check in `tools/llm-golden.py` is read.

## Never serve a wave on :8030

`serve-wave.sh` and `restore-main.sh` only touch :8020 and the
`shadow-backend` tmux session. Production is a separate port, checkout, and
data directory, deployed only by `backend/deploy-prod.sh`.
