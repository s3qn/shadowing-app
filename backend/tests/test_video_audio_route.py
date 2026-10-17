"""The video-audio route, the videos migration and main._align_one, with the
aligner subprocess and ffmpeg monkeypatched. Throwaway data dir only."""

import asyncio
import io
import wave

import pytest
from fastapi.testclient import TestClient

import align
import main
import store

DEV = "dddddddd-0000-4000-8000-0000000000a1"
OTHER = "dddddddd-0000-4000-8000-0000000000a2"
HEAD = {"Authorization": "Bearer test-token", "X-Shadow-Device": DEV}

client = TestClient(main.app)


@pytest.fixture(autouse=True)
def _init_db():
    store.init()


def make_video(language="ja", ready=True, texts=("こんにちは", "元気ですか")):
    island_id = store.create_island("simple", 3, language=language, source="youtube",
                                    source_name="abc", device=DEV)
    store.add_video(island_id, "abc", 0.0, "t", "")
    for i, text in enumerate(texts):
        store.add_line(island_id, i, {"ja": text}, 2.0, [], [{"text": text, "start": 0, "end": 2}],
                       offset=1.0 + i * 2.2)
    if ready:
        store.set_ready(island_id, "t")
    return island_id


def post(island_id, data=b"audio-bytes", headers=HEAD):
    return client.post(f"/shadow/islands/{island_id}/video-audio", headers=headers,
                       files={"audio": ("a.m4a", io.BytesIO(data), "audio/mp4")})


def test_migration_is_additive_and_idempotent():
    store.init()
    store.init()
    with store.connect() as conn:
        cols = {r["name"] for r in conn.execute("PRAGMA table_info(videos)")}
    assert {"align_status", "align_error", "align_attempts"} <= cols


def test_route_queues_and_stores_file():
    island_id = make_video()
    resp = post(island_id)
    assert resp.status_code == 200 and resp.json() == {"align": "queued"}
    assert store.video_audio_path(island_id, "src").read_bytes() == b"audio-bytes"
    video = client.get(f"/shadow/islands/{island_id}/video", headers=HEAD).json()
    assert video["align"] == "queued" and video["align_error"] == ""
    store.video_audio_path(island_id, "src").unlink()


def test_route_rejections():
    island_id = make_video()
    assert client.post(f"/shadow/islands/{island_id}/video-audio",
                       files={"audio": ("a", b"x")}).status_code in (401, 503)
    assert post(island_id, headers={**HEAD, "X-Shadow-Device": OTHER}).status_code == 404
    assert post(island_id, data=b"").status_code == 400
    voice = store.create_island("simple", 3, device=DEV)
    assert post(voice).json()["detail"] == {"code": "not_video"}
    assert post(island_id).status_code == 200
    assert post(island_id).json()["detail"] == {"code": "align_busy"}
    store.set_align_status(island_id, "done")
    assert post(island_id).json()["detail"] == {"code": "align_closed"}
    store.video_audio_path(island_id, "src").unlink(missing_ok=True)


def test_route_attempt_limit_and_size(monkeypatch):
    island_id = make_video()
    for _ in range(main.ALIGN_MAX_ATTEMPTS):
        store.set_align_status(island_id, "failed", "x", count_attempt=True)
    assert post(island_id).status_code == 409
    other = make_video()
    monkeypatch.setattr(main, "VIDEO_AUDIO_MAX_BYTES", 4)
    resp = post(other, data=b"too big for the cap")
    assert resp.status_code == 413
    assert not store.video_audio_path(other, "src").exists()
    video = store.get_video(other)
    assert (video["align_status"], video["align_attempts"]) == ("", 0)


def test_failed_upload_reverts_claim():
    island_id = make_video()
    store.set_align_status(island_id, "failed", "align_oom", count_attempt=True)
    assert post(island_id, data=b"").status_code == 400
    video = store.get_video(island_id)
    assert (video["align_status"], video["align_error"], video["align_attempts"]) == ("failed", "align_oom", 1)


def test_claim_is_single_winner():
    island_id = make_video()
    assert store.claim_align(island_id, main.ALIGN_MAX_ATTEMPTS)
    assert not store.claim_align(island_id, main.ALIGN_MAX_ATTEMPTS)
    assert store.get_video(island_id)["align_status"] == "queued"
    store.set_align_status(island_id, "failed")


def test_video_reports_closed_after_last_attempt():
    island_id = make_video()
    get = lambda: client.get(f"/shadow/islands/{island_id}/video", headers=HEAD).json()
    for n in range(main.ALIGN_MAX_ATTEMPTS):
        store.set_align_status(island_id, "failed", "x", count_attempt=True)
        assert get()["align"] == ("closed" if n + 1 == main.ALIGN_MAX_ATTEMPTS else "failed")
    assert "align_attempts" not in get()


