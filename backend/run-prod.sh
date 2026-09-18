#!/usr/bin/env bash
# Start the shadowing backend in production mode. Binds 127.0.0.1 only: this
# machine has a public IP with no NAT, and the cloudflared tunnel is the
# intended way in. Settings come from SHADOW_PROD_HOME/env, not backend/.env:
# this checkout is a worktree, and gitignored files vanish when worktrees are
# cleaned. Used as the tmux command and as the systemd ExecStart.
set -euo pipefail
cd "$(dirname "$0")"

SHADOW_PROD_HOME="${SHADOW_PROD_HOME:-/home/sean/shadow-prod}"
ENV_FILE="$SHADOW_PROD_HOME/env"

if [ ! -f "$ENV_FILE" ]; then
  echo "run-prod.sh: no env file at $ENV_FILE. Copy backend/prod.env.example there, fill it in, and chmod 600 it." >&2
  exit 1
fi

if [ "$(stat -c %a "$ENV_FILE")" != "600" ]; then
  echo "run-prod.sh: $ENV_FILE must be mode 600. Run: chmod 600 \"$ENV_FILE\"" >&2
  exit 1
fi

# Start from a clean slate: a dev value inherited from tmux or the caller must
# never fill a key the prod env file leaves out.
for v in $(compgen -e); do
  case "$v" in
    SHADOW_PROD_HOME) ;;
    SHADOW_*|VOICEVOX_*|WHISPER_*) unset "$v" ;;
  esac
done

set -a
# shellcheck disable=SC1090
source "$ENV_FILE"
set +a

if [ -z "${SHADOW_TOKEN:-}" ]; then
  echo "run-prod.sh: SHADOW_TOKEN is empty in $ENV_FILE. Fill it in before starting." >&2
  exit 1
fi

if [ "${SHADOW_PORT:-8030}" = "8020" ]; then
  echo "run-prod.sh: SHADOW_PORT=8020 is the dev backend, refusing." >&2
  exit 1
fi

SHADOW_RELEASE="$(git rev-parse --short HEAD)"
export SHADOW_RELEASE

exec .venv/bin/uvicorn main:app --host 127.0.0.1 --port "${SHADOW_PORT:-8030}"
