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
