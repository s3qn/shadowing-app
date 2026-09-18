#!/usr/bin/env bash
# deploy-prod.sh [ref]
#
# Build and restart the production backend from a worktree of this repo under
# SHADOW_PROD_HOME (default /home/sean/shadow-prod), detached at the given ref
# (default main). Deploy source is local main, not origin/main: accept-push.sh
# merges to local main and pushes it, so local main is what was accepted, and
# deploy needs no network.
#
# Each requirements set gets its own venv under SHADOW_PROD_HOME/venvs, and
# app/backend/.venv is a symlink to the one in use. A failed pip install never
# touches the venv the running backend uses.
#
# Any failure after the checkout moves the checkout and the venv link back. A
# failure after the restart also restarts the previous release.
set -Eeuo pipefail

DEFAULT_HOME=/home/sean/shadow-prod
SHADOW_PROD_HOME="${SHADOW_PROD_HOME:-$DEFAULT_HOME}"
SHADOW_PROD_SESSION="${SHADOW_PROD_SESSION:-shadow-prod}"
REF="${1:-main}"

# Rollback state. Global so the ERR trap can read it.
APP=""
LOGS=""
PORT=""
MODE=""
PREV=""
PREV_VENV=""
NEW_VENV=""

die() {
  echo "deploy-prod.sh: $*" >&2
  exit 1
}

# Print "<port> <token set: 0|1>" from the env file in a subshell, so no prod
# value is ever exported into this shell or a tmux server started from it.
read_env() {
  (
    for v in $(compgen -e); do
      case "$v" in
        SHADOW_PROD_HOME|SHADOW_PROD_SESSION) ;;
        SHADOW_*|VOICEVOX_*|WHISPER_*) unset "$v" ;;
      esac
    done
    # shellcheck disable=SC1090
    . "$1"
    echo "${SHADOW_PORT:-8030} $([ -n "${SHADOW_TOKEN:-}" ] && echo 1 || echo 0)"
  )
}

build_venv() {
  local hash
  hash="$(cat "$APP/backend/requirements.txt" "$APP/backend/requirements-dev.txt" | sha256sum | cut -c1-16)"
  NEW_VENV="$SHADOW_PROD_HOME/venvs/$hash"
  if [ ! -f "$NEW_VENV/.complete" ]; then
    rm -rf "$NEW_VENV"
    mkdir -p "$SHADOW_PROD_HOME/venvs"
    python3 -m venv "$NEW_VENV"
    "$NEW_VENV/bin/pip" install -q -r "$APP/backend/requirements.txt" -r "$APP/backend/requirements-dev.txt"
    touch "$NEW_VENV/.complete"
  fi
}

start_backend() {
  if [ "$MODE" = "systemd" ]; then
    systemctl --user restart shadow-prod
    return
  fi
  local cmd _
  fuser -k "$PORT/tcp" >/dev/null 2>&1 || true
  tmux kill-session -t "=$SHADOW_PROD_SESSION" >/dev/null 2>&1 || true
  for _ in $(seq 1 10); do
    fuser "$PORT/tcp" >/dev/null 2>&1 || break
    sleep 1
  done
  cmd="./run-prod.sh 2>&1 | tee -a $(printf '%q' "$LOGS/backend.log"); echo '[backend exited]'; exec bash"
  # SHADOW_PROD_HOME goes to this session only (-e), never into the global
  # environment of a tmux server this command might start.
  env -u SHADOW_PROD_HOME -u SHADOW_PROD_SESSION \
    tmux new-session -d -s "$SHADOW_PROD_SESSION" -c "$APP/backend" \
    -e "SHADOW_PROD_HOME=$SHADOW_PROD_HOME" "$cmd"
}

# Wait up to 60 s for /health to report the given short sha.
wait_healthy() {
  local want="$1" release _
  for _ in $(seq 1 60); do
    release="$(curl -s -m 2 "http://127.0.0.1:$PORT/health" \
      | python3 -c 'import json,sys; print(json.load(sys.stdin).get("release",""))' 2>/dev/null)" || release=""
    if [ "$release" = "$want" ]; then
      return 0
    fi
    sleep 1
  done
  return 1
}

