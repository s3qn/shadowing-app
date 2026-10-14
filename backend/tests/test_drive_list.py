"""GET /shadow/islands reports has_audio so Drive Mode can skip islands with no
per-line audio (caption-only YouTube islands)."""

from fastapi.testclient import TestClient

import main
import store

AUTH = f"Bearer {main.SHADOW_TOKEN}"
DEV = "eeeeeeee-0000-4000-8000-000000000005"

client = TestClient(main.app)


def test_list_islands_reports_has_audio():
    with_audio = store.create_island("with audio", 1, device=DEV)
    without = store.create_island("captions only", 1, device=DEV)
    folder = store.AUDIO_DIR / with_audio
    folder.mkdir(parents=True, exist_ok=True)
    (folder / "0.wav").write_bytes(b"RIFF")
    resp = client.get("/shadow/islands", headers={"Authorization": AUTH, "X-Shadow-Device": DEV})
    assert resp.status_code == 200
    by_id = {r["id"]: r for r in resp.json()}
    assert by_id[with_audio]["has_audio"] is True
    assert by_id[without]["has_audio"] is False
