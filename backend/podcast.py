"""RSS podcast feeds: parsing episode lists and fetching feed or episode
bytes. A feed and its episode audio both come from a URL a user types in, so
every host, redirects included, is checked against any non-public address
before a request goes out, and the request connects to the checked address.
VOICEVOX and this backend both listen on loopback, and this machine has a
public IP with no NAT, so that check matters here more than almost anywhere
else in the app.
"""

from __future__ import annotations

import asyncio
import ipaddress
import re
import socket
import xml.etree.ElementTree as ET
from pathlib import Path
from urllib.parse import urljoin, urlsplit

import httpcore
import httpx

FEED_MAX_BYTES = 5 * 1024 * 1024
CONNECT_TIMEOUT_S = 30.0
FEED_DEADLINE_S = 60.0
DOWNLOAD_DEADLINE_S = 30 * 60.0
MAX_REDIRECTS = 5
REDIRECT_STATUSES = (301, 302, 303, 307, 308)

_ITUNES_DURATION = "{http://www.itunes.com/dtds/podcast-1.0.dtd}duration"


class PodcastError(Exception):
    """A feed or an episode could not be fetched."""


def _parse_duration(raw: str | None) -> int | None:
    """itunes:duration is "HH:MM:SS", "MM:SS" or a plain second count.
    Anything else gives None rather than a guess."""
    if not raw:
        return None
    raw = raw.strip()
    if not raw:
        return None
    parts = raw.split(":")
    if not all(re.fullmatch(r"\d+", p) for p in parts):
        return None
    values = [int(p) for p in parts]
    if len(values) == 1:
        return values[0]
    if len(values) == 2:
        minutes, seconds = values
        return minutes * 60 + seconds
    if len(values) == 3:
        hours, minutes, seconds = values
        return hours * 3600 + minutes * 60 + seconds
    return None


def parse_feed(xml: bytes) -> dict:
    """RSS 2.0 only: `channel/title` and `channel/item`. Never raises, an
    Atom feed or malformed XML gives an empty episode list rather than
    failing the request that asked for it."""
    try:
        root = ET.fromstring(xml)
    except ET.ParseError:
        return {"title": "", "episodes": []}

    channel = root.find("channel")
    if channel is None:
        return {"title": "", "episodes": []}

    title_el = channel.find("title")
    title = (title_el.text or "").strip() if title_el is not None else ""

    episodes = []
    for item in channel.findall("item"):
        enclosure = item.find("enclosure")
        audio_url = enclosure.get("url") if enclosure is not None else None
        if not audio_url:
            continue
        item_title_el = item.find("title")
        item_title = (item_title_el.text or "").strip() if item_title_el is not None else ""
        pub_el = item.find("pubDate")
        published = (pub_el.text or "").strip() if pub_el is not None and pub_el.text else None
        duration_el = item.find(_ITUNES_DURATION)
        duration_s = _parse_duration(duration_el.text if duration_el is not None else None)
        length = enclosure.get("length")
        try:
            byte_count = int(length) if length else None
        except ValueError:
            byte_count = None
        episodes.append({
            "title": item_title,
            "published": published,
            "duration_s": duration_s,
            "audio_url": audio_url,
            "bytes": byte_count,
        })

    return {"title": title, "episodes": episodes}


async def check_url(url: str) -> str:
    """Refuse anything that is not a plain http(s) URL whose host resolves
    only to global (public) addresses, and return the address to connect to.
    Raises ValueError on a loopback, private, link-local, CGNAT, reserved or
    multicast address, on a host that does not resolve, or on any scheme
    other than http/https. `fetch` connects to the returned address, so a
    second DNS answer cannot swap in an internal one after this check."""
    parts = urlsplit(url)
    if parts.scheme not in ("http", "https"):
        raise ValueError("only http and https urls are allowed")
    host = parts.hostname
    if not host:
        raise ValueError("url has no host")
    try:
        infos = await asyncio.to_thread(socket.getaddrinfo, host, None)
    except (socket.gaierror, UnicodeError) as exc:
        raise ValueError(f"could not resolve host: {host}") from exc
    if not infos:
        raise ValueError(f"could not resolve host: {host}")
    addrs = []
    for info in infos:
        # An IPv6 answer can carry a zone suffix ("fe80::1%eth0").
        addr = str(info[4][0]).split("%", 1)[0]
        ip = ipaddress.ip_address(addr)
        if isinstance(ip, ipaddress.IPv6Address) and ip.ipv4_mapped is not None:
            ip = ip.ipv4_mapped
        if not ip.is_global or ip.is_multicast:
            raise ValueError(f"refusing to reach a non-public address: {addr}")
        addrs.append(addr)
    return addrs[0]


