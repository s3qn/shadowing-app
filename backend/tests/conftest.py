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
