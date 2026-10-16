"""Build tatoeba.db, the phrase corpus behind voice topic islands.

Operator step. Streams the Tatoeba per-language exports (never loading a whole
file) into the cache, then writes the FTS5 database with corpus.build.

    backend/.venv/bin/python backend/scripts/build_tatoeba.py [--out PATH] [--cache DIR] [--langs jpn,spa]

Sentences are CC BY 2.0 FR, credited to Tatoeba (https://tatoeba.org).
"""
import argparse
import bz2
import csv
import os
import sys
import urllib.request
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
import corpus  # noqa: E402

BASE = "https://downloads.tatoeba.org/exports/per_language"
LANG = {"jpn": "ja", "spa": "es"}


def download(url: str, dest: Path) -> Path:
    if dest.exists():
        return dest
    dest.parent.mkdir(parents=True, exist_ok=True)
    tmp = dest.with_name(dest.name + ".part")
    print(f"downloading {url}", flush=True)
    with urllib.request.urlopen(url, timeout=60) as r, open(tmp, "wb") as f:
        while chunk := r.read(1 << 20):
            f.write(chunk)
    os.replace(tmp, dest)
    return dest


def rows(path: Path):
    with bz2.open(path, "rt", encoding="utf-8", newline="") as f:
        yield from csv.reader(f, delimiter="\t", quoting=csv.QUOTE_NONE)


def all_rows(langs: list[str], cache: Path):
    eng = download(f"{BASE}/eng/eng_sentences_detailed.tsv.bz2", cache / "eng_sentences_detailed.tsv.bz2")
    for code in langs:
        sent = download(f"{BASE}/{code}/{code}_sentences_detailed.tsv.bz2", cache / f"{code}_sentences_detailed.tsv.bz2")
        links = download(f"{BASE}/{code}/{code}-eng_links.tsv.bz2", cache / f"{code}-eng_links.tsv.bz2")
        yield from corpus.pairs_from_exports(LANG[code], rows(sent), rows(links), rows(eng))


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--out", default=str(corpus.DB_PATH))
    ap.add_argument("--cache", default=str(Path.home() / ".cache" / "tatoeba"))
    ap.add_argument("--langs", default="jpn,spa")
    a = ap.parse_args()
    langs = [x for x in a.langs.split(",") if x]
    bad = [x for x in langs if x not in LANG]
    if bad:
        print(f"unsupported language codes: {bad}", file=sys.stderr)
        return 2
    Path(a.out).parent.mkdir(parents=True, exist_ok=True)
    counts = corpus.build(a.out, all_rows(langs, Path(a.cache)))
    print("counts:", counts)
    print(f"size: {os.path.getsize(a.out) / 1e6:.1f} MB at {a.out}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
