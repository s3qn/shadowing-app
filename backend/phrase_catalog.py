"""The ready-made phrase topics a learner can add as an island without
recording anything. The phrases are editorial content checked into git
(`phrase_catalog.json`), loaded once at import time like the podcast catalog.
"""

from __future__ import annotations

import json
from pathlib import Path

_CATALOG: dict = json.loads((Path(__file__).parent / "phrase_catalog.json").read_text())

# A translated field sits next to its English one under this suffix
# ("title" / "titleHe"); an interface language with no copy falls back to English.
_UI_SUFFIX = {"he": "He"}


def _pick(entry: dict, field: str, suffix: str) -> str | None:
    if suffix:
        translated = entry.get(f"{field}{suffix}")
        if translated:
            return translated
    return entry.get(field)


def catalog(language: str, ui: str = "en") -> dict:
    """The topics for `language`, titled in the interface language `ui`.
    `sample` is the topic's first phrase. Raises KeyError on an unknown
    language, which the route maps to a 404."""
    suffix = _UI_SUFFIX.get(ui, "")
    by_topic = _CATALOG["phrases"][language]
    return {
        "topics": [
            {
                "id": topic["id"],
                "title": _pick(topic, "title", suffix),
                "count": len(by_topic[topic["id"]]),
                "sample": by_topic[topic["id"]][0]["text"],
            }
            for topic in _CATALOG["topics"]
            if topic["id"] in by_topic
        ]
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
