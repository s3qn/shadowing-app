"""Tests for backend/podcast.py (feed parsing, host checking, fetching) and
the /shadow/podcasts routes in main.py.

No network: the routes get a fake podcast.fetch and a fake check_url, the
fixture feed at tests/fixtures/feed.xml stands in for a real RSS 2.0
response, and fetch's own tests swap the pinned transport for an
httpx.MockTransport. check_url's network call, socket.getaddrinfo, is
monkeypatched wherever a hostname would need a real lookup; the literal
address and bad-scheme cases never reach DNS.
"""

import asyncio
import math
import shutil
import socket
import threading
from pathlib import Path

import httpx
import pytest
from fastapi import BackgroundTasks, HTTPException

import main
import podcast
import store

FIXTURE = Path(__file__).parent / "fixtures" / "feed.xml"


@pytest.fixture(autouse=True)
def _init_db():
    store.init()


AUTH = f"Bearer {main.SHADOW_TOKEN}"
DEV = "dddddddd-0000-4000-8000-00000000000d"


def test_parse_feed_reads_the_fixture_in_order():
    result = podcast.parse_feed(FIXTURE.read_bytes())

    assert result["title"] == "Test Japanese Podcast"
    assert [e["title"] for e in result["episodes"]] == [
        "Episode One: The Long One",
        "Episode Two: Seconds Only",
    ]


def test_parse_feed_skips_items_without_an_enclosure():
    result = podcast.parse_feed(FIXTURE.read_bytes())

    titles = [e["title"] for e in result["episodes"]]
    assert "Episode Three: No Audio" not in titles


def test_parse_feed_reads_hh_mm_ss_and_plain_second_durations():
    result = podcast.parse_feed(FIXTURE.read_bytes())

    one, two = result["episodes"]
    assert one["duration_s"] == 3723
    assert two["duration_s"] == 1830
    assert one["audio_url"] == "https://example.com/audio/episode-one.mp3"
    assert one["bytes"] == 59000000


def test_parse_feed_atom_feed_gives_an_empty_episode_list():
    atom = (
        b'<?xml version="1.0"?>'
        b'<feed xmlns="http://www.w3.org/2005/Atom"><title>Not RSS</title>'
        b"<entry><title>Entry</title></entry></feed>"
    )

    result = podcast.parse_feed(atom)

    assert result == {"title": "", "episodes": []}


def test_parse_feed_garbage_input_never_raises():
    result = podcast.parse_feed(b"this is not xml at all <<<")

    assert result == {"title": "", "episodes": []}


async def _public_check(url):
    return "93.184.216.34"


def _fake_resolver(addr):
    def fake_getaddrinfo(host, port):
        return [(socket.AF_INET6 if ":" in addr else socket.AF_INET, socket.SOCK_STREAM, 6, "",
                 (addr, 0))]
    return fake_getaddrinfo


def test_check_url_refuses_loopback_and_non_http_schemes():
    with pytest.raises(ValueError):
        asyncio.run(podcast.check_url("http://127.0.0.1:50021/"))
    with pytest.raises(ValueError):
        asyncio.run(podcast.check_url("http://[::1]:8020/"))
    with pytest.raises(ValueError):
        asyncio.run(podcast.check_url("ftp://example.com/feed.xml"))


@pytest.mark.parametrize("addr", [
    "100.64.0.1",        # CGNAT
    "240.0.0.1",         # reserved
    "224.0.1.1",         # multicast
    "0.0.0.0",
    "169.254.169.254",   # link-local metadata
    "::ffff:127.0.0.1",  # IPv4-mapped loopback
    "fd00::1",           # unique local
])
def test_check_url_refuses_every_non_global_address(monkeypatch, addr):
    monkeypatch.setattr(socket, "getaddrinfo", _fake_resolver(addr))

    with pytest.raises(ValueError):
        asyncio.run(podcast.check_url("http://looks-public.example.com/feed.xml"))


