"""The pre-baked phrase topics: seeding, the instant import, the gift, and the
lenient first take on the guide's starter island."""

import asyncio
import io
import uuid

import pytest
from fastapi import BackgroundTasks, HTTPException, UploadFile

import main
import phrase_catalog
import progression
import starter
import store
import voices

AUTH = f"Bearer {main.SHADOW_TOKEN}"
CASES = [(lang, t["id"]) for lang in ("ja", "en", "es")
         for t in phrase_catalog.catalog(lang)["topics"]]


@pytest.fixture(autouse=True)
def _own_data_dir(monkeypatch, tmp_path):
    """Shared phrase renders land under store.DATA_DIR; a fresh one per test
    keeps another test's render from making an import instant."""
    monkeypatch.setattr(store, "DATA_DIR", tmp_path)


def _dev() -> str:
    return f"user_{uuid.uuid4().hex}"


@pytest.mark.parametrize("lang,topic", CASES)
def test_every_template_seeds_a_ready_phrases_island(lang, topic):
    store.init()
    island_id = starter.seed_topic(_dev(), lang, "en", topic, voices.default_speaker(lang))
    island = store.get_island(island_id)
    assert island["status"] == "ready" and island["source"] == "phrases"
    assert island["source_name"] == topic
    assert len(island["lines"]) == len(phrase_catalog.phrases(lang, topic))
    assert all(l["words"] for l in island["lines"])
    for i in range(len(island["lines"])):
        assert store.line_audio_path(island_id, i).stat().st_size > 1000


def test_hebrew_gloss_and_title_land():
    store.init()
    island = store.get_island(starter.seed_topic(_dev(), "ja", "he", "greetings", 3))
    assert island["title"] == phrase_catalog.title("greetings", "he")
    assert island["lines"][0]["en"] and island["lines"][0]["en"].isascii() is False


def _import(dev, speaker=3, topic="greetings"):
    return asyncio.run(main.import_phrases(
        BackgroundTasks(), topic=topic, speaker=speaker, language="ja", native="en",
        authorization=AUTH, x_shadow_device=dev))


def test_import_with_the_default_voice_is_instant_and_free():
    store.init()
    dev = _dev()
    out = _import(dev)
    assert out["status"] == "ready"
    assert store.count_builds_today(dev, "create") == 0
    assert _import(dev)["id"] == out["id"]


def test_import_with_another_voice_builds(monkeypatch):
    store.init()
    monkeypatch.setattr(main, "_build_phrases", lambda *a, **k: None)
    assert _import(_dev(), speaker=2)["status"] == "pending"


def test_unknown_topic_has_no_template():
    assert not starter.has_template("ja", "../x")


def test_finish_grants_level_two_and_equips_once():
    owner = _dev()
    snap = progression.grant_starter(owner)
    assert "face.blush_pink" in snap["owned"]
    assert snap["equipped"]["face"] == "face.blush_pink"
    assert snap["level"] == 2 and snap["xp"] == progression.xp_to_next(1)
    again = progression.grant_starter(owner)
    assert again["xp"] == snap["xp"] and again["level"] == 2
    other = next(i["id"] for i in progression._CATALOG["items"]
                 if i["slot"] == "face" and i["id"] != "face.blush_pink")
    with progression.connect() as conn:
        conn.execute("INSERT INTO owned (owner, item_id, bought_at) VALUES (?, ?, 'x')", (owner, other))
    progression.equip(owner, "face", other)
    assert progression.grant_starter(owner)["equipped"]["face"] == other


def test_upload_is_lenient_only_on_the_guides_first_greetings_take(monkeypatch, tmp_path):
    owner = _dev()
    seen = {}
    island = {"id": f"isl_{uuid.uuid4().hex}", "device": owner, "language": "ja",
              "source": "phrases", "source_name": "greetings", "lines": [{"idx": 0}]}

    async def fake_audio(*a, **k):
        return tmp_path / "ref.wav"

    def fake_clean(*a, **k):
        seen["args"] = a
        return {"score": {"words": ["ok"], "total": 50, "parts": {}}}

    monkeypatch.setattr(main, "_own_island", lambda island_id, device: island)
    monkeypatch.setattr(main, "_load_take_profile", lambda aec, device: None)
    monkeypatch.setattr(main, "_take_use_slot", lambda device, kind: None)
    monkeypatch.setattr(main, "_resolve_line_audio", fake_audio)
    monkeypatch.setattr(main, "_run_clean", fake_clean)
    monkeypatch.setattr(progression, "award_take", lambda *a, **k: None)

    def lenient(guide="1"):
        asyncio.run(main.upload_take(
            island_id=island["id"], idx=0, speed=1.0, calibrate="0", start=-1, end=-1, lag=0,
            line_start=-1, guide=guide, take=UploadFile(file=io.BytesIO(b"RIFF"), filename="t.wav"),
            authorization=AUTH, x_shadow_device=owner))
        return seen["args"][-1]

    store.init()
    island["source_name"] = "greetings"
    assert lenient() is False
    island.update(source="voice", source_name="intro")
    assert lenient() is False
    island.update(source="starter", id=f"isl_{uuid.uuid4().hex}")
    assert lenient(guide="0") is False
    island["id"] = f"isl_{uuid.uuid4().hex}"
    assert lenient() is True
    assert lenient() is False