# rollback keep|restart: put the checkout and venv link back to PREV. With
# "restart", also restart the previous release and wait for it.
rollback() {
  local what="$1" sha
  trap - ERR
  set +e
  if [ -z "$PREV" ]; then
    echo "deploy-prod.sh: first deploy, nothing to roll back to. $APP stays at $REF." >&2
    return
  fi
  git -C "$APP" checkout -q --detach "$PREV"
  if [ -n "$PREV_VENV" ]; then
    ln -sfn "$PREV_VENV" "$APP/backend/.venv"
  fi
  sha="$(git -C "$APP" rev-parse --short HEAD)"
  echo "deploy-prod.sh: rolled the checkout back to $sha." >&2
  if [ "$what" = "restart" ]; then
    start_backend
    if wait_healthy "$sha"; then
      echo "deploy-prod.sh: previous release $sha is healthy on :$PORT ($MODE)." >&2
    else
      echo "deploy-prod.sh: previous release $sha did not come up on :$PORT either. Check $LOGS/backend.log or journalctl." >&2
    fi
  fi
}

main() {
  local repo env_file settings token_set sha keep venv
  repo="$(git -C "$(dirname "$0")" rev-parse --show-toplevel)"
  APP="$SHADOW_PROD_HOME/app"
  LOGS="$SHADOW_PROD_HOME/logs"
  env_file="$SHADOW_PROD_HOME/env"

  if [ "$SHADOW_PROD_SESSION" = "shadow-backend" ]; then
    die "shadow-backend is the dev session, refusing."
  fi

  if [ ! -f "$env_file" ]; then
    echo "deploy-prod.sh: no env file at $env_file. Run:" >&2
    echo "  mkdir -p \"$SHADOW_PROD_HOME\" && cp \"$repo/backend/prod.env.example\" \"$env_file\" && chmod 600 \"$env_file\"" >&2
    echo "then fill in SHADOW_TOKEN before deploying." >&2
    exit 1
  fi
  if [ "$(stat -c %a "$env_file")" != "600" ]; then
    die "$env_file must be mode 600. Run: chmod 600 \"$env_file\""
  fi

  settings="$(read_env "$env_file")"
  PORT="${settings% *}"
  token_set="${settings#* }"
  case "$PORT" in
    ''|*[!0-9]*) die "SHADOW_PORT in $env_file is not a number: $PORT" ;;
    8020) die "SHADOW_PORT=8020 is the dev backend, refusing." ;;
  esac
  if [ "$token_set" != "1" ]; then
    die "SHADOW_TOKEN is empty in $env_file. Fill it in before deploying."
  fi

  git -C "$repo" rev-parse --verify -q "$REF^{commit}" >/dev/null || die "unknown ref: $REF"

  mkdir -p "$SHADOW_PROD_HOME/data" "$LOGS"

  MODE="tmux"
  if [ "$SHADOW_PROD_HOME" = "$DEFAULT_HOME" ] && systemctl --user is-active --quiet shadow-prod 2>/dev/null; then
    MODE="systemd"
  fi

  if [ -d "$APP" ]; then
    if [ -n "$(git -C "$APP" status --porcelain)" ]; then
      die "$APP has uncommitted changes, refusing to deploy."
    fi
    if [ -e "$APP/backend/.venv" ] && [ ! -L "$APP/backend/.venv" ]; then
      die "$APP/backend/.venv is a directory, expected a symlink into $SHADOW_PROD_HOME/venvs. Stop the backend, remove it, and deploy again."
    fi
    PREV="$(git -C "$APP" rev-parse HEAD)"
    PREV_VENV="$(readlink "$APP/backend/.venv" || true)"
    git -C "$APP" checkout -q --detach "$REF"
  else
    git -C "$repo" worktree add -q --detach "$APP" "$REF"
  fi

  # From here on, a failure puts the checkout and venv link back. The running
  # backend is untouched until the tests pass.
  trap 'rollback keep; exit 1' ERR

  build_venv
  ln -sfn "$NEW_VENV" "$APP/backend/.venv"

  if ! "$APP/backend/run-tests.sh" -q; then
    echo "deploy-prod.sh: tests failed, not restarting the running backend." >&2
    rollback keep
    exit 1
  fi

  sha="$(git -C "$APP" rev-parse --short HEAD)"

  # The restart stops the running backend, so a failure from here on also
  # restarts the previous release.
  trap 'rollback restart; exit 1' ERR
  start_backend

  if ! wait_healthy "$sha"; then
    echo "deploy-prod.sh: backend did not report release $sha on :$PORT within 60s ($MODE)." >&2
    rollback restart
    exit 1
  fi
  trap - ERR

  # Keep only the venvs of this release and the previous one.
  keep="$(readlink "$APP/backend/.venv")"
  for venv in "$SHADOW_PROD_HOME"/venvs/*; do
    [ -d "$venv" ] || continue
    if [ "$venv" != "$keep" ] && [ "$venv" != "$PREV_VENV" ]; then
      rm -rf "$venv"
    fi
  done

  echo "deploy-prod: $sha healthy on :$PORT ($MODE)"
}

main "$@"