def test_check_url_returns_the_public_address_it_approved(monkeypatch):
    monkeypatch.setattr(socket, "getaddrinfo", _fake_resolver("93.184.216.34"))

    assert asyncio.run(podcast.check_url("https://example.com/feed.xml")) == "93.184.216.34"


def test_check_url_turns_a_bad_hostname_into_a_value_error(monkeypatch):
    def raise_unicode(host, port):
        raise UnicodeError("label too long")

    monkeypatch.setattr(socket, "getaddrinfo", raise_unicode)

    with pytest.raises(ValueError):
        asyncio.run(podcast.check_url("http://bad-host.example.com/"))


def test_check_url_refuses_a_host_that_resolves_to_a_private_address(monkeypatch):
    def fake_getaddrinfo(host, port):
        return [(socket.AF_INET, socket.SOCK_STREAM, 6, "", ("10.0.0.5", 0))]

    monkeypatch.setattr(socket, "getaddrinfo", fake_getaddrinfo)

    with pytest.raises(ValueError):
        asyncio.run(podcast.check_url("http://looks-public.example.com/feed.xml"))


def _mock_fetch_env(monkeypatch, handler, refused_hosts=("127.0.0.1",)):
    """fetch with no network: check_url refuses `refused_hosts` and approves
    anything else, and every hop's transport is a MockTransport."""
    checked = []

    async def fake_check(url):
        checked.append(url)
        host = httpx.URL(url).host
        if host in refused_hosts:
            raise ValueError(f"refusing to reach a non-public address: {host}")
        return "93.184.216.34"

    monkeypatch.setattr(podcast, "check_url", fake_check)
    monkeypatch.setattr(podcast, "_pinned_transport",
                        lambda host, addr: httpx.MockTransport(handler))
    return checked


def test_fetch_refuses_a_redirect_to_an_internal_host(monkeypatch):
    requested = []

    def handler(request):
        requested.append(str(request.url))
        return httpx.Response(302, headers={"location": "http://127.0.0.1:8020/shadow/islands"})

    checked = _mock_fetch_env(monkeypatch, handler)

    with pytest.raises(podcast.PodcastError):
        asyncio.run(podcast.fetch("https://example.com/feed.xml", None, 1000))

    assert requested == ["https://example.com/feed.xml"]
    assert checked == ["https://example.com/feed.xml", "http://127.0.0.1:8020/shadow/islands"]


def test_fetch_follows_a_relative_redirect_after_checking_it(monkeypatch):
    def handler(request):
        if request.url.path == "/old.xml":
            return httpx.Response(301, headers={"location": "/new.xml"})
        return httpx.Response(200, content=b"<rss/>")

    checked = _mock_fetch_env(monkeypatch, handler)

    body = asyncio.run(podcast.fetch("https://example.com/old.xml", None, 1000))

    assert body == b"<rss/>"
    assert checked == ["https://example.com/old.xml", "https://example.com/new.xml"]


def test_fetch_gives_up_after_too_many_redirects(monkeypatch):
    def handler(request):
        n = int(request.url.params.get("n", "0"))
        return httpx.Response(302, headers={"location": f"/loop?n={n + 1}"})

    checked = _mock_fetch_env(monkeypatch, handler)

    with pytest.raises(podcast.PodcastError):
        asyncio.run(podcast.fetch("https://example.com/loop", None, 1000))

    assert len(checked) == podcast.MAX_REDIRECTS + 1


def test_fetch_stops_at_the_overall_deadline(monkeypatch):
    async def slow(url, dest, max_bytes):
        await asyncio.sleep(5)

    monkeypatch.setattr(podcast, "_stream_to", slow)

    with pytest.raises(podcast.PodcastError):
        asyncio.run(podcast.fetch("https://example.com/a.mp3", None, 1000, deadline_s=0.01))


