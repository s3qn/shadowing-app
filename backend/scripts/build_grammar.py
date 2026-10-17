"""Build grammar.db, the JLPT grammar point list behind grammar islands.

Operator step. LICENCE: the two Anki decks are copyrighted. This script reads
two fields per note and nothing else (pattern, plus NK connection or DoJG
volume), never copies a deck into the repo and stores no example or
explanation text.

    backend/.venv/bin/python backend/scripts/build_grammar.py --nk X.apkg --dojg Y.apkg [--out PATH] [--meanings]

--meanings asks the claude CLI for our own short English gloss per point (many
CLI calls, off by default).
"""
import argparse
import os
import shutil
import sqlite3
import sys
import tempfile
import zipfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
import grammar  # noqa: E402


def open_deck(apkg: str, tmp: str) -> sqlite3.Connection:
    """Unzip an .apkg into tmp and open its collection read-only."""
    with zipfile.ZipFile(apkg) as z:
        names = z.namelist()
        member = "collection.anki21" if "collection.anki21" in names else "collection.anki2"
        z.extract(member, tmp)
    return sqlite3.connect(f"file:{Path(tmp) / member}?mode=ro", uri=True)


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--nk", required=True)
    ap.add_argument("--dojg", required=True)
    ap.add_argument("--out", default=str(grammar.DB_PATH))
    ap.add_argument("--meanings", action="store_true")
    a = ap.parse_args()
    tmp = tempfile.mkdtemp(prefix="grammar-decks-")
    try:
        nk_db = open_deck(a.nk, os.path.join(tmp, "nk"))
        dojg_db = open_deck(a.dojg, os.path.join(tmp, "dojg"))
        rows = grammar.points_from_decks(list(grammar.nk_rows(nk_db)), list(grammar.dojg_rows(dojg_db)))
        nk_db.close()
        dojg_db.close()
    finally:
        shutil.rmtree(tmp, ignore_errors=True)
    if a.meanings:
        print("glossed:", grammar.add_meanings(rows))
    Path(a.out).parent.mkdir(parents=True, exist_ok=True)
    counts = grammar.build(a.out, rows)
    print("counts:", {k or "none": v for k, v in counts.items()})
    print("level_guess:", sum(r["level_guess"] for r in rows))
    print(f"size: {os.path.getsize(a.out) / 1e3:.1f} KB at {a.out}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
