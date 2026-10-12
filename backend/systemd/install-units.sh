#!/usr/bin/env bash
# install-units.sh [--with-dev] [--now]
#
# Install the shadowing app's systemd USER units so the machine brings its
# services back by itself after a reboot. Run it once, as sean, never as root.
# Safe to run again: every step is idempotent.
#
# It symlinks the unit files from this repo into ~/.config/systemd/user rather
# than copying them, so the units stay version controlled and an edit here
# needs only a `systemctl --user daemon-reload`.
#
# It does NOT enable lingering. Without lingering these units start when Sean
# logs in and stop when his last session ends, which is not autostart. The
# script says so at the end and prints the one command. See OPERATIONS.md.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$HERE/../.." && pwd)"
UNIT_DIR="$HOME/.config/systemd/user"
CONF_DIR="$HOME/.config/shadow-autostart"

WITH_DEV=0
START_NOW=0
for arg in "$@"; do
  case "$arg" in
    --with-dev) WITH_DEV=1 ;;
    --now) START_NOW=1 ;;
    -h|--help) sed -n '2,12p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "install-units.sh: unknown argument: $arg" >&2; exit 2 ;;
  esac
done

# Units that make up the chain a TestFlight phone depends on, in start order.
CHAIN=(
  shadow-voicevox.service
  shadow-prod.service
  shadow-dashboard.service
  shadow-cloudflared.service
)
# Installed always, enabled only with --with-dev. Read the header of the file.
OPTIONAL=(shadow-dev.service)

warn() { echo "  WARNING: $*" >&2; WARNINGS=$((WARNINGS + 1)); }
WARNINGS=0

if [ "$(id -u)" = "0" ]; then
  echo "install-units.sh: these are user units. Run as sean, without sudo." >&2
  exit 1
fi

if ! systemctl --user show-environment >/dev/null 2>&1; then
  echo "install-units.sh: no systemd user manager for $(id -un). Log in over ssh or a seat, then try again." >&2
  exit 1
fi

# --- 1. preflight -----------------------------------------------------------
# Warnings, not failures. The production backend in particular may not be
# deployed yet, and installing the units before the first deploy is fine: the
# unit sits inactive until backend/deploy-prod.sh creates the worktree.
echo "Checking what the units point at:"

check_exec() {
  if [ -x "$1" ]; then
    echo "  ok       $1"
  else
    warn "missing or not executable: $1 ($2)"
  fi
}

# server.js is read by node, not run directly, so it only has to be readable.
check_file() {
  if [ -r "$1" ]; then
    echo "  ok       $1"
  else
    warn "missing or unreadable: $1 ($2)"
  fi
}

check_exec /home/sean/voicevox/run "VOICEVOX engine"
check_exec /usr/local/bin/cloudflared "cloudflared"
check_exec /usr/bin/node "node for the dashboard"
check_file /home/sean/www/dev-sean-build/server.js "dashboard entry point"
check_exec "$REPO/backend/run.sh" "dev backend"

if [ -x /home/sean/shadow-prod/app/backend/run-prod.sh ]; then
  echo "  ok       /home/sean/shadow-prod/app/backend/run-prod.sh"
else
  warn "no prod deploy at /home/sean/shadow-prod/app. shadow-prod stays inactive until you run backend/deploy-prod.sh (see backend/PROD.md)."
fi

if [ -f /home/sean/shadow-prod/env ]; then
  if [ "$(stat -c %a /home/sean/shadow-prod/env)" = "600" ]; then
    echo "  ok       /home/sean/shadow-prod/env (mode 600)"
  else
    warn "/home/sean/shadow-prod/env is not mode 600, run-prod.sh will refuse to start. Fix: chmod 600 /home/sean/shadow-prod/env"
  fi
else
  warn "no /home/sean/shadow-prod/env. Copy backend/prod.env.example there and chmod 600 it (see backend/PROD.md)."
fi

if [ -f "$REPO/backend/.env" ]; then
  echo "  ok       $REPO/backend/.env"
else
  warn "no $REPO/backend/.env, the dev backend will start with no token and refuse every request."
fi

