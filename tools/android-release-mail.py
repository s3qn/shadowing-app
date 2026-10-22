#!/usr/bin/env python3
"""Build the "new Android build" email for Echo Tail testers.

Prints a JSON object {to, subject, body} for one EAS Android build. Claude sends it
from Sean's Gmail after he accepts a release; this script never sends mail itself.

  python3 tools/android-release-mail.py --build 22 --apk <expo.dev artifact url> [--notes "line" ...]

Recipients live outside the repo, one address per line (# comments allowed):
  ~/.config/kageneko/android-testers.txt
"""
import argparse
import json
import sys
from pathlib import Path

TESTERS = Path.home() / ".config/kageneko/android-testers.txt"


def recipients() -> list[str]:
    if not TESTERS.exists():
        sys.exit(f"no recipient list at {TESTERS}")
    out = []
    for raw in TESTERS.read_text(encoding="utf-8").splitlines():
        line = raw.split("#", 1)[0].strip()
        if line and "@" in line:
            out.append(line)
    if not out:
        sys.exit(f"{TESTERS} has no addresses")
    return out


def body(build: str, apk: str, notes: list[str]) -> str:
    what = "".join(f"- {n}\n" for n in notes)
    he = (
        f"יש גרסה חדשה של Echo Tail לאנדרואיד (בילד {build}).\n\n"
        f"להורדה: {apk}\n\n"
        "איך מתקינים: פותחים את הקישור בטלפון, מורידים את הקובץ ולוחצים עליו. "
        "הגרסה החדשה נכנסת מעל הישנה, וכל ההתקדמות נשמרת. "
        "אם הטלפון שואל, מאשרים התקנה מהדפדפן.\n"
    )
    if what:
        he += f"\nמה חדש:\n{what}"
    en = (
        f"\nA new Echo Tail build for Android is ready (build {build}).\n"
        f"Download: {apk}\n"
        "Open the link on the phone, download the file and tap it. It installs over the old one and keeps your progress.\n"
    )
    return he + en


def main() -> None:
    p = argparse.ArgumentParser()
    p.add_argument("--build", required=True)
    p.add_argument("--apk", required=True)
    p.add_argument("--notes", action="append", default=[])
    a = p.parse_args()
    if not a.apk.startswith("https://expo.dev/artifacts/"):
        sys.exit("--apk must be an expo.dev artifact url")
    print(json.dumps({
        "to": recipients(),
        "subject": f"Echo Tail לאנדרואיד: בילד {a.build}",
        "body": body(a.build, a.apk, a.notes),
    }, ensure_ascii=False, indent=1))


if __name__ == "__main__":
    main()