def test_pinned_backend_connects_to_the_checked_address_only(monkeypatch):
    calls = []

    async def fake_connect(self, host, port, timeout=None, local_address=None,
                           socket_options=None):
        calls.append((host, port))
        return "stream"

    monkeypatch.setattr(podcast.httpcore.AnyIOBackend, "connect_tcp", fake_connect)
    backend = podcast._PinnedBackend("example.com", "93.184.216.34")

    assert asyncio.run(backend.connect_tcp("example.com", 443)) == "stream"
    assert calls == [("93.184.216.34", 443)]
    with pytest.raises(podcast.httpcore.ConnectError):
        asyncio.run(backend.connect_tcp("internal.example.com", 443))


def test_podcast_episodes_route_lists_the_fixture(monkeypatch):
    monkeypatch.setattr(main.podcast, "check_url", _public_check)
    async def fake_fetch(url, dest, max_bytes):
        assert dest is None
        return FIXTURE.read_bytes()

    monkeypatch.setattr(main.podcast, "fetch", fake_fetch)

    result = asyncio.run(
        main.podcast_episodes(url="https://example.com/feed.xml", authorization=AUTH)
    )

    assert result["title"] == "Test Japanese Podcast"
    assert len(result["episodes"]) == 2


def test_podcast_episodes_route_refuses_a_private_url():
    with pytest.raises(HTTPException) as exc_info:
        asyncio.run(
            main.podcast_episodes(url="http://127.0.0.1:50021/feed.xml", authorization=AUTH)
        )

    assert exc_info.value.status_code == 400


def test_podcast_episodes_route_gives_a_502_when_the_fetch_fails(monkeypatch):
    monkeypatch.setattr(main.podcast, "check_url", _public_check)

    async def fake_fetch(url, dest, max_bytes):
        raise podcast.PodcastError("boom")

    monkeypatch.setattr(main.podcast, "fetch", fake_fetch)

    with pytest.raises(HTTPException) as exc_info:
        asyncio.run(
            main.podcast_episodes(url="https://example.com/feed.xml", authorization=AUTH)
        )

    assert exc_info.value.status_code == 502


def test_import_podcast_episode_creates_a_podcast_island_and_hands_off(monkeypatch, tmp_path):
    monkeypatch.setattr(main.podcast, "check_url", _public_check)

    async def fake_fetch(url, dest, max_bytes):
        dest.write_bytes(b"fake audio bytes")
        return None

    monkeypatch.setattr(main.podcast, "fetch", fake_fetch)

    captured = {}

    async def fake_build_import(island_id, media, srt_text, title, start_s, tmp_dir=None,
                                 language="ja", native="en"):
        captured["island_id"] = island_id
        captured["title"] = title
        captured["start_s"] = start_s
        captured["srt_text"] = srt_text
        captured["media_exists"] = media.exists()
        captured["tmp_dir"] = tmp_dir

    monkeypatch.setattr(main, "_build_import", fake_build_import)

    background = BackgroundTasks()
    result = asyncio.run(
        main.import_podcast_episode(
            background=background,
            audio_url="https://example.com/audio/episode-one.mp3",
            title="Episode One",
            start_min=5,
            speaker=3,
            language="ja",
            native="en",
            authorization=AUTH,
            x_shadow_device=DEV,
        )
    )

    assert result["status"] == "pending"
    island = store.get_island(result["id"])
    assert island["source"] == "podcast"
    assert island["source_name"] == "Episode One"

    assert len(background.tasks) == 1
    asyncio.run(background.tasks[0]())

    assert captured["island_id"] == result["id"]
    assert captured["title"] == "Episode One"
    assert captured["start_s"] == 300.0
    assert captured["srt_text"] is None
    assert captured["media_exists"] is True

    shutil.rmtree(captured["tmp_dir"], ignore_errors=True)