@pytest.mark.parametrize("lang", ["ja", "en", "es"])
def test_intro_seeds_a_ready_three_line_starter_island(lang):
    store.init()
    for native, title in (("en", "First steps"), ("he", "צעדים ראשונים")):
        if native == lang:
            continue
        island = store.get_island(starter.seed_intro(_dev(), lang, native))
        assert island["status"] == "ready" and island["source"] == "starter"
        assert island["title"] == title
        assert len(island["lines"]) == 3
        for i in range(3):
            assert store.line_audio_path(island["id"], i).stat().st_size > 1000
        if lang == "ja":
            assert island["lines"][1]["ja"] == "どこの出身ですか。"


def _start(dev, language="ja", native="en", level="new"):
    return asyncio.run(main.starter_start(
        language=language, native=native, level=level, authorization=AUTH,
        x_shadow_device=dev))


def test_starter_route_is_instant_free_and_idempotent():
    store.init()
    dev = _dev()
    out = _start(dev)
    assert out["status"] == "ready"
    assert _start(dev)["id"] == out["id"]
    assert store.count_builds_today(dev, "create") == 0
    with pytest.raises(HTTPException) as err:
        _start(dev, language="en", native="en")
    assert err.value.status_code == 400


@pytest.mark.parametrize("lang", ["ja", "en", "es"])
def test_intro_some_seeds_three_longer_ready_lines(lang):
    store.init()
    island = store.get_island(starter.seed_intro(_dev(), lang, "he", "some"))
    assert island["status"] == "ready" and island["source"] == "starter"
    assert island["source_name"] == "intro-some"
    assert island["title"] == "צעדים ראשונים"
    assert len(island["lines"]) == 3
    assert all(l["words"] for l in island["lines"])
    for i in range(3):
        assert store.line_audio_path(island["id"], i).stat().st_size > 1000
    if lang == "ja":
        assert island["lines"][0]["ja"] == "駅までの道を教えてもらえますか。"
    assert island["lines"][0]["en"] and not island["lines"][0]["en"].isascii()


def test_starter_route_level_some_is_idempotent_per_level_and_rejects_a_bad_level():
    store.init()
    dev = _dev()
    some = _start(dev, level="some")
    assert some["status"] == "ready"
    assert _start(dev, level="some")["id"] == some["id"]
    assert store.get_island(some["id"])["source_name"] == "intro-some"
    # The other pick seeds its own island; each level stays idempotent.
    new = _start(dev)
    assert new["id"] != some["id"]
    assert store.get_island(new["id"])["source_name"] == "intro"
    assert _start(dev)["id"] == new["id"]
    assert store.count_builds_today(dev, "create") == 0
    with pytest.raises(HTTPException) as err:
        _start(dev, level="hard")
    assert err.value.status_code == 400


def test_starter_route_replaces_a_stale_island_and_keeps_other_islands():
    store.init()
    dev = _dev()
    out = _start(dev)
    other = starter.seed_topic(dev, "ja", "en", "greetings", voices.default_speaker("ja"))
    with store.connect() as conn:
        conn.execute("UPDATE lines SET ja='ありがとう' WHERE island_id=? AND idx=1", (out["id"],))
    again = _start(dev)
    assert again["id"] != out["id"]
    assert store.get_island(out["id"]) is None
    assert store.get_island(other) is not None
    fresh = store.get_island(again["id"])
    assert fresh["lines"][1]["ja"] == "どこの出身ですか。"
    assert _start(dev)["id"] == again["id"]
    assert len([i for i in store.list_islands(dev) if i["source"] == "starter"]) == 1
