import asyncio
import threading
import time

import generate
import main
import store


def test_parallel_translation_keeps_order_and_saves_each_batch(monkeypatch):
    texts = [f"t{i}" for i in range(generate.TRANSLATE_BATCH * 3 + 5)]
    saved: dict[int, str] = {}
    live = {"now": 0, "max": 0}
    lock = threading.Lock()

    def fake(batch, language, native, before=None, after=None):
        with lock:
            live["now"] += 1
            live["max"] = max(live["max"], live["now"])
        time.sleep(0.05 if batch[0] == "t0" else 0.01)  # first batch lands last
        with lock:
            live["now"] -= 1
        return [f"en-{t}" for t in batch]

    monkeypatch.setattr(generate, "translate_lines", fake)
    monkeypatch.setattr(store, "set_en", lambda iid, idx, en: saved.__setitem__(idx, en))
    asyncio.run(main._translate_batches("x", texts, "ja", "en"))
    assert saved == {i: f"en-t{i}" for i in range(len(texts))}
    assert 1 < live["max"] <= main.TRANSLATE_WORKERS


def test_failed_batch_keeps_the_others(monkeypatch):
    texts = [f"t{i}" for i in range(generate.TRANSLATE_BATCH * 2)]
    saved: dict[int, str] = {}

    def fake(batch, language, native, before=None, after=None):
        if batch[0] == "t0":
            raise RuntimeError("boom")
        return ["en"] * len(batch)

    monkeypatch.setattr(generate, "translate_lines", fake)
    monkeypatch.setattr(store, "set_en", lambda iid, idx, en: saved.__setitem__(idx, en))
    try:
        asyncio.run(main._translate_batches("x", texts, "ja", "en"))
        raise AssertionError("expected the error")
    except RuntimeError:
        pass
    assert sorted(saved) == list(range(generate.TRANSLATE_BATCH, len(texts)))