def test_import_podcast_episode_refuses_a_non_japanese_language():
    with pytest.raises(HTTPException) as exc_info:
        asyncio.run(
            main.import_podcast_episode(
                background=BackgroundTasks(),
                audio_url="https://example.com/audio/episode-one.mp3",
                language="en",
                authorization=AUTH,
                x_shadow_device=DEV,
            )
        )

    assert exc_info.value.status_code == 400


def test_import_podcast_episode_refuses_a_negative_start_min():
    with pytest.raises(HTTPException) as exc_info:
        asyncio.run(
            main.import_podcast_episode(
                background=BackgroundTasks(),
                audio_url="https://example.com/audio/episode-one.mp3",
                start_min=-1,
                language="ja",
                authorization=AUTH,
                x_shadow_device=DEV,
            )
        )

    assert exc_info.value.status_code == 400


@pytest.mark.parametrize("start_min", [math.nan, math.inf])
def test_import_podcast_episode_refuses_a_non_finite_start_min(start_min):
    with pytest.raises(HTTPException) as exc_info:
        asyncio.run(
            main.import_podcast_episode(
                background=BackgroundTasks(),
                audio_url="https://example.com/audio/episode-one.mp3",
                start_min=start_min,
                language="ja",
                authorization=AUTH,
                x_shadow_device=DEV,
            )
        )

    assert exc_info.value.status_code == 400


def test_import_podcast_episode_refuses_a_private_audio_url():
    with pytest.raises(HTTPException) as exc_info:
        asyncio.run(
            main.import_podcast_episode(
                background=BackgroundTasks(),
                audio_url="http://127.0.0.1:50021/audio.mp3",
                start_min=0,
                language="ja",
                authorization=AUTH,
                x_shadow_device=DEV,
            )
        )

    assert exc_info.value.status_code == 400


def test_build_podcast_fails_the_island_when_the_download_errors(tmp_path, monkeypatch):
    island_id = store.create_island("simple", 3, source="podcast", source_name="Episode")

    async def failing_fetch(url, dest, max_bytes):
        raise podcast.PodcastError("no route to host")

    monkeypatch.setattr(main.podcast, "fetch", failing_fetch)

    asyncio.run(main._build_podcast(island_id, "https://example.com/a.mp3", "Episode", 0.0, tmp_path))

    island = store.get_island(island_id)
    assert island["status"] == "failed"
    assert not tmp_path.exists()


# --- BL-63 ai-picks ---

import json as _json
import sqlite3 as _sqlite3

import generate
import review_deck
import schedule

PICK_DEV = "eeeeeeee-0000-4000-8000-0000000000c1"
PICK_AUTH = f"Bearer {main.SHADOW_TOKEN}"


def _pick_island(source="podcast", device=PICK_DEV, count=12):
    review_deck.init()
    schedule.init()
    with review_deck.connect() as conn:
        conn.execute("DELETE FROM review_cards")
    island_id = store.create_island("simple", count, source=source, device=device)
    for i in range(count):
        store.add_line(island_id, i, {"ja": f"line{i}", "kana": "a", "romaji": "a", "en": "a"},
                       2.0, [], words=[], offset=float(i))
        path = store.line_audio_path(island_id, i)
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(b"RIFFfake")
    store.set_ready(island_id, "Title")
    return island_id


def _picks(island_id, device=PICK_DEV):
    return asyncio.run(main.ai_picks(
        island_id=island_id, authorization=PICK_AUTH, x_shadow_device=device))


def _cli(monkeypatch, payload):
    monkeypatch.setattr(generate, "_run_cli", lambda prompt, tag: payload if payload is None else _json.dumps(payload))


def _code(fn, *a, **kw):
    with pytest.raises(HTTPException) as e:
        fn(*a, **kw)
    return e.value


