"""Shared test setup.

store.py resolves SHADOW_DATA_DIR when it is imported, so the variable has to
point at a throwaway directory before any test module imports it. conftest runs
before the test modules, which makes this the one safe place to set it. Without
it a test run would read and write the real islands in ~/shadowing-data.
"""

import os
import tempfile
from pathlib import Path

TEST_DATA_DIR = Path(tempfile.mkdtemp(prefix="shadow-tests-"))
os.environ["SHADOW_DATA_DIR"] = str(TEST_DATA_DIR)
# main._startup would otherwise load the Kokoro and whisper models in threads.
os.environ["SHADOW_KOKORO_WARMUP"] = "0"
os.environ["SHADOW_WHISPER_WARM"] = "0"
# Hosted voice adapters read their keys from this file: never Sean's in tests.
os.environ["SHADOW_TTS_KEY_FILE"] = "/nonexistent/shadow-tts-env"
# No worker TTS engine counts as installed: has_voice must not depend on this machine.
os.environ["SHADOW_TTS_MODELS"] = "/nonexistent/shadow-tts-models"
for _key in ("GEMINI_API_KEY", "INWORLD_API_KEY", "ELEVENLABS_API_KEY", "GOOGLE_AI_KEY", "INWORLD_KEY"):
    os.environ.pop(_key, None)

# main.py reads SHADOW_TOKEN at import time and refuses every request without
# one. Pin a test token so the suite passes in a checkout with no backend/.env
# (the prod worktree) and never uses a real token. load_dotenv() does not
# override it.
os.environ["SHADOW_TOKEN"] = "test-token"
# llm.complete runs the CLI backend in tests so a faked subprocess.run can
# answer; the guard below fails any test that reaches the real `claude`.
os.environ["SHADOW_LLM"] = "cli"


import subprocess

import pytest

_REAL_RUN = subprocess.run


def _guarded_run(args, *rest, **kwargs):
    """subprocess.run with the claude CLI blocked. A test that reaches it
    would spend real seconds and real quota, so it fails at once instead."""
    argv = args if isinstance(args, (list, tuple)) else [args]
    if argv and Path(str(argv[0])).name == "claude":
        raise AssertionError("a test tried to run the claude CLI; monkeypatch it")
    return _REAL_RUN(args, *rest, **kwargs)


@pytest.fixture(autouse=True)
def _block_claude_cli(monkeypatch):
    """Every test gets the guard. A test that fakes subprocess.run itself
    replaces the guard for its own duration, which is fine: its fake never
    reaches the CLI either."""
    monkeypatch.setattr(subprocess, "run", _guarded_run)


@pytest.fixture(autouse=True)
def _fresh_tts_cache(monkeypatch, tmp_path):
    """Every test gets an empty shared render cache and the dev switch off."""
    import tts_budget
    import tts_cache

    monkeypatch.setattr(tts_cache, "CACHE_DIR", tmp_path / "tts-cache")
    monkeypatch.setattr(tts_budget, "DEV_FORCE", "")


@pytest.fixture(autouse=True)
def _energy_fits_every_route(monkeypatch):
    """The free day is 5 units (one island) while an import costs 10, so the
    route tests would hit no_energy on the production default. They test the
    routes, not the meter: give them a big day. test_energy.py and
    test_guardrails.py set their own DAILY_UNITS after this fixture."""
    import energy

    monkeypatch.setattr(energy, "DAILY_UNITS", 1000)


@pytest.fixture(autouse=True)
def _device_only_requests(monkeypatch):
    """Sign-in is required by default; most route tests drive the routes with
    a bare device id, so they run with the switch off. tests/test_security.py
    turns it back on for the tests that cover it."""
    import middleware

    monkeypatch.setattr(middleware, "REQUIRE_SIGNIN", False)
