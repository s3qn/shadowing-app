"""JLPT grammar points: a read-only sqlite file of names, levels and connections.

LICENCE: the source Anki decks (Nihongo Kyoshi, Dictionary of Japanese Grammar)
are copyrighted. They are never copied into the repo, and this module reads two
fields per note and nothing else: the pattern name plus the NK connection
formula or the DoJG volume. No example sentence, explanation, usage or
equivalent text is read or stored. Glosses in meaning_short are our own words.

The file lives next to the islands DB, is built offline by
scripts/build_grammar.py and is never in the repo. A missing file is normal:
every reader returns [] or None.
"""

import html
import json
import logging
import os
import re
import sqlite3
import time
from typing import Iterable, Iterator

import store

log = logging.getLogger("shadow.grammar")

DB_PATH = store.DATA_DIR / "grammar.db"
LEVELS = ("N5", "N4", "N3", "N2", "N1")

COLUMNS = ("id", "pattern", "reading", "level", "level_guess", "connection", "meaning_short", "source")

SCHEMA = """
CREATE TABLE points(
    id TEXT PRIMARY KEY,
    pattern TEXT NOT NULL,
    reading TEXT NOT NULL,
    level TEXT NOT NULL,
    level_guess INTEGER NOT NULL,
    connection TEXT NOT NULL,
    meaning_short TEXT NOT NULL,
    source TEXT NOT NULL
);
CREATE TABLE meta(key TEXT PRIMARY KEY, value TEXT);
"""

# The only note fields ever read, by index. Everything else stays in the deck.
NK_FIELDS = {0: "pattern", 2: "connection"}
DOJG_FIELDS = {0: "pattern", 3: "volume"}

_NK_DECK_LEVEL = re.compile(r"^文法::\d+\.\s*(N[1-5])\s*$")
_VOLUME_LEVEL = {"Basic": "N4", "Intermediate": "N3", "Advanced": "N1"}
_ORDER = {lv: i for i, lv in enumerate(LEVELS)} | {"": len(LEVELS)}
_TAGS = re.compile(r"<[^>]*>")
_BREAKS = re.compile(r"<br\s*/?>|</div>|</p>", re.I)
_COUNT = re.compile(r"\s*\(\d+\)\s*$")
_KANA = re.compile(r"^[ぁ-ゟー]+$")
_KATA = re.compile(r"[ァ-ヶ]")
_PAREN_KANA = re.compile(r"[（(]([ぁ-ゟー]+)[）)]\s*$")
_COMPARE_CUT = re.compile(r"\s*/\s*類似.*$")
_DROP = re.compile(r"[～〜~\s　。、．，！？!?.,]")
_ALT = re.compile(r"[・/／]")
_warned = False


def _clean(text: str) -> str:
    return " ".join(html.unescape(_TAGS.sub("", text)).replace("\xa0", " ").split())


def _key(pattern: str) -> str:
    """Merge key: the first alternative, without tildes, spaces or A/B slots."""
    s = _COUNT.sub("", _clean(pattern))
    first = _DROP.sub("", _ALT.split(s)[0])
    if len(first) > 1 and first[0] in "AB":
        first = first[1:]
    if len(first) > 1 and first[-1] in "AB":
        first = first[:-1]
    return first


def _hira(text: str) -> str:
    return _KATA.sub(lambda m: chr(ord(m.group()) - 0x60), text)


def _janome_reading(key: str) -> str:
    if not key:
        return ""
    try:
        import segment

        parts = [t.reading for t in segment._tokenizer().tokenize(key)]
    except Exception:
        return ""
    if any(p in ("", "*") for p in parts):
        return ""
    return _hira("".join(parts))


def _reading(key: str, hint: str = "") -> str:
    return hint or _janome_reading(key)


