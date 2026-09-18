"""Tests for backend/podcast_catalog.py (the hand-picked catalog and its
search) and the /shadow/podcasts/catalog and /shadow/podcasts/search routes
in main.py.

No network: the iTunes HTTP calls go through a mocked podcast.fetch, the
same way test_podcast.py mocks it for podcast_episodes.
"""

import asyncio
import json
from pathlib import Path

import pytest
from fastapi import HTTPException

import main
import podcast
import podcast_catalog

FIXTURE = Path(__file__).parent / "fixtures" / "feed.xml"

AUTH = f"Bearer {main.SHADOW_TOKEN}"


def _is_hebrew(text: str) -> bool:
    return any("\u0590" <= ch <= "\u05ff" for ch in text)


async def _public_check(url):
    return "93.184.216.34"


def test_catalog_returns_the_ja_sections():
    result = podcast_catalog.catalog("ja")

    assert len(result["sections"]) == 3
    first_show = result["sections"][0]["shows"][0]
    assert first_show["feedUrl"]
    assert first_show["artworkUrl"]
    assert first_show["level"] == "beginner"


def test_catalog_es_and_en_have_three_sections_of_verified_shows():
    for language in ("es", "en"):
        result = podcast_catalog.catalog(language)

        assert len(result["sections"]) == 3
        for section in result["sections"]:
            assert section["shows"], f"{language}/{section['id']} has no shows"
            for show in section["shows"]:
                assert show["collectionId"]
                assert show["feedUrl"]
                assert show["artworkUrl"]
                assert show["level"] in ("beginner", "intermediate", "advanced")
                assert show["tagline"]


def test_catalog_serves_hebrew_copy_when_the_interface_language_is_he():
    """The interface language is not the learning language: someone learning
    Japanese while reading Hebrew gets Hebrew section copy over Japanese
    shows, with the show titles untouched."""
    for language in ("ja", "es", "en"):
        english = podcast_catalog.catalog(language)
        hebrew = podcast_catalog.catalog(language, "he")

        assert len(hebrew["sections"]) == len(english["sections"])
        for he_section, en_section in zip(hebrew["sections"], english["sections"]):
            assert he_section["id"] == en_section["id"]
            assert he_section["title"] != en_section["title"]
            assert he_section["subtitle"] != en_section["subtitle"]
            assert _is_hebrew(he_section["title"])
            assert _is_hebrew(he_section["subtitle"])
            for he_show, en_show in zip(he_section["shows"], en_section["shows"]):
                assert he_show["title"] == en_show["title"]
                assert he_show["feedUrl"] == en_show["feedUrl"]
                assert he_show["tagline"] != en_show["tagline"]
                assert _is_hebrew(he_show["tagline"])


def test_catalog_falls_back_to_english_for_an_interface_language_without_copy():
    assert podcast_catalog.catalog("ja", "fr") == podcast_catalog.catalog("ja")


def test_catalog_hides_the_per_language_copy_from_the_wire_shape():
    for section in podcast_catalog.catalog("ja", "he")["sections"]:
        assert set(section) == {"id", "title", "subtitle", "shows"}
        for show in section["shows"]:
            assert set(show) == {
                "collectionId", "title", "feedUrl", "artworkUrl", "level", "tagline",
            }


def test_catalog_raises_key_error_on_an_unknown_language():
    with pytest.raises(KeyError):
        podcast_catalog.catalog("fr")


def test_search_resolves_an_apple_podcasts_link_via_lookup(monkeypatch):
    lookup_response = {
        "results": [{
            "collectionId": 123456,
            "collectionName": "Test Show",
            "feedUrl": "https://example.com/feed.xml",
            "artworkUrl600": "https://example.com/art.jpg",
        }],
    }

    async def fake_fetch(url, dest, max_bytes):
        assert "lookup?id=123456" in url
        return json.dumps(lookup_response).encode()

    monkeypatch.setattr(podcast, "fetch", fake_fetch)

    results = asyncio.run(podcast_catalog.search(
        "https://podcasts.apple.com/jp/podcast/test-show/id123456", "ja",
    ))

    assert results == [{
        "collectionId": 123456,
        "title": "Test Show",
        "feedUrl": "https://example.com/feed.xml",
        "artworkUrl": "https://example.com/art.jpg",
        "level": None,
        "tagline": None,
    }]


def test_search_resolves_a_raw_feed_url_via_check_url_and_parse_feed(monkeypatch):
    monkeypatch.setattr(podcast, "check_url", _public_check)

    async def fake_fetch(url, dest, max_bytes):
        assert dest is None
        return FIXTURE.read_bytes()

    monkeypatch.setattr(podcast, "fetch", fake_fetch)

    results = asyncio.run(podcast_catalog.search("https://example.com/feed.xml", "ja"))

    assert results == [{
        "collectionId": None,
        "title": "Test Japanese Podcast",
        "feedUrl": "https://example.com/feed.xml",
        "artworkUrl": None,
        "level": None,
        "tagline": None,
    }]


def test_search_a_spotify_link_raises_podcast_error():
    with pytest.raises(podcast.PodcastError, match="Spotify"):
        asyncio.run(podcast_catalog.search(
            "https://open.spotify.com/show/abc123", "ja",
        ))


def test_search_a_plain_query_calls_itunes_search_with_the_right_country(monkeypatch):
    seen_urls = []

    async def fake_fetch(url, dest, max_bytes):
        seen_urls.append(url)
        return json.dumps({"results": []}).encode()

    monkeypatch.setattr(podcast, "fetch", fake_fetch)

    asyncio.run(podcast_catalog.search("easy japanese", "ja"))

    assert len(seen_urls) == 1
    assert "itunes.apple.com/search" in seen_urls[0]
    assert "term=easy%20japanese" in seen_urls[0]
    assert "country=JP" in seen_urls[0]


def test_podcasts_catalog_route_returns_ja_sections():
    result = main.podcasts_catalog(language="ja", authorization=AUTH)

    assert len(result["sections"]) == 3


def test_podcasts_catalog_route_passes_the_interface_language_through():
    result = main.podcasts_catalog(language="ja", ui="he", authorization=AUTH)

    assert result == podcast_catalog.catalog("ja", "he")
    assert result != podcast_catalog.catalog("ja")


def test_podcasts_catalog_route_404s_on_an_unknown_language():
    with pytest.raises(HTTPException) as exc_info:
        main.podcasts_catalog(language="fr", authorization=AUTH)

    assert exc_info.value.status_code == 404


def test_podcasts_search_route_wraps_results(monkeypatch):
    async def fake_search(q, language):
        return [{"collectionId": 1, "title": "T", "feedUrl": "u",
                 "artworkUrl": None, "level": None, "tagline": None}]

    monkeypatch.setattr(main.podcast_catalog, "search", fake_search)

    result = asyncio.run(main.podcasts_search(q="test", language="ja", authorization=AUTH))

    assert result == {"results": [
        {"collectionId": 1, "title": "T", "feedUrl": "u",
         "artworkUrl": None, "level": None, "tagline": None},
    ]}


def test_podcasts_search_route_maps_podcast_error_to_400(monkeypatch):
    async def fake_search(q, language):
        raise podcast.PodcastError("boom")

    monkeypatch.setattr(main.podcast_catalog, "search", fake_search)

    with pytest.raises(HTTPException) as exc_info:
        asyncio.run(main.podcasts_search(q="test", language="ja", authorization=AUTH))

    assert exc_info.value.status_code == 400
