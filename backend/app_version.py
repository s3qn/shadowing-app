"""Latest published build per platform, for the client update gate.

The file latest-build.json lives in store.DATA_DIR (outside the repo in prod) and
is written only by tools/set-latest-build.py after a release is accepted. A
missing or broken file fails open: both platforms come back null.
"""
import json

import store

FILE_NAME = "latest-build.json"
PLATFORMS = ("ios", "android")


def _entry(raw) -> dict | None:
    if not isinstance(raw, dict):
        return None
    build, url = raw.get("build"), raw.get("url")
    if isinstance(build, bool) or not isinstance(build, int) or build < 1:
        return None
    if not isinstance(url, str) or not url.strip():
        return None
    return {"build": build, "url": url}


def latest() -> dict:
    try:
        data = json.loads((store.DATA_DIR / FILE_NAME).read_text())
    except (OSError, ValueError):
        data = None
    if not isinstance(data, dict):
        data = {}
    return {p: _entry(data.get(p)) for p in PLATFORMS}