def nk_rows(conn: sqlite3.Connection) -> Iterator[dict]:
    """`{pattern, connection, level}` per Nihongo Kyoshi note. Level comes from
    the deck name; the 'not on the JLPT' deck gives ''."""
    decks = json.loads(conn.execute("SELECT decks FROM col").fetchone()[0])
    level = {}
    for did, d in decks.items():
        m = _NK_DECK_LEVEL.match(d["name"])
        level[int(did)] = m.group(1) if m else ""
    for flds, did in conn.execute(
        "SELECT n.flds, MIN(c.did) FROM notes n JOIN cards c ON c.nid = n.id GROUP BY n.id ORDER BY n.id"
    ):
        f = flds.split("\x1f")
        raw = {name: f[i] for i, name in NK_FIELDS.items() if i < len(f)}
        yield {
            "pattern": _clean(raw.get("pattern", "")),
            "connection": _connection(raw.get("connection", "")),
            "level": level.get(did, ""),
        }


def dojg_rows(conn: sqlite3.Connection) -> Iterator[dict]:
    """`{pattern, volume}` per DoJG note."""
    for (flds,) in conn.execute("SELECT flds FROM notes ORDER BY id"):
        f = flds.split("\x1f")
        raw = {name: f[i] for i, name in DOJG_FIELDS.items() if i < len(f)}
        yield {"pattern": _clean(raw.get("pattern", "")), "volume": _clean(raw.get("volume", ""))}


def _connection(text: str) -> str:
    s = _clean(_BREAKS.sub(" / ", text))
    s = re.sub(r"(\s*/\s*)+", " / ", s).strip(" /")
    return s[:120]


def _earlier(a: str, b: str) -> str:
    return a if _ORDER[a] <= _ORDER[b] else b


def points_from_decks(nk: Iterable[dict], dojg: Iterable[dict]) -> list[dict]:
    """Merge the two decks into one row per pattern key (pure)."""
    pts: dict[str, dict] = {}
    for r in nk:
        pat = _COMPARE_CUT.sub("", r["pattern"]).strip()
        if not pat or pat.startswith("「") or "誤用" in pat:
            continue
        hint = ""
        m = _PAREN_KANA.search(pat)
        if m:
            hint, pat = m.group(1), pat[: m.start()].strip()
        key = _key(pat)
        if not key:
            continue
        cur = pts.get(key)
        if cur is None:
            pts[key] = {"id": key, "pattern": pat, "hint": hint, "level": r["level"],
                        "level_guess": 0, "connection": r["connection"], "source": "nk"}
        else:
            if _ORDER[r["level"]] < _ORDER[cur["level"]]:
                cur["level"] = r["level"]
            cur["hint"] = cur["hint"] or hint
            cur["connection"] = cur["connection"] or r["connection"]
    for r in dojg:
        pat = _COUNT.sub("", r["pattern"]).strip()
        key = _key(pat)
        if not key:
            continue
        hint = ""
        parts = [p.strip() for p in pat.split("・")]
        if len(parts) == 2 and _KANA.match(parts[1]):
            hint = parts[1]
        level = _VOLUME_LEVEL.get(r["volume"], "N3")
        cur = pts.get(key)
        if cur is None:
            pts[key] = {"id": key, "pattern": pat, "hint": hint, "level": level,
                        "level_guess": 1, "connection": "", "source": "dojg"}
        elif cur["source"] == "dojg":
            cur["level"] = _earlier(cur["level"], level)
            cur["hint"] = cur["hint"] or hint
        else:
            cur["hint"] = cur["hint"] or hint
            cur["source"] = "nk+dojg"
    out = []
    for p in sorted(pts.values(), key=lambda p: (_ORDER[p["level"]], p["id"])):
        hint = p.pop("hint")
        out.append({**p, "reading": _reading(p["id"], hint), "meaning_short": ""})
    return out


def add_meanings(rows: list[dict], batch: int = 40) -> int:
    """Fill meaning_short with our own 3 to 6 word glosses through the claude
    CLI. A failed or wrong-length batch leaves ''. Returns rows filled."""
    import generate

    filled = 0
    for i in range(0, len(rows), batch):
        chunk = rows[i:i + batch]
        numbered = "\n".join(f"{n + 1}. {r['pattern']}" for n, r in enumerate(chunk))
        prompt = (
            "Give 3 to 6 English words for each Japanese grammar pattern below, in your own words. "
            f"Reply with only a JSON array of {len(chunk)} strings, in the same order.\n\n{numbered}"
        )
        out = generate._run_cli(prompt, "grammar_meanings")
        parsed = generate._extract_json(out) if out else None
        if not isinstance(parsed, list) or len(parsed) != len(chunk):
            log.warning("grammar_meanings: bad batch at %d", i)
            continue
        for r, g in zip(chunk, parsed):
            r["meaning_short"] = str(g).strip()
            filled += bool(r["meaning_short"])
    return filled


