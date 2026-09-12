#!/usr/bin/env bash
# Run the backend test suite. Needs no VOICEVOX, no whisper model, no network,
# and never touches the real island data (see tests/conftest.py).
set -euo pipefail
cd "$(dirname "$0")"
exec .venv/bin/python -m pytest "$@"