mkdir -p "$CONF_DIR"
chmod 700 "$CONF_DIR"
if [ -f "$CONF_DIR/dashboard.env" ]; then
  chmod 600 "$CONF_DIR/dashboard.env"
  if grep -qE '^DASH_PASSWORD_HASH=.+' "$CONF_DIR/dashboard.env"; then
    echo "  ok       $CONF_DIR/dashboard.env"
  else
    warn "$CONF_DIR/dashboard.env has no DASH_PASSWORD_HASH. The dashboard fails closed without it."
  fi
else
  cp "$HERE/dashboard.env.example" "$CONF_DIR/dashboard.env"
  chmod 600 "$CONF_DIR/dashboard.env"
  warn "wrote a blank $CONF_DIR/dashboard.env. Fill in DASH_PASSWORD_HASH before starting the dashboard:"
  echo "           cd ~/www/dev-sean-build && node server.js --hash 'your-password'" >&2
fi

if ! grep -q 'hostname: shadow.sean.build' "$HOME/.cloudflared/config.yml" 2>/dev/null; then
  warn "~/.cloudflared/config.yml has no shadow.sean.build rule, so the production backend has no public route. Add it before the TestFlight build goes out (backend/PROD.md, 'cloudflared')."
fi

# --- 2. link ----------------------------------------------------------------
echo
echo "Linking units into $UNIT_DIR:"
mkdir -p "$UNIT_DIR"
for unit in "${CHAIN[@]}" "${OPTIONAL[@]}"; do
  src="$HERE/$unit"
  dest="$UNIT_DIR/$unit"
  [ -f "$src" ] || { echo "install-units.sh: missing unit file $src" >&2; exit 1; }
  if [ -e "$dest" ] && [ ! -L "$dest" ]; then
    warn "$dest is a real file, not a link. Leaving it alone: remove it by hand if you want the repo copy."
    continue
  fi
  ln -sfn "$src" "$dest"
  echo "  $unit -> $src"
done

systemctl --user daemon-reload
echo "  daemon-reload done"

# --- 3. enable --------------------------------------------------------------
echo
echo "Enabling:"
ENABLE=("${CHAIN[@]}")
if [ "$WITH_DEV" = "1" ]; then
  ENABLE+=("${OPTIONAL[@]}")
else
  # Idempotent either way: if a previous run with --with-dev enabled it and
  # this run did not ask for it, leave it as it is rather than surprising
  # anyone by turning it off.
  echo "  shadow-dev.service installed but not enabled (pass --with-dev). Read the top of the file for why."
fi

for unit in "${ENABLE[@]}"; do
  systemctl --user enable "$unit" >/dev/null
  echo "  enabled  $unit"
done

if [ "$START_NOW" = "1" ]; then
  echo
  echo "Starting:"
  for unit in "${ENABLE[@]}"; do
    systemctl --user restart "$unit" || true
    echo "  started  $unit"
  done
fi

# --- 4. report --------------------------------------------------------------
echo
printf '%-28s %-10s %-10s %s\n' UNIT ENABLED ACTIVE SINCE
for unit in "${CHAIN[@]}" "${OPTIONAL[@]}"; do
  enabled="$(systemctl --user is-enabled "$unit" 2>&1 || true)"
  active="$(systemctl --user is-active "$unit" 2>&1 || true)"
  since="$(systemctl --user show "$unit" -p ActiveEnterTimestamp --value 2>/dev/null || true)"
  printf '%-28s %-10s %-10s %s\n' "$unit" "$enabled" "$active" "${since:--}"
done

# --- 5. lingering -----------------------------------------------------------
echo
if [ "$(loginctl show-user "$(id -un)" --property=Linger --value 2>/dev/null || echo no)" = "yes" ]; then
  echo "Lingering is on for $(id -un): these units start at boot."
else
  echo "LINGERING IS OFF. Nothing above starts at boot yet: user units run only"
  echo "while $(id -un) has a session open, and they stop when the last one ends."
  echo "This script does not turn it on. Run this yourself:"
  echo
  echo "    loginctl enable-linger $(id -un)"
  echo
fi

if [ "$WARNINGS" -gt 0 ]; then
  echo "$WARNINGS warning(s) above. The units are installed either way."
fi
echo "Health of the whole chain: backend/systemd/shadow-health.sh"
