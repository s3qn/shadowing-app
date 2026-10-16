"""Tatoeba example-sentence corpus: a read-only sqlite + FTS5 file.

Text only (CC BY 2.0 FR, https://tatoeba.org). The file lives next to the
islands DB, is built offline by scripts/build_tatoeba.py and is never in the
repo. A missing file is normal: search() returns [] and the generator works
alone.
"""

import logging
import os
import re
import sqlite3
import time
from difflib import SequenceMatcher
from typing import Iterable, Iterator

import segment
import store

log = logging.getLogger("shadow.corpus")

DB_PATH = store.DATA_DIR / "tatoeba.db"

SCHEMA = """
CREATE TABLE pairs(
    id INTEGER PRIMARY KEY, lang TEXT NOT NULL, text TEXT NOT NULL, en TEXT NOT NULL,
    tatoeba_id INTEGER, en_id INTEGER, username TEXT, en_username TEXT,
    chars INTEGER, tok TEXT NOT NULL
);
CREATE INDEX pairs_lang ON pairs(lang);
CREATE VIRTUAL TABLE pairs_fts USING fts5(
    en, tok, content='pairs', content_rowid='id',
    tokenize='unicode61 remove_diacritics 2'
);
CREATE TABLE meta(key TEXT PRIMARY KEY, value TEXT);
"""

# Level caps applied after the FTS pass: ja in characters, es in words.
_CAPS = {
    "simple": {"ja": 25, "es": 10},
    "complex": {"ja": 45, "es": 16},
}
_LIMITS = {"ja": (4, 60), "es": (2, 16)}  # ja chars, es words
_EN_WORDS = (2, 20)
_MAX_EN_PER_SOURCE = 3
_URL = re.compile(r"https?://|www\.", re.I)
_warned = False


def tokenize_ja(text: str) -> str:
    """Janome surface forms joined by spaces, for word search over Japanese."""
    parts = (t.surface.strip() for t in segment._tokenizer().tokenize(text))
    return " ".join(p for p in parts if p)


def _tok(lang: str, text: str) -> str:
    return tokenize_ja(text) if lang == "ja" else text.lower()


def _words(text: str) -> int:
    return len(text.split())


def _source_ok(lang: str, text: str) -> bool:
    if _URL.search(text):
        return False
    lo, hi = _LIMITS[lang]
    n = len(text) if lang == "ja" else _words(text)
    return lo <= n <= hi


def pairs_from_exports(lang: str, sentences_rows, links_rows, en_rows) -> Iterator[dict]:
    """Join Tatoeba per-language exports into learning/English pairs.

    sentences_rows and en_rows are `id, lang, text, username, ...` rows; links_rows
    are `id, translation_id`. Keeps at most 3 English translations per source
    sentence (lowest ids) and drops URLs and sentences outside the length bounds.
    """
    links: dict[int, list[int]] = {}
    for row in links_rows:
        links.setdefault(int(row[0]), []).append(int(row[1]))
    wanted = {e for ids in links.values() for e in ids}
    en: dict[int, tuple[str, str]] = {}
    for row in en_rows:
        eid = int(row[0])
        text = row[2]
        if eid in wanted and not _URL.search(text) and _EN_WORDS[0] <= _words(text) <= _EN_WORDS[1]:
            en[eid] = (text, row[3] if len(row) > 3 else "")
    for row in sentences_rows:
        sid, text = int(row[0]), row[2]
        if sid not in links or not _source_ok(lang, text):
            continue
        user = row[3] if len(row) > 3 else ""
        for eid in sorted(e for e in links[sid] if e in en)[:_MAX_EN_PER_SOURCE]:
            yield {
                "lang": lang, "text": text, "en": en[eid][0], "tatoeba_id": sid,
                "en_id": eid, "username": user, "en_username": en[eid][1],
            }


