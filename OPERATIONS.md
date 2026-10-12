# Operations: bringing the services back after a reboot

Every TestFlight phone talks to this machine. If it reboots and nothing comes
back, the app is dead for all of them at once. This page covers the systemd
user units that fix that. Deploys are a separate story, in
[backend/PROD.md](backend/PROD.md).

## The chain

Four services, bottom to top. The unit files live in `backend/systemd/` and are
symlinked into `~/.config/systemd/user/`, so they stay version controlled.

| Unit | What it runs | Port | Depends on |
| --- | --- | --- | --- |
| `shadow-voicevox` | `~/voicevox/run` | 127.0.0.1:50021 | nothing |
| `shadow-prod` | `~/shadow-prod/app/backend/run-prod.sh` | 127.0.0.1:8030 | VOICEVOX (`Wants`, soft) |
| `shadow-dashboard` | `~/www/dev-sean-build/server.js` | 127.0.0.1:4599 | nothing |
| `shadow-cloudflared` | `cloudflared tunnel run dev-dashboard` | outbound only | prod backend, dashboard (`Wants`) |

A fifth unit, `shadow-dev`, runs the development backend on 127.0.0.1:8020. It
is installed but **not enabled**, because `serve-wave.sh`, `restore-main.sh`
and `accept-push.sh` own that port through tmux and `fuser -k 8020/tcp`, and a
supervised unit races them for it. Read the header of
`backend/systemd/shadow-dev.service` before you enable it with `--with-dev`.

Two things every unit honours, and any change to them must keep honouring:

- **Nothing binds wider than 127.0.0.1.** This machine has a public IP and no
  NAT, and the cloudflared tunnel is the only intended way in. `shadow-health.sh`
  checks this on every run.
- **Dev and prod never share a port or a data directory.** The dev backend is
  :8020 with `SHADOW_DATA_DIR=~/shadowing-data`, from `backend/.env`. The prod
  backend is :8030 with `SHADOW_DATA_DIR=~/shadow-prod/data`, from
  `~/shadow-prod/env`, which `run-prod.sh` loads after clearing every inherited
  `SHADOW_*` variable.

## Install

Once, as sean, never with sudo.

```bash
# 1. The dashboard fails closed without a password hash. Generate one:
cd ~/www/dev-sean-build && node server.js --hash 'the-dashboard-password'
#    Paste the printed DASH_PASSWORD_HASH=... line into the file the next
#    step creates: ~/.config/shadow-autostart/dashboard.env

# 2. Link, reload, enable and report. Safe to run again any time.
backend/systemd/install-units.sh

# 3. Turn on lingering. WITHOUT THIS NOTHING STARTS AT BOOT.
loginctl enable-linger sean

# 4. Start everything now, rather than waiting for the next reboot.
systemctl --user start shadow-voicevox shadow-prod shadow-dashboard shadow-cloudflared
```

### Why step 3 matters

These are **user** units, not system units. By default a user's systemd manager
starts when that user logs in and is torn down with their last session, so user
units start at login and stop at logout. Lingering keeps the manager running
from boot regardless of whether anyone logs in, which is the only reason
`WantedBy=default.target` means "at boot" here. `install-units.sh` deliberately
does not turn it on: it reports the state and prints the command.

Check it any time with:

```bash
loginctl show-user sean --property=Linger
```

`Linger=yes` is what you want.

### Before the first install

`shadow-prod` points at `~/shadow-prod/app/backend/run-prod.sh`, which only
exists after the first deploy. Installing the units earlier is fine, the unit
just sits inactive. Run `backend/deploy-prod.sh` (see
[backend/PROD.md](backend/PROD.md)) and then
`systemctl --user restart shadow-prod`.

`shadow-cloudflared` needs a `shadow.sean.build` ingress rule in
`~/.cloudflared/config.yml` before the production backend has a public route.
That rule is in backend/PROD.md under "cloudflared" and it is not part of this
install. `install-units.sh` warns when it is missing.

## Check it worked

```bash
backend/systemd/shadow-health.sh
```

