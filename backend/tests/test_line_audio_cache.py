"""Tests for main._write_atomic and main._cached_transform: the file IO and
slice/pad work the line audio route now runs through asyncio.to_thread
instead of on the event loop (see D1 in the pipe declogger ledger).
Importing main starts nothing: no server, no VOICEVOX, no whisper model
(see test_span.py)."""

import asyncio
import threading

import pytest

import main


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
            main._write_atomic(dest, data)
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

    main._write_atomic(dest, b"hello")

    assert dest.read_bytes() == b"hello"
    assert not dest.with_suffix(".tmp").exists()


def test_cached_transform_writes_the_transform_of_the_source(tmp_path):
    src = tmp_path / "src.wav"
    src.write_bytes(b"raw-audio")
    dest = tmp_path / "sliced.wav"

    main._cached_transform(src, dest, lambda data: data.upper())

    assert dest.read_bytes() == b"RAW-AUDIO"


def test_cached_transform_skips_the_transform_when_dest_already_exists(tmp_path):
    src = tmp_path / "src.wav"
    src.write_bytes(b"raw-audio")
    dest = tmp_path / "sliced.wav"
    dest.write_bytes(b"already-there")

    calls = []
    main._cached_transform(src, dest, lambda data: calls.append(data) or data)

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
        main._cached_transform(src, dest, boom)

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
        await asyncio.to_thread(main._cached_transform, src, dest, lambda d: d[::-1])

    asyncio.run(run())

    assert dest.read_bytes() == b"oidua-war"
