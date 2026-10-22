#!/usr/bin/env python3
"""Set the newest published build the backend tells clients about.

  set-latest-build.py [--data-dir D] [--ios N [--ios-url U]] [--android N --url U]

Merges into latest-build.json (the other platform is kept) and writes it
atomically. Data dir: --data-dir, else SHADOW_DATA_DIR, else backend/data.
Run only after Sean accepts a release, never as part of `release`. Rollback is
one more call with the old number.
"""
import argparse
import json
import os
import sys
import tempfile
from pathlib import Path

APP_ID = "6822075334"  # ascAppId in eas.json
IOS_URL = f"itms-beta://beta.itunes.apple.com/v1/app/{APP_ID}"
APK_PREFIX = "https://expo.dev/artifacts/"


def main() -> int:
    p = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    p.add_argument("--data-dir")
    p.add_argument("--ios", type=int)
    p.add_argument("--ios-url", default=IOS_URL)
    p.add_argument("--android", type=int)
    p.add_argument("--url", help="Android APK url (https://expo.dev/artifacts/...)")
    a = p.parse_args()
    if a.ios is None and a.android is None:
        p.error("give --ios N and/or --android N")
    if a.android is not None and not (a.url or "").startswith(APK_PREFIX):
        p.error(f"--android needs --url starting with {APK_PREFIX}")
    for n in (a.ios, a.android):
        if n is not None and n < 1:
            p.error("build numbers start at 1")
    d = Path(a.data_dir or os.getenv("SHADOW_DATA_DIR") or Path(__file__).resolve().parent.parent / "backend" / "data")
    d.mkdir(parents=True, exist_ok=True)
    f = d / "latest-build.json"
    try:
        cur = json.loads(f.read_text())
        if not isinstance(cur, dict):
            cur = {}
    except (OSError, ValueError):
        cur = {}
    out = {"ios": cur.get("ios"), "android": cur.get("android")}
    if a.ios is not None:
        out["ios"] = {"build": a.ios, "url": a.ios_url}
    if a.android is not None:
        out["android"] = {"build": a.android, "url": a.url}
    fd, tmp = tempfile.mkstemp(dir=d, prefix=".latest-build.", suffix=".tmp")
    with os.fdopen(fd, "w") as fh:
        json.dump(out, fh, indent=2)
        fh.write("\n")
    os.replace(tmp, f)
    print(f"{f}: {json.dumps(out)}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