def build(path, rows: Iterable[dict]) -> dict:
    """Write schema and rows to path.tmp, then rename over path. Returns counts per level."""
    tmp = f"{path}.tmp"
    if os.path.exists(tmp):
        os.remove(tmp)
    db = sqlite3.connect(tmp)
    counts: dict[str, int] = {}
    try:
        db.executescript(SCHEMA)
        for r in sorted(rows, key=lambda r: (_ORDER[r["level"]], r["id"])):
            db.execute(
                f"INSERT INTO points({','.join(COLUMNS)}) VALUES({','.join('?' * len(COLUMNS))})",
                tuple(r[c] for c in COLUMNS),
            )
            counts[r["level"]] = counts.get(r["level"], 0) + 1
        meta = {
            "built_at": time.strftime("%Y-%m-%d %H:%M:%S"),
            "sources": "nk,dojg",
            **{f"count_{k or 'none'}": str(v) for k, v in counts.items()},
        }
        db.executemany("INSERT INTO meta VALUES(?,?)", meta.items())
        db.commit()
        db.execute("VACUUM")
    finally:
        db.close()
    os.replace(tmp, path)
    return counts


def _connect():
    global _warned
    if not DB_PATH.exists():
        if not _warned:
            _warned = True
            log.warning("grammar.db missing at %s: no grammar islands", DB_PATH)
        return None
    db = sqlite3.connect(f"file:{DB_PATH}?mode=ro", uri=True)
    db.row_factory = sqlite3.Row
    return db


def _query(sql: str, args: tuple = ()) -> list[dict]:
    db = _connect()
    if db is None:
        return []
    try:
        return [dict(r) for r in db.execute(sql, args)]
    except sqlite3.Error:
        log.warning("grammar query failed", exc_info=True)
        return []
    finally:
        db.close()


def levels() -> list[dict]:
    rows = _query("SELECT level, COUNT(*) AS count FROM points WHERE level != '' GROUP BY level")
    by = {r["level"]: r["count"] for r in rows}
    return [{"level": lv, "count": by[lv]} for lv in LEVELS if lv in by]


def list_points(level: str) -> list[dict]:
    return _query(f"SELECT {','.join(COLUMNS)} FROM points WHERE level = ? ORDER BY rowid", (level,))


def get(point_id: str) -> dict | None:
    rows = _query(f"SELECT {','.join(COLUMNS)} FROM points WHERE id = ?", (point_id,))
    return rows[0] if rows else None


def search(q: str, limit: int = 20) -> list[dict]:
    key = _key(q)
    if not key:
        return []
    like = "%" + key.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_") + "%"
    return _query(
        f"SELECT {','.join(COLUMNS)} FROM points WHERE id LIKE ? ESCAPE '\\' OR pattern LIKE ? ESCAPE '\\'"
        " OR reading LIKE ? ESCAPE '\\' OR meaning_short LIKE ? ESCAPE '\\' ORDER BY rowid LIMIT ?",
        (like, like, like, like, int(limit)),
    )


def match(text: str) -> dict | None:
    """The point a whole spoken or typed string names (id or reading), else None."""
    key = _key(text or "")
    if not key:
        return None
    rows = _query(
        f"SELECT {','.join(COLUMNS)} FROM points WHERE id = ? OR reading = ? ORDER BY (id = ?) DESC, rowid LIMIT 1",
        (key, key, key),
    )
    return rows[0] if rows else None


def status() -> dict:
    rows = _query("SELECT key, value FROM meta")
    return {"present": DB_PATH.exists(), "meta": {r["key"]: r["value"] for r in rows}}