def test_startup_stops_leftover_scopes_before_requeue(monkeypatch):
    order = []
    monkeypatch.setattr(align, "stop_leftover_scopes", lambda: order.append("stop"))
    monkeypatch.setattr(main, "_align_recover", lambda: order.append("recover"))
    monkeypatch.setattr(main, "_align_consumer", lambda: asyncio.sleep(0))
    asyncio.run(main._align_startup())
    assert order == ["stop", "recover"]


def fake_wav(src, dst, max_seconds=None):
    with wave.open(str(dst), "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(16000)
        w.writeframes(b"\x00\x00" * 16000 * 30)
    return True


def run_align(island_id):
    asyncio.run(main._align_one(island_id))


def stage_upload(island_id):
    store.video_audio_path(island_id, "src").write_bytes(b"x")
    store.set_align_status(island_id, "queued", count_attempt=True)


def test_align_one_updates_guarded_lines(monkeypatch):
    island_id = make_video()
    stage_upload(island_id)
    monkeypatch.setattr(main, "_to_wav", fake_wav)

    def fake_run(job, out, **kw):
        assert kw["unit"] == island_id
        # line 0 agrees with its caption span, line 1 drifts by 5 s
        return {"windows": [{"id": 0, "pieces": [
            {"text": "こんにちは", "start": 1.3, "end": 2.8},
            {"text": "元気", "start": 8.0, "end": 8.5},
            {"text": "ですか", "start": 8.5, "end": 9.2},
        ]}], "errors": [], "peak_rss_mb": 1}

    monkeypatch.setattr(align, "run_job", fake_run)
    before = store.get_island(island_id)["lines"]
    run_align(island_id)
    after = store.get_island(island_id)["lines"]
    assert after[0]["offset"] == pytest.approx(1.2)
    assert after[0]["words"] != before[0]["words"]
    assert after[1]["offset"] == before[1]["offset"]
    assert after[1]["words"] == before[1]["words"]
    video = store.get_video(island_id)
    assert video["align_status"] == "done"
    assert not store.video_audio_path(island_id, "src").exists()
    assert not store.video_audio_path(island_id, "wav").exists()


def test_align_one_respects_expected_guard(monkeypatch):
    island_id = make_video()
    stage_upload(island_id)
    monkeypatch.setattr(main, "_to_wav", fake_wav)

    def fake_run(job, out, **kw):
        store.set_words(island_id, 0, [{"text": "changed", "start": 0, "end": 1}])
        return {"windows": [{"id": 0, "pieces": [{"text": "こんにちは", "start": 1.3, "end": 2.8}]}]}

    monkeypatch.setattr(align, "run_job", fake_run)
    run_align(island_id)
    lines = store.get_island(island_id)["lines"]
    assert lines[0]["words"][0]["text"] == "changed"
    assert lines[0]["offset"] == 1.0


def test_align_one_failure_keeps_words(monkeypatch):
    island_id = make_video()
    stage_upload(island_id)
    monkeypatch.setattr(main, "_to_wav", fake_wav)

    def boom(job, out, **kw):
        raise align.AlignError("align_oom")

    monkeypatch.setattr(align, "run_job", boom)
    before = store.get_island(island_id)["lines"]
    run_align(island_id)
    assert store.get_island(island_id)["lines"] == before
    video = store.get_video(island_id)
    assert (video["align_status"], video["align_error"]) == ("failed", "align_oom")
    assert not store.video_audio_path(island_id, "src").exists()


def test_align_one_decode_failure(monkeypatch):
    island_id = make_video()
    stage_upload(island_id)
    monkeypatch.setattr(main, "_to_wav", lambda *a, **k: False)
    run_align(island_id)
    assert store.get_video(island_id)["align_error"] == "align_decode"


def test_recovery_requeues_or_fails():
    kept = make_video()
    lost = make_video()
    for island_id in (kept, lost):
        store.set_align_status(island_id, "running")
    store.video_audio_path(kept, "src").write_bytes(b"x")
    store.video_audio_path(lost, "src").unlink(missing_ok=True)
    main._align_recover()
    assert store.get_video(kept)["align_status"] == "queued"
    video = store.get_video(lost)
    assert (video["align_status"], video["align_error"]) == ("failed", "align_interrupted")
    store.video_audio_path(kept, "src").unlink()
    store.set_align_status(kept, "failed")
