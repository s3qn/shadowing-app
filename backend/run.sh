#!/usr/bin/env bash
# Start the shadowing backend. Binds 127.0.0.1 only: this machine has a public
# IP with no NAT, and the cloudflared tunnel is the intended way in.
set -euo pipefail
cd "$(dirname "$0")"
exec .venv/bin/uvicorn main:app --host 127.0.0.1 --port "${SHADOW_PORT:-8020}" "$@"
