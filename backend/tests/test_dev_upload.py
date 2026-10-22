"""Dev upload routes, called directly (no TestClient)."""

import asyncio

import pytest
from fastapi import HTTPException

import dev_upload

AUTH = "Bearer t0k"


@pytest.fixture(autouse=True)
def env(monkeypatch, tmp_path):
    monkeypatch.setenv("SHADOW_TOKEN", "t0k")
    monkeypatch.setenv("SHADOW_REVIEW_FILE", str(tmp_path / "current.json"))
    monkeypatch.setattr(dev_upload, "CHUNK_SIZE", 4)
    return tmp_path


class Req:
    def __init__(self, data: bytes):
        self._d = data

    async def body(self):
        return self._d


def put(uid, i, data, auth=AUTH):
    return asyncio.run(dev_upload.put_chunk(uid, i, Req(data), auth))


def test_round_trip_with_resume(env):
    uid = dev_upload.init(dev_upload.InitBody(name="My Rec.MP4", size=10), AUTH)["id"]
    put(uid, 2, b"gh")
    put(uid, 0, b"abcd")
    assert dev_upload.status(uid, AUTH)["received"] == [0, 2]
    put(uid, 0, b"abcd")
    with pytest.raises(HTTPException) as e:
        dev_upload.complete(uid, AUTH)
    assert e.value.status_code == 409
    put(uid, 1, b"efgh")
    name = dev_upload.complete(uid, AUTH)["upload"]
    assert name.endswith("-my-rec.mp4")
    assert (env / "uploads" / name).read_bytes() == b"abcdefghgh"[:8] + b"gh"
    assert '"upload": "%s"' % name in (env / "uploads.jsonl").read_text()


def test_bad_index_and_length():
    uid = dev_upload.init(dev_upload.InitBody(name="a.mov", size=10), AUTH)["id"]
    for i in (-1, 3):
        with pytest.raises(HTTPException) as e:
            put(uid, i, b"abcd")
        assert e.value.status_code == 400
    with pytest.raises(HTTPException):
        put(uid, 0, b"abc")
    with pytest.raises(HTTPException):
        put(uid, 2, b"abcd")


def test_traversal_ids_and_names(env):
    for bad in ("../x", "..", "a" * 32 + "/", "ZZ" * 16):
        with pytest.raises(HTTPException) as e:
            dev_upload.status(bad, AUTH)
        assert e.value.status_code == 404
    uid = dev_upload.init(dev_upload.InitBody(name="../../etc/passwd.mp4", size=1), AUTH)["id"]
    put(uid, 0, b"x")
    name = dev_upload.complete(uid, AUTH)["upload"]
    assert "/" not in name and ".." not in name
    assert (env / "uploads" / name).exists()


def test_size_limits(monkeypatch):
    with pytest.raises(HTTPException) as e:
        dev_upload.init(dev_upload.InitBody(name="a.mp4", size=dev_upload.MAX_SIZE + 1), AUTH)
    assert e.value.status_code == 413
    monkeypatch.setattr(dev_upload, "DISK_MARGIN", 1 << 60)
    with pytest.raises(HTTPException) as e:
        dev_upload.init(dev_upload.InitBody(name="a.mp4", size=1), AUTH)
    assert e.value.status_code == 507


def test_token_required():
    with pytest.raises(HTTPException) as e:
        dev_upload.init(dev_upload.InitBody(name="a.mp4", size=1), None)
    assert e.value.status_code == 401
    with pytest.raises(HTTPException):
        dev_upload.status("a" * 32, "Bearer nope")


def test_page_needs_no_token_and_embeds_none():
    html = dev_upload.page().body.decode()
    assert "t0k" not in html and "video/*" in html


def test_disabled_in_prod(monkeypatch):
    monkeypatch.setenv("SHADOW_ENV", "prod")
    assert dev_upload.enabled() is False


def test_page_loads_without_device_header():
    from fastapi.testclient import TestClient

    import main

    r = TestClient(main.app).get("/shadow/dev/upload")
    assert r.status_code == 200
    assert "text/html" in r.headers["content-type"]
    # API still needs the bearer token, not a device id.
    r = TestClient(main.app).post("/shadow/dev/upload/init", json={"name": "a.mp4", "size": 1})
    assert r.status_code == 401
    assert r.json()["detail"] != "missing device id"
