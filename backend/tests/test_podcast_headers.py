import asyncio

import httpx

import podcast


def test_fetch_sends_a_user_agent_and_accept(monkeypatch):
    seen = {}

    def handler(request: httpx.Request) -> httpx.Response:
        seen.update(request.headers)
        return httpx.Response(200, content=b"<rss/>")

    async def fake_check(url):
        return "203.0.113.1"

    monkeypatch.setattr(podcast, "check_url", fake_check)
    monkeypatch.setattr(podcast, "_pinned_transport", lambda host, addr: httpx.MockTransport(handler))
    body = asyncio.run(podcast._stream_to("https://example.com/feed", None, 1000))
    assert body == b"<rss/>"
    assert "Mozilla" in seen["user-agent"]
    assert "rss" in seen["accept"]


def test_a_403_is_retried_once_with_the_itunes_user_agent(monkeypatch):
    agents = []

    def handler(request: httpx.Request) -> httpx.Response:
        agents.append(request.headers["user-agent"])
        if "iTunes" in agents[-1]:
            return httpx.Response(200, content=b"<rss/>")
        return httpx.Response(403)

    async def fake_check(url):
        return "203.0.113.1"

    monkeypatch.setattr(podcast, "check_url", fake_check)
    monkeypatch.setattr(podcast, "_pinned_transport", lambda host, addr: httpx.MockTransport(handler))
    body = asyncio.run(podcast._stream_to("https://example.com/feed", None, 1000))
    assert body == b"<rss/>"
    assert len(agents) == 2 and "Mozilla" in agents[0]
