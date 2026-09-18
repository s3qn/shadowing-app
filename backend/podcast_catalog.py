"""The hand-picked podcast catalog and the search that resolves a link or a
plain query to a show. The catalog itself is editorial content checked into
git (`podcast_catalog.json`), not user data, so it is loaded once here at
import time and never reloaded.
"""

from __future__ import annotations

import json
import re
from pathlib import Path
from urllib.parse import quote

import podcast

_CATALOG: dict = json.loads((Path(__file__).parent / "podcast_catalog.json").read_text())

_ITUNES_MAX_BYTES = 2 * 1024 * 1024
_COUNTRY_FOR_LANGUAGE = {"ja": "JP", "en": "US", "es": "ES"}

_APPLE_ID_RE = re.compile(r"podcasts\.apple\.com/.*/id(\d+)")


# The interface language a learner reads the catalog in, which is not the
# language they are learning: someone learning Japanese while reading Hebrew
# gets Hebrew section copy over Japanese shows. Each translated field sits in
# the JSON next to its English one under this suffix ("title" / "titleHe"),
# and an interface language with no copy yet falls back to English.
_UI_SUFFIX = {"he": "He"}


def _pick(entry: dict, field: str, suffix: str) -> str | None:
    if suffix:
        translated = entry.get(f"{field}{suffix}")
        if translated:
            return translated
    return entry.get(field)


def catalog(language: str, ui: str = "en") -> dict:
    """The editorial sections for `language`, written in the interface
    language `ui`. Raises KeyError on an unknown learning language, which the
    route maps to a 404."""
    suffix = _UI_SUFFIX.get(ui, "")
    return {
        "sections": [
            {
                "id": section["id"],
                "title": _pick(section, "title", suffix),
                "subtitle": _pick(section, "subtitle", suffix),
                "shows": [
                    {
                        "collectionId": show["collectionId"],
                        # A show's own title is a proper noun: never translated.
                        "title": show["title"],
                        "feedUrl": show["feedUrl"],
                        "artworkUrl": show["artworkUrl"],
                        "level": show["level"],
                        "tagline": _pick(show, "tagline", suffix),
                    }
                    for show in section["shows"]
                ],
            }
            for section in _CATALOG[language]["sections"]
        ],
    }


def _show_from_lookup(result: dict) -> dict:
    return {
        "collectionId": result.get("collectionId"),
        "title": result.get("collectionName") or result.get("trackName") or "",
        "feedUrl": result.get("feedUrl"),
        "artworkUrl": result.get("artworkUrl600"),
        "level": None,
        "tagline": None,
    }


async def _itunes_get(url: str) -> dict:
    raw = await podcast.fetch(url, None, _ITUNES_MAX_BYTES)
    return json.loads(raw)


async def search(query: str, language: str) -> list[dict]:
    """Resolve `query` to a list of shows in the catalog's wire shape.

    - An `podcasts.apple.com/.../id<digits>` link resolves through the
      iTunes lookup endpoint.
    - An `open.spotify.com` link raises PodcastError: Spotify shows have no
      public feed to import.
    - Any other http(s) URL is treated as a raw feed: `check_url`/`fetch`/
      `parse_feed`, the same path `podcast_episodes` uses, just without
      artwork or a level.
    - Anything else is a plain text query against the iTunes podcast search,
      scoped to the country that matches `language`.
    """
    query = query.strip()
    if not query:
        return []

    if "open.spotify.com" in query:
        raise podcast.PodcastError(
            "Spotify shows can't be imported, only their public RSS feed."
        )

    apple_match = _APPLE_ID_RE.search(query)
    if apple_match:
        collection_id = apple_match.group(1)
        data = await _itunes_get(
            f"https://itunes.apple.com/lookup?id={collection_id}&entity=podcast"
        )
        return [_show_from_lookup(r) for r in data.get("results", [])]

    if query.startswith("http://") or query.startswith("https://"):
        await podcast.check_url(query)
        xml = await podcast.fetch(query, None, podcast.FEED_MAX_BYTES)
        parsed = podcast.parse_feed(xml)
        return [{
            "collectionId": None,
            "title": parsed["title"],
            "feedUrl": query,
            "artworkUrl": None,
            "level": None,
            "tagline": None,
        }]

    country = _COUNTRY_FOR_LANGUAGE.get(language, "US")
    data = await _itunes_get(
        f"https://itunes.apple.com/search?media=podcast&term={quote(query)}&country={country}"
    )
    return [_show_from_lookup(r) for r in data.get("results", [])]
