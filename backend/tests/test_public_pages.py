import re
from pathlib import Path

from fastapi.testclient import TestClient

import main

client = TestClient(main.app)
STATIC = Path(main.__file__).parent / "static"


def test_pages_are_public_html():
    for path in ("/shadow/", "/shadow", "/shadow/privacy"):
        resp = client.get(path)
        assert resp.status_code == 200, path
        assert resp.headers["content-type"].startswith("text/html")


def test_privacy_content():
    body = client.get("/shadow/privacy").text
    for needle in ("2026-10-12", "sean@larch-networks.com", "30 days", "HTTPS", "Anthropic", "Supabase", "Settings &gt; Delete account", "right away"):
        assert needle in body
    assert "train" not in body


def test_pages_are_self_contained():
    for path in ("/shadow/", "/shadow/privacy"):
        body = client.get(path).text
        assert "prefers-color-scheme" in body
        assert "<script" not in body
        external = re.findall(r"(?:src|href)=[\"'](https?://[^\"']*)", body)
        assert set(external) <= {"https://www.anthropic.com/legal/privacy"}


def test_no_em_dash():
    for name in ("index.html", "privacy.html"):
        assert "\u2014" not in (STATIC / name).read_text(encoding="utf-8")


def test_guard_not_loosened():
    assert client.get("/shadow/islands").status_code == 401
