"""Tests for backend/youtube.py and the /shadow/youtube routes in main.py.

No network: oembed_info is monkeypatched.
"""

import asyncio

import pytest
from fastapi import HTTPException

import main
import store
import youtube

AUTH = f"Bearer {main.SHADOW_TOKEN}"
DEV = "eeeeeeee-0000-4000-8000-00000000000e"
OTHER = "eeeeeeee-0000-4000-8000-00000000000f"
VID = "dQw4w9WgXcQ"


@pytest.fixture(autouse=True)
def _init_db(monkeypatch):
    store.init()
    monkeypatch.setattr(main, "DAILY_CREATES", 1000)


@pytest.mark.parametrize("text", [
    f"https://www.youtube.com/watch?v={VID}",
    f"https://youtube.com/watch?v={VID}&t=30s&list=PLabc",
    f"https://m.youtube.com/watch?v={VID}",
    f"https://music.youtube.com/watch?v={VID}&si=xyz",
    f"https://youtu.be/{VID}",
    f"https://youtu.be/{VID}?si=abc",
    f"https://www.youtube.com/shorts/{VID}",
    f"https://www.youtube.com/live/{VID}?feature=share",
    f"https://www.youtube.com/embed/{VID}",
    f"https://www.youtube.com/v/{VID}",
    f"  www.youtube.com/watch?v={VID}  ",
])
def test_parse_video_id_accepts(text):
    assert youtube.parse_video_id(text) == VID


@pytest.mark.parametrize("text", [
    "",
    "not a link",
    "https://vimeo.com/123456789",
    "https://www.youtube.com/watch?v=short",
    "https://www.youtube.com/channel/UCabcdefghijk",
    "https://evil.com/watch?v=" + VID,
    "ftp://youtu.be/" + VID,
])
def test_parse_video_id_rejects(text):
    assert youtube.parse_video_id(text) is None


def test_info_bad_link_is_400():
    with pytest.raises(HTTPException) as exc:
        asyncio.run(main.youtube_info("nope", authorization=AUTH, x_shadow_device=DEV))
    assert exc.value.status_code == 400
    assert exc.value.detail == {"code": "youtube_bad_link"}


def test_info_falls_back_to_the_default_thumbnail(monkeypatch):
    monkeypatch.setattr(youtube, "oembed_info",
                        lambda vid: {"title": "", "author": "", "thumbnail": ""})
    out = asyncio.run(main.youtube_info(
        f"https://youtu.be/{VID}", authorization=AUTH, x_shadow_device=DEV))
    assert out["video_id"] == VID
    assert out["thumbnail"] == f"https://i.ytimg.com/vi/{VID}/hqdefault.jpg"


def _make(device=DEV):
    iid = store.create_island("simple", 3, source="youtube", source_name=VID, device=device)
    store.add_video(iid, VID, 0.0, "Clip", "")
    return {"id": iid}


def test_delete_island_removes_the_video_row():
    out = _make()
    store.delete_island(out["id"])
    assert store.get_video(out["id"]) is None


def test_list_videos_filters_by_device():
    mine = _make()
    store.create_island("simple", 3, source="youtube", device=OTHER)
    ids = [v["island_id"] for v in store.list_videos(DEV)]
    assert mine["id"] in ids
    assert all(store.get_island(i)["device"] == DEV for i in ids)
    assert store.list_videos("eeeeeeee-0000-4000-8000-000000000000") == []


def test_startup_marks_interrupted_youtube_island_failed():
    out = _make()
    main._startup()
    island = store.get_island(out["id"])
    assert island["status"] == "failed"
    assert island["error_code"] == "import_interrupted"
