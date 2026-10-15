"""Tests for the saved-sentence review deck: review_deck.py and its routes."""

import asyncio

import pytest
from fastapi import HTTPException

import main
import review_deck
import schedule
import spacing
import store

AUTH = f"Bearer {main.SHADOW_TOKEN}"
DEV = "eeeeeeee-0000-4000-8000-0000000000b1"
OTHER = "eeeeeeee-0000-4000-8000-0000000000b2"


@pytest.fixture(autouse=True)
def _init_db():
    store.init()
    schedule.init()
    review_deck.init()
    with review_deck.connect() as conn:
        conn.execute("DELETE FROM review_cards")


def _island(source="podcast", wav=True, video=False, device=DEV):
    island_id = store.create_island("simple", 3, source=source, device=device)
    store.add_line(island_id, 0, {"ja": "a", "kana": "a", "romaji": "a", "en": "a"}, 2.0,
                   [], words=[{"w": "a"}], offset=5.0)
    store.set_ready(island_id, "Title")
    if wav:
        path = store.line_audio_path(island_id, 0)
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(b"RIFFfake")
    if video:
        store.add_video(island_id, "vid123", 100.0, "T", "A")
    return island_id


def _save(island_id, idx=0, device=DEV):
    return asyncio.run(main.review_save(
        island_id=island_id, idx=idx, authorization=AUTH, x_shadow_device=device))


def _grade(card_id, result, device=DEV):
    return asyncio.run(main.review_grade(
        card_id=card_id, result=result, authorization=AUTH, x_shadow_device=device))


def _due(device=DEV):
    return asyncio.run(main.review_due(authorization=AUTH, x_shadow_device=device))


def _status(fn, *a, **kw):
    with pytest.raises(HTTPException) as e:
        fn(*a, **kw)
    return e.value


def test_podcast_line_makes_a_clip_card_and_copies_the_file():
    card = _save(_island())
    assert card["kind"] == "clip"
    assert "device" not in card
    assert card["words"] == [{"w": "a"}]
    assert review_deck.clip_path(card["id"]).read_bytes() == b"RIFFfake"


def test_video_line_makes_an_embed_card_with_timing():
    card = _save(_island("youtube", wav=False, video=True))
    assert card["kind"] == "embed"
    assert card["video_id"] == "vid123"
    assert card["start_s"] == 105.0
    assert card["end_s"] == 107.0


def test_no_audio_and_no_video_is_409():
    exc = _status(lambda: _save(_island(wav=False)))
    assert exc.status_code == 409
    assert exc.detail == {"code": "review_no_audio"}


def test_unknown_line_is_404():
    assert _status(lambda: _save(_island(), idx=9)).status_code == 404


def test_saving_twice_returns_the_same_card():
    island = _island()
    assert _save(island)["id"] == _save(island)["id"]
    assert review_deck.count_cards(DEV) == 1


def test_other_device_gets_404_everywhere():
    island = _island()
    card = _save(island)
    assert _status(lambda: _save(island, device=OTHER)).status_code == 404
    assert _status(lambda: _grade(card["id"], "got", OTHER)).status_code == 404
    assert _status(lambda: asyncio.run(main.review_delete(
        card_id=card["id"], authorization=AUTH, x_shadow_device=OTHER))).status_code == 404
    assert _status(lambda: asyncio.run(main.review_audio(
        card_id=card["id"], token="", device="", authorization=AUTH,
        x_shadow_device=OTHER))).status_code == 404
    assert _due(OTHER)["total"] == 0


def test_audio_serves_clip_and_404s_embed():
    clip = _save(_island())
    res = asyncio.run(main.review_audio(
        card_id=clip["id"], token="", device="", authorization=AUTH, x_shadow_device=DEV))
    assert str(res.path) == str(review_deck.clip_path(clip["id"]))
    embed = _save(_island("youtube", wav=False, video=True))
    assert _status(lambda: asyncio.run(main.review_audio(
        card_id=embed["id"], token="", device="", authorization=AUTH,
        x_shadow_device=DEV))).status_code == 404


def test_new_card_is_due_and_got_removes_it(monkeypatch):
    monkeypatch.setattr(review_deck, "_today", lambda: "2026-03-01")
    card = _save(_island())
    assert [c["id"] for c in _due()["due"]] == [card["id"]]
    graded = _grade(card["id"], "got")
    assert graded["level"] == 1
    assert graded["due_on"] == "2026-03-02"
    after = _due()
    assert after["due"] == []
    assert after["total"] == 1


def test_again_resets_level_and_counts_a_lapse(monkeypatch):
    monkeypatch.setattr(review_deck, "_today", lambda: "2026-03-01")
    card = _save(_island())
    _grade(card["id"], "got")
    _grade(card["id"], "got")
    graded = _grade(card["id"], "again")
    assert graded["level"] == 0
    assert graded["lapses"] == 1
    assert graded["reviews"] == 3
    assert graded["due_on"] == "2026-03-01"


def test_got_caps_at_max_level(monkeypatch):
    monkeypatch.setattr(review_deck, "_today", lambda: "2026-03-01")
    card = _save(_island())
    for _ in range(spacing.MAX_LEVEL + 3):
        graded = _grade(card["id"], "got")
    assert graded["level"] == spacing.MAX_LEVEL


def test_bad_grade_result_is_400():
    card = _save(_island())
    assert _status(lambda: _grade(card["id"], "maybe")).status_code == 400


def test_card_500_is_409_full(monkeypatch):
    monkeypatch.setattr(review_deck, "MAX_CARDS", 1)
    _save(_island())
    exc = _status(lambda: _save(_island()))
    assert exc.status_code == 409
    assert exc.detail == {"code": "review_full"}


def test_delete_removes_card_and_clip():
    card = _save(_island())
    asyncio.run(main.review_delete(card_id=card["id"], authorization=AUTH, x_shadow_device=DEV))
    assert not review_deck.clip_path(card["id"]).exists()
    assert review_deck.get_card(DEV, card["id"]) is None


def test_list_filters_by_island():
    a, b = _island(), _island()
    _save(a)
    _save(b)
    res = asyncio.run(main.review_list(
        island_id=a, authorization=AUTH, x_shadow_device=DEV))
    assert len(res["cards"]) == 1
    assert len(review_deck.list_cards(DEV)) == 2


def test_delete_owner_wipes_rows_and_files():
    card = _save(_island())
    review_deck.delete_owner(DEV)
    assert review_deck.list_cards(DEV) == []
    assert not review_deck.clip_path(card["id"]).exists()