That is the one command after a reboot. It checks, in order: lingering, every
unit's enabled and active state, VOICEVOX and both backends and the dashboard
on localhost, the public `shadow.sean.build` and `dev.sean.build` URLs, that
the running prod process reports the same release the prod worktree is checked
out at, and that no shadowing app port is listening beyond 127.0.0.1. It exits
0 when everything a tester depends on is healthy and 1 when it is not. The dev
backend and the dashboard are reported but never fail the run.

The real reboot test is a reboot. Nothing short of one proves the units start
without a login.

## Logs

Every unit logs to the journal. No log files to rotate.

```bash
journalctl --user -u shadow-voicevox -f
journalctl --user -u shadow-prod -f
journalctl --user -u shadow-cloudflared -f
journalctl --user -u shadow-dashboard -f
journalctl --user -u shadow-dev -f
```

Useful variations:

```bash
journalctl --user -u shadow-prod -n 100 --no-pager   # last 100 lines, no pager
journalctl --user -u shadow-prod -b                  # this boot only
journalctl --user -u shadow-prod -p err              # errors only
journalctl --user -u 'shadow-*' -f                   # the whole chain interleaved
```

`~/shadow-prod/logs/backend.log` is the tmux path only. Once `shadow-prod` is
active, `deploy-prod.sh` restarts through systemd and that file stops growing.

## Stop one temporarily

`systemctl --user stop` is enough. An explicit stop never triggers `Restart=`,
so the service stays down until you start it again, and it still comes back on
the next reboot.

```bash
systemctl --user stop shadow-voicevox      # down now, back after a reboot
systemctl --user start shadow-voicevox     # back now
```

To keep it down across reboots as well, `disable` it too. Remember to enable it
again, or the next reboot quietly ships without it:

```bash
systemctl --user disable --now shadow-voicevox
systemctl --user enable --now shadow-voicevox
```

To stop the whole chain, go top down so nobody serves 502s on the way:

```bash
systemctl --user stop shadow-cloudflared shadow-prod shadow-dashboard shadow-voicevox
```

## Restart policies, and why

| Unit | Policy | Reason |
| --- | --- | --- |
| `shadow-voicevox` | `always`, no start limit | A synthesis engine with no runtime configuration to get wrong. Any exit is a crash, and retrying is always right. |
| `shadow-prod` | `always`, 20 tries per 5 min | Every tester's phone talks to it, so it retries hard. Its failures are configuration failures that repeat forever (env file not mode 600, empty token, dead venv symlink), so it eventually stops and shows `failed` instead of looping. |
| `shadow-cloudflared` | `always`, no start limit | The only path from a phone to this machine. A tunnel systemd has given up on means every tester is down until someone notices by hand, and the usual causes (DNS not up at boot, a Cloudflare outage) are transient and not ours. |
| `shadow-dashboard` | `on-failure`, 5 tries per 2 min | A development convenience no tester touches. It fails closed on a bad password hash, which retrying does not fix, so it surfaces as `failed` within half a minute. |
| `shadow-dev` | `on-failure`, 3 tries per min | Gives up fast on purpose, so it loses the race for :8020 against `serve-wave.sh` rather than breaking a wave confusingly. |

Ordering is `Wants` plus `After`, never `Requires`. A dead VOICEVOX costs
voicing and nothing else, so it must not take the backend down with it, and
`After` orders the start without waiting for VOICEVOX to finish loading its
models. The backend calls VOICEVOX lazily per request, so a slow VOICEVOX is a
slow first voicing, never a failed boot.

## Editing a unit

The installed files are symlinks into this repo, so edit
`backend/systemd/*.service` in place and then:

```bash
systemctl --user daemon-reload
systemctl --user restart shadow-prod
```

Checking out a branch without `backend/systemd/` leaves the symlinks dangling.
`install-units.sh` puts them back.

## What this does not cover

Cloudflare Access in front of `dev.sean.build` is configured in the Cloudflare
Zero Trust dashboard, not here. See `~/www/dev-sean-build/LOCAL-SETUP.md` step 5.
