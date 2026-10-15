"""The ready-made phrase topics a learner can add as an island without
recording anything. The phrases are editorial content checked into git
(`phrase_data/`: `topics.json`, `categories.json` and one `<lang>/<topic>.json`
per language and topic), loaded once at import time like the podcast catalog.
"""

from __future__ import annotations

import json
import unicodedata
from pathlib import Path

_DATA = Path(__file__).parent / "phrase_data"
_MAX_Q = 60
_MAX_HITS = 50


def _load() -> dict:
    topics = json.loads((_DATA / "topics.json").read_text())
    categories = sorted(json.loads((_DATA / "categories.json").read_text()),
                        key=lambda c: c["order"])
    phrases: dict[str, dict] = {}
    for lang_dir in sorted(p for p in _DATA.iterdir() if p.is_dir()):
        phrases[lang_dir.name] = {
            f.stem: json.loads(f.read_text()) for f in sorted(lang_dir.glob("*.json"))
        }
    return {"topics": topics, "categories": categories, "phrases": phrases}


_CATALOG: dict = _load()

# A translated field sits next to its English one under this suffix
# ("title" / "titleHe"); an interface language with no copy falls back to English.
_UI_SUFFIX = {"he": "He"}


def _pick(entry: dict, field: str, suffix: str) -> str | None:
    if suffix:
        translated = entry.get(f"{field}{suffix}")
        if translated:
            return translated
    return entry.get(field)


def _topic_row(topic: dict, entries: list[dict], suffix: str,
               matched: str | None = None) -> dict:
    """One topic as the client sees it, shared by `catalog` and `search`.
    `added` starts False; `mark_added` sets it per device."""
    row = {
        "id": topic["id"],
        "title": _pick(topic, "title", suffix),
        "titleHe": topic.get("titleHe") or topic.get("title"),
        "category": topic.get("category"),
        "count": len(entries),
        "sample": entries[0]["text"],
        "samples": [e["text"] for e in entries[:3]],
        "added": False,
        "matchedPhrase": matched,
    }
    return row


def mark_added(result: dict, added_ids: set[str]) -> dict:
    """Set `added` on every topic whose id is in `added_ids`."""
    for topic in result["topics"]:
        topic["added"] = topic["id"] in added_ids
    return result


def catalog(language: str, ui: str = "en") -> dict:
    """The topics for `language`, titled in the interface language `ui`.
    `sample` is the topic's first phrase. Raises KeyError on an unknown
    language, which the route maps to a 404."""
    suffix = _UI_SUFFIX.get(ui, "")
    by_topic = _CATALOG["phrases"][language]
    return {
        "topics": [
            _topic_row(topic, by_topic[topic["id"]], suffix)
            for topic in _CATALOG["topics"]
            if topic["id"] in by_topic
        ],
        "categories": _categories(by_topic, suffix),
    }


def _categories(by_topic: dict, suffix: str) -> list[dict]:
    """Every category with the number of topics it holds in this language."""
    return [
        {
            "id": cat["id"],
            "title": _pick(cat, "title", suffix),
            "titleHe": cat.get("titleHe") or cat.get("title"),
            "count": sum(1 for t in _CATALOG["topics"]
                         if t.get("category") == cat["id"] and t["id"] in by_topic),
        }
        for cat in _CATALOG["categories"]
    ]


def _norm(text: str) -> str:
    return unicodedata.normalize("NFKC", text).casefold()


def search(language: str, ui: str = "en", q: str = "", category: str = "") -> dict:
    """Topics matching `q` (and `category` when given), best match first.
    Score: topic title 4, keyword 3, phrase gloss 2, phrase text 1; ties keep
    catalogue order. `matchedPhrase` is set when the hit came from phrase text.
    Raises KeyError on an unknown language."""
    suffix = _UI_SUFFIX.get(ui, "")
    by_topic = _CATALOG["phrases"][language]
    needle = _norm((q or "").strip()[:_MAX_Q])
    hits = []
    for order, topic in enumerate(_CATALOG["topics"]):
        tid = topic["id"]
        if tid not in by_topic:
            continue
        if category and topic.get("category") != category:
            continue
        entries = by_topic[tid]
        score, matched = 0, None
        if not needle:
            score = 1
        else:
            if any(needle in _norm(topic.get(f, "")) for f in ("title", "titleHe")):
                score = 4
            elif any(needle in _norm(k) for f in ("keywords", "keywordsHe")
                     for k in topic.get(f, [])):
                score = 3
            else:
                for want, field in ((2, "en"), (1, "text")):
                    hit = next((e for e in entries if needle in _norm(e.get(field, ""))), None)
                    if hit:
                        score, matched = want, hit["text"]
                        break
        if score:
            hits.append((-score, order, _topic_row(topic, entries, suffix, matched)))
    hits.sort(key=lambda h: h[:2])
    return {
        "categories": _categories(by_topic, suffix),
        "topics": [h[2] for h in hits[:_MAX_HITS]],
    }


def phrases(language: str, topic_id: str) -> list[dict]:
    """The phrases of one topic. KeyError if the language or topic is unknown."""
    return _CATALOG["phrases"][language][topic_id]


def title(topic_id: str, native: str) -> str:
    """The island title for a topic, in the native language."""
    suffix = _UI_SUFFIX.get(native, "")
    for topic in _CATALOG["topics"]:
        if topic["id"] == topic_id:
            return _pick(topic, "title", suffix) or topic_id
    raise KeyError(topic_id)