def build(path, rows: Iterable[dict]) -> dict:
    """Write schema, rows and FTS to path.tmp, then rename over path."""
    tmp = f"{path}.tmp"
    if os.path.exists(tmp):
        os.remove(tmp)
    db = sqlite3.connect(tmp)
    counts: dict[str, int] = {}
    try:
        db.executescript(SCHEMA)
        for r in rows:
            lang = r["lang"]
            db.execute(
                "INSERT INTO pairs(lang,text,en,tatoeba_id,en_id,username,en_username,chars,tok)"
                " VALUES(?,?,?,?,?,?,?,?,?)",
                (lang, r["text"], r["en"], r.get("tatoeba_id"), r.get("en_id"),
                 r.get("username"), r.get("en_username"), len(r["text"]), _tok(lang, r["text"])),
            )
            counts[lang] = counts.get(lang, 0) + 1
        db.execute("INSERT INTO pairs_fts(rowid,en,tok) SELECT id,en,tok FROM pairs")
        db.execute("INSERT INTO pairs_fts(pairs_fts) VALUES('optimize')")
        meta = {
            "built_at": time.strftime("%Y-%m-%d %H:%M:%S"),
            "source": "https://tatoeba.org",
            "licence": "CC BY 2.0 FR",
            **{f"count_{k}": str(v) for k, v in counts.items()},
        }
        db.executemany("INSERT INTO meta VALUES(?,?)", meta.items())
        db.commit()
        db.execute("VACUUM")
    finally:
        db.close()
    os.replace(tmp, path)
    return counts


# Filler keywords the model sometimes emits; as prefix terms they match everything.
_STOPWORDS = frozenset(
    "the a an of to in on at and or is are it for with de la el los las un una y o en que "
    "の は が を に で と も や か へ".split()
)
_TWIN_RATIO = 0.85


def _is_twin(text: str, kept: list[str]) -> bool:
    """True when `text` is nearly the same sentence as one already kept
    (an inflection or a particle apart, such as 行っている and 行っていた)."""
    return any(SequenceMatcher(None, text, k).ratio() >= _TWIN_RATIO for k in kept)


def _connect():
    if not DB_PATH.exists():
        return None
    return sqlite3.connect(f"file:{DB_PATH}?mode=ro", uri=True)


def _fts_query(language: str, keywords: list[str]) -> str:
    terms: list[str] = []
    for kw in keywords:
        if not isinstance(kw, str):
            continue
        clean = " ".join(re.sub(r"[^\w ]", " ", kw).split())
        if len(clean) < 2 or clean.lower() in _STOPWORDS:
            continue
        if language == "ja" and not clean.isascii():
            clean = tokenize_ja(clean)
        elif clean.isascii() and " " not in clean and len(clean) >= 3:
            terms.append(f'"{clean.lower()}"*')
            continue
        else:
            clean = clean.lower()
        if clean:
            terms.append(f'"{clean}"')
    return " OR ".join(terms)


def search(language: str, keywords: list[str], complexity: str = "simple", limit: int = 40) -> list[dict]:
    """Up to `limit` rows `{id, text, en, username}` matching any keyword."""
    global _warned
    if language not in _LIMITS:
        return []
    db = _connect()
    if db is None:
        if not _warned:
            _warned = True
            log.warning("tatoeba.db missing at %s: topic islands use the generator alone", DB_PATH)
        return []
    query = _fts_query(language, keywords)
    if not query:
        db.close()
        return []
    cap = _CAPS.get(complexity, _CAPS["simple"])[language]
    try:
        cur = db.execute(
            "SELECT p.tatoeba_id, p.text, p.en, p.username FROM pairs_fts f"
            " JOIN pairs p ON p.id = f.rowid"
            " WHERE pairs_fts MATCH ? AND p.lang = ? ORDER BY bm25(pairs_fts) LIMIT 300",
            (query, language),
        )
        found = cur.fetchall()
    except sqlite3.Error:
        log.exception("corpus search failed")
        return []
    finally:
        db.close()
    out, out_text, seen_text, seen_en = [], [], set(), set()
    for sid, text, en, user in found:
        n = len(text) if language == "ja" else _words(text)
        if n > cap or text in seen_text or en in seen_en or _is_twin(text, out_text):
            continue
        seen_text.add(text)
        seen_en.add(en)
        out_text.append(text)
        out.append({"id": sid, "text": text, "en": en, "username": user})
        if len(out) >= limit:
            break
    return out


def status() -> dict | None:
    """The meta table as a dict, or None when the file is missing."""
    db = _connect()
    if db is None:
        return None
    try:
        return dict(db.execute("SELECT key, value FROM meta").fetchall())
    except sqlite3.Error:
        return None
    finally:
        db.close()