class _PinnedBackend(httpcore.AnyIOBackend):
    """Connects to the address check_url approved instead of resolving the
    host again. httpcore still passes the URL's own host for the Host header
    and for TLS SNI and certificate checks, so only the socket target moves."""

    def __init__(self, host: str, addr: str) -> None:
        self._host = host
        self._addr = addr

    async def connect_tcp(self, host, port, timeout=None, local_address=None, socket_options=None):
        if host != self._host:
            raise httpcore.ConnectError(f"refusing an unchecked host: {host}")
        return await super().connect_tcp(
            self._addr, port, timeout=timeout,
            local_address=local_address, socket_options=socket_options,
        )


def _pinned_transport(host: str, addr: str) -> httpx.AsyncHTTPTransport:
    """An httpx transport whose connections all go to `addr`. httpx 0.28
    takes no network backend argument, so the pool it builds is swapped for
    one that has ours. requirements.txt pins httpx==0.28.1, which keeps
    that private `_pool` attribute stable."""
    transport = httpx.AsyncHTTPTransport(trust_env=False)
    transport._pool = httpcore.AsyncConnectionPool(
        ssl_context=httpx.create_ssl_context(trust_env=False),
        network_backend=_PinnedBackend(host, addr),
    )
    return transport


async def _stream_to(url: str, dest: Path | None, max_bytes: int) -> bytes | None:
    """The body of `fetch`, without its deadline."""
    chunks: list[bytes] = []
    fh = dest.open("wb") if dest is not None else None
    try:
        timeout = httpx.Timeout(CONNECT_TIMEOUT_S)
        current = url
        for _hop in range(MAX_REDIRECTS + 1):
            try:
                addr = await check_url(current)
            except ValueError as exc:
                raise PodcastError(str(exc)) from exc
            host = urlsplit(current).hostname or ""
            transport = _pinned_transport(host, addr)
            async with httpx.AsyncClient(
                transport=transport, follow_redirects=False, timeout=timeout, trust_env=False,
            ) as client:
                async with client.stream("GET", current) as resp:
                    location = resp.headers.get("location")
                    if resp.status_code in REDIRECT_STATUSES and location:
                        current = urljoin(current, location)
                        continue
                    if resp.status_code // 100 != 2:
                        raise PodcastError(f"fetch failed with status {resp.status_code}")
                    total = 0
                    async for chunk in resp.aiter_bytes():
                        total += len(chunk)
                        if total > max_bytes:
                            raise PodcastError("response exceeded the size limit")
                        if fh is not None:
                            fh.write(chunk)
                        else:
                            chunks.append(chunk)
            return None if dest is not None else b"".join(chunks)
        raise PodcastError(f"more than {MAX_REDIRECTS} redirects")
    except httpx.HTTPError as exc:
        raise PodcastError(str(exc)) from exc
    finally:
        if fh is not None:
            fh.close()


async def fetch(url: str, dest: Path | None, max_bytes: int,
                deadline_s: float | None = None) -> bytes | None:
    """Stream `url` either into memory (`dest` is None, used for feeds) or
    onto disk at `dest` (used for episode audio). Every hop, the first and
    each redirect (at most MAX_REDIRECTS), goes through check_url and
    connects to the address it approved. A 30s connect timeout applies per
    request and `deadline_s` caps the whole download (FEED_DEADLINE_S or
    DOWNLOAD_DEADLINE_S when not given). Raises PodcastError on a refused
    hop, a non-2xx status, a response past `max_bytes` or the deadline."""
    if deadline_s is None:
        deadline_s = FEED_DEADLINE_S if dest is None else DOWNLOAD_DEADLINE_S
    try:
        return await asyncio.wait_for(_stream_to(url, dest, max_bytes), deadline_s)
    except TimeoutError as exc:
        raise PodcastError(f"download took longer than {deadline_s:.0f}s") from exc