def test_ai_picks_happy_path(monkeypatch):
    iid = _pick_island()
    _cli(monkeypatch, {"picks": [{"n": n, "tag": f"point {n}"} for n in (1, 3, 5, 7, 9)]})
    out = _picks(iid)
    assert out["picked"] == len(out["cards"]) == 5
    assert [c["idx"] for c in out["cards"]] == [0, 2, 4, 6, 8]
    assert all(c["tag"] and c["kind"] == "clip" for c in out["cards"])
    assert review_deck.clip_path(out["cards"][0]["id"]).exists()


def test_ai_picks_drops_bad_and_duplicate_n(monkeypatch):
    iid = _pick_island()
    picks = [{"n": 0, "tag": "x"}, {"n": 99, "tag": "x"}, {"n": 2, "tag": "a"}, {"n": 2, "tag": "b"},
             {"n": True, "tag": "x"}, {"n": "3", "tag": "x"}, {"n": 4, "tag": " " + "t" * 60},
             {"n": 5, "tag": "c"}]
    _cli(monkeypatch, {"picks": picks})
    out = _picks(iid)
    assert [c["idx"] for c in out["cards"]] == [1, 3, 4]
    assert out["cards"][0]["tag"] == "a"
    assert len(out["cards"][1]["tag"]) <= generate.PICK_TAG_MAX


def test_ai_picks_too_few_is_502_and_free(monkeypatch):
    iid = _pick_island()
    _cli(monkeypatch, {"picks": [{"n": 1, "tag": "a"}, {"n": 1, "tag": "b"}, {"n": 2, "tag": "c"}]})
    assert _code(_picks, iid).detail == {"code": "pick_failed"}
    _cli(monkeypatch, None)
    assert _code(_picks, iid).status_code == 502
    assert review_deck.list_cards(PICK_DEV, iid) == []


def test_ai_picks_refunds_energy_on_failure(monkeypatch):
    iid = _pick_island()
    calls = []
    monkeypatch.setattr(main, "_take_use_slot", lambda d, k, c="": calls.append(("take", k, c)))
    monkeypatch.setattr(main, "_refund_use_slot", lambda d, k, c: calls.append(("refund", k, c)))
    _cli(monkeypatch, {"picks": []})
    assert _code(_picks, iid).status_code == 502
    assert calls == [("take", "pick_sentences", "pick"), ("refund", "pick_sentences", "pick")]


def test_ai_picks_second_call_has_cards(monkeypatch):
    iid = _pick_island()
    _cli(monkeypatch, {"picks": [{"n": n, "tag": "t"} for n in (1, 2, 3)]})
    _picks(iid)
    assert _code(_picks, iid).detail == {"code": "has_cards"}


def test_ai_picks_not_podcast_and_other_device(monkeypatch):
    _cli(monkeypatch, {"picks": []})
    assert _code(_picks, _pick_island(source="record")).detail == {"code": "not_podcast"}
    iid = _pick_island()
    assert _code(_picks, iid, "eeeeeeee-0000-4000-8000-0000000000c2").status_code == 404


def test_ai_picks_daily_cap(monkeypatch):
    iid = _pick_island()
    _cli(monkeypatch, {"picks": [{"n": n, "tag": "t"} for n in (1, 2, 3)]})
    monkeypatch.setitem(main.DAILY_CAPS, "pick_sentences", 0)
    err = _code(_picks, iid)
    assert err.status_code == 429
    assert err.detail["code"] == "daily_limit" and err.detail["kind"] == "pick_sentences"


def test_review_init_adds_tag_column(tmp_path, monkeypatch):
    db = tmp_path / "old.db"
    with _sqlite3.connect(db) as conn:
        conn.executescript(review_deck.SCHEMA)  # the base schema has no tag column
    monkeypatch.setattr(review_deck, "DB_PATH", db)
    monkeypatch.setattr(review_deck, "_local", threading.local())
    review_deck.init()
    with review_deck.connect() as conn:
        assert "tag" in {r["name"] for r in conn.execute("PRAGMA table_info(review_cards)")}
