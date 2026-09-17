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
systemd:
```
loginctl enable-linger sean
tmux kill-session -t =shadow-prod
fuser -k 8030/tcp
mkdir -p ~/.config/systemd/user
cp backend/systemd/shadow-prod.service ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user enable --now shadow-prod
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

## After a reboot

VOICEVOX and cloudflared are not services, and the tmux session does not
survive a reboot. Start, in order:
1. VOICEVOX: `~/voicevox/run --host 127.0.0.1 --port 50021`
2. Production backend (skip if the systemd unit is enabled):
   `backend/deploy-prod.sh $(git -C ~/shadow-prod/app rev-parse HEAD)`
3. cloudflared: the `nohup` command above.

## Never serve a wave on :8030

`serve-wave.sh` and `restore-main.sh` only touch :8020 and the
`shadow-backend` tmux session. Production is a separate port, checkout, and
data directory, deployed only by `backend/deploy-prod.sh`.
