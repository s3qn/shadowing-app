"""Tests for main._write_atomic and line_audio._cached_transform: the file IO and
slice/pad work the line audio route now runs through asyncio.to_thread
instead of on the event loop (see D1 in the pipe declogger ledger).
Importing main starts nothing: no server, no VOICEVOX, no whisper model
(see test_span.py)."""

import asyncio
import threading

import pytest

from services import line_audio


def test_write_atomic_concurrent_writers_do_not_collide_on_the_tmp_name(tmp_path):
    """Two threads writing the same dest at once (two requests racing to
    render the same line) must each get their own tmp file. A fixed
    `path.with_suffix(".tmp")` lets one thread's write_bytes clobber or
    truncate the other's tmp file before either renames."""
    dest = tmp_path / "out.wav"
    payload_a = b"a" * 200_000
    payload_b = b"b" * 200_000
    errors = []

    def write(data):
        try:
            line_audio._write_atomic(dest, data)
        except Exception as exc:  # pragma: no cover - surfaced via errors
            errors.append(exc)

    t1 = threading.Thread(target=write, args=(payload_a,))
    t2 = threading.Thread(target=write, args=(payload_b,))
    t1.start()
    t2.start()
    t1.join()
    t2.join()

    assert not errors
    # Whichever thread renamed last wins, but the result must be exactly one
    # writer's full payload, never a mix of both, and no leftover tmp files.
    assert dest.read_bytes() in (payload_a, payload_b)
    assert list(tmp_path.glob("*.tmp")) == []


def test_write_atomic_writes_bytes_and_leaves_no_tmp_file(tmp_path):
    dest = tmp_path / "out.wav"

    line_audio._write_atomic(dest, b"hello")

    assert dest.read_bytes() == b"hello"
    assert not dest.with_suffix(".tmp").exists()


def test_cached_transform_writes_the_transform_of_the_source(tmp_path):
    src = tmp_path / "src.wav"
    src.write_bytes(b"raw-audio")
    dest = tmp_path / "sliced.wav"

    line_audio._cached_transform(src, dest, lambda data: data.upper())

    assert dest.read_bytes() == b"RAW-AUDIO"


def test_cached_transform_skips_the_transform_when_dest_already_exists(tmp_path):
    src = tmp_path / "src.wav"
    src.write_bytes(b"raw-audio")
    dest = tmp_path / "sliced.wav"
    dest.write_bytes(b"already-there")

    calls = []
    line_audio._cached_transform(src, dest, lambda data: calls.append(data) or data)

    # The cache hit must not even read the source, matching the original
    # `if not sliced.exists(): ...` gate this replaced.
    assert calls == []
    assert dest.read_bytes() == b"already-there"


def test_cached_transform_propagates_a_transform_error(tmp_path):
    src = tmp_path / "src.wav"
    src.write_bytes(b"raw-audio")
    dest = tmp_path / "sliced.wav"

    def boom(data):
        raise ValueError("bad span")

    with pytest.raises(ValueError):
        line_audio._cached_transform(src, dest, boom)

    # A failed transform must not leave a partial file behind for a later
    # request to serve as if it were valid.
    assert not dest.exists()


def test_cached_transform_runs_cleanly_off_the_event_loop(tmp_path):
    """The whole point of the helper: it must be safe to hand to
    asyncio.to_thread, i.e. it must not touch the event loop itself."""
    src = tmp_path / "src.wav"
    src.write_bytes(b"raw-audio")
    dest = tmp_path / "sliced.wav"

    async def run():
        await asyncio.to_thread(line_audio._cached_transform, src, dest, lambda d: d[::-1])

    asyncio.run(run())

    assert dest.read_bytes() == b"oidua-war"


def test_non_native_speed_voice_stretches_the_island_wav_without_the_provider(tmp_path, monkeypatch):
    """A Kokoro (or hosted) island at 0.8 is the island's own 1.0 wav slowed
    down; only VOICEVOX re-renders at speed."""
    import shutil

    import store
    import voices

    store.init()
    island_id = store.create_island("simple", 10011, register="polite", language="es")
    (store.AUDIO_DIR / island_id).mkdir(parents=True, exist_ok=True)
    store.add_line(island_id, 0, {"ja": "Hola", "kana": "", "romaji": "", "en": "Hi"}, 1.0, [], [])
    store.line_audio_path(island_id, 0).write_bytes(b"RIFF-base")
    stretched = []

    def fake_stretch(src, dst, speed):
        stretched.append(speed)
        shutil.copy(src, dst)
        return True

    async def never(*a, **k):
        raise AssertionError("the provider must not be called for a speed variant")

    monkeypatch.setattr(line_audio.media_io, "_stretch", fake_stretch)
    monkeypatch.setattr(voices, "speak", never)
    monkeypatch.setattr(voices, "render", never)

    path = asyncio.run(line_audio._resolve_line_audio({"id": island_id}, 0, 0.8))

    assert stretched == [0.8]
    assert path.name == "0@0.80.wav"
    assert path.read_bytes() == b"RIFF-base"
