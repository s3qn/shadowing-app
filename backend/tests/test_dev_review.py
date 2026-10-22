"""Dev review tour routes, called directly (no TestClient)."""

import json

import pytest
from fastapi import HTTPException

import dev_review
import main

AUTH = "Bearer t0k"


@pytest.fixture(autouse=True)
def env(monkeypatch, tmp_path):
    monkeypatch.setenv("SHADOW_TOKEN", "t0k")
    monkeypatch.setenv("SHADOW_REVIEW_FILE", str(tmp_path / "current.json"))
    return tmp_path


def _write_tour(tmp_path):
    (tmp_path / "current.json").write_text(
        json.dumps({"wave": "w1", "steps": [{"id": "a", "title": "A"}, {"id": "b", "title": "B"}]})
    )


def test_get_404_when_missing():
    with pytest.raises(HTTPException) as e:
        dev_review.get_review(AUTH)
    assert e.value.status_code == 404


def test_get_merges_last_verdict(env):
    _write_tour(env)
    dev_review.post_verdict(dev_review.VerdictBody(wave="w1", id="a", verdict="accept"), AUTH)
    dev_review.post_verdict(dev_review.VerdictBody(wave="w1", id="a", verdict="fix", chips=["bug"]), AUTH)
    steps = dev_review.get_review(AUTH)["steps"]
    assert steps[0]["verdict"] == "fix"
    assert steps[0]["vchips"] == ["bug"]
    assert steps[1]["verdict"] is None


def test_post_rejects_bad_verdict():
    with pytest.raises(ValueError):
        dev_review.VerdictBody(wave="w1", id="a", verdict="maybe")


def test_routes_need_token():
    with pytest.raises(HTTPException) as e:
        dev_review.get_review(None)
    assert e.value.status_code == 401
    with pytest.raises(HTTPException):
        dev_review.post_verdict(dev_review.VerdictBody(wave="w", id="a", verdict="fix"), "Bearer no")


def test_enabled_off_in_prod(monkeypatch):
    monkeypatch.setenv("SHADOW_ENV", "prod")
    assert not dev_review.enabled()
    monkeypatch.setenv("SHADOW_ENV", "dev")
    assert dev_review.enabled()


def test_voice_saves_file_and_keeps_verdict(env):
    import asyncio
    import io

    from starlette.datastructures import UploadFile

    _write_tour(env)
    dev_review.post_verdict(dev_review.VerdictBody(wave="w1", id="a", verdict="fix"), AUTH)
    up = UploadFile(io.BytesIO(b"abc"), filename="n.m4a")
    res = asyncio.run(dev_review.post_voice("W 1", "a/../b", up, AUTH))
    assert (env / "voice" / res["voice"]).read_bytes() == b"abc"
    assert res["voice"].startswith("w-1-a----b-")
    assert dev_review.get_review(AUTH)["steps"][0]["verdict"] == "fix"
    with pytest.raises(HTTPException):
        asyncio.run(dev_review.post_voice("w1", "a", up, None))


def test_shot_saved_and_skipped_in_merge(env):
    import asyncio
    import io

    from starlette.datastructures import UploadFile as Up

    _write_tour(env)
    up = Up(io.BytesIO(b"\xff\xd8jpg"), filename="s.jpg")
    out = asyncio.run(dev_review.post_shot("w1", "A/../b", up, AUTH))
    assert out["shot"].startswith("w1-a----b-") and out["shot"].endswith(".jpg")
    assert (env / "shots" / out["shot"]).read_bytes() == b"\xff\xd8jpg"
    assert json.loads((env / "verdicts.jsonl").read_text().splitlines()[-1])["shot"] == out["shot"]
    assert all(s["verdict"] is None for s in dev_review.get_review(AUTH)["steps"])
    with pytest.raises(HTTPException):
        asyncio.run(dev_review.post_shot("w1", "a", up, "Bearer no"))


def test_done_appends_one_line_each_press_and_skipped_in_merge(env):
    _write_tour(env)
    dev_review.post_verdict(dev_review.VerdictBody(wave="w1", id="a", verdict="fix"), AUTH)
    dev_review.post_done(dev_review.DoneBody(wave="w1"), AUTH)
    dev_review.post_done(dev_review.DoneBody(wave="w1"), AUTH)
    rows = [json.loads(x) for x in (env / "verdicts.jsonl").read_text().splitlines()]
    done = [r for r in rows if r.get("done")]
    assert len(done) == 2
    assert set(done[0]) == {"wave", "done", "ts"} and done[0]["wave"] == "w1" and done[0]["done"] is True
    steps = dev_review.get_review(AUTH)["steps"]
    assert steps[0]["verdict"] == "fix" and steps[1]["verdict"] is None
    with pytest.raises(HTTPException) as e:
        dev_review.post_done(dev_review.DoneBody(wave="w1"), "Bearer no")
    assert e.value.status_code == 401


def test_done_route_absent_in_prod(monkeypatch):
    # main mounts the router only when enabled(), so prod has no route (404).
    monkeypatch.setenv("SHADOW_ENV", "prod")
    assert not dev_review.enabled()
    assert "/shadow/dev/review/done" in [r.path for r in dev_review.router.routes]


def test_dev_coins_grants_in_dev_and_404_in_prod(monkeypatch):
    import asyncio

    monkeypatch.setattr(main, "SHADOW_TOKEN", "t0k")
    body = main.DevCoinsBody(amount=500)
    dev = "dec0ffee-1234"
    before = main.progression.snapshot(dev)["coins"]
    out = asyncio.run(main.dev_coins(body, AUTH, dev))
    assert out["coins"] == before + 500
    monkeypatch.setenv("SHADOW_ENV", "prod")
    with pytest.raises(HTTPException) as e:
        asyncio.run(main.dev_coins(body, AUTH, dev))
    assert e.value.status_code == 404


def test_dev_coins_clear_freezes_lets_a_test_buy_again(monkeypatch):
    import asyncio

    monkeypatch.setattr(main, "SHADOW_TOKEN", "t0k")
    dev = "dec0ffee-5678"
    main.progression.grant_coins(dev, 10_000)
    cap = main.progression.snapshot(dev)["freeze_cap"]
    for i in range(cap):
        main.progression.buy_freeze(dev, f"p{i}")
    assert main.progression.snapshot(dev)["freezes_held"] == cap
    out = asyncio.run(main.dev_coins(main.DevCoinsBody(amount=1, clear_freezes=True), AUTH, dev))
    assert out["freezes_held"] == 0
