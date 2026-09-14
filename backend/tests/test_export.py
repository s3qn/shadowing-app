"""Tests for the pure logic in export.py: normalise, assemble_wav, cache_key,
export_path, clear_exports, file_name, and encode_m4a (skipped if ffmpeg is
not installed).

Never touches the real islands: conftest.py points SHADOW_DATA_DIR at a
throwaway directory before store (and therefore export) is imported.
"""

import io
import shutil
import subprocess
import wave

import pytest

import export
import store


# ---------------------------------------------------------------------------
# helpers
# ---------------------------------------------------------------------------

def _make_wav(framerate: int, nchannels: int, sampwidth: int, duration_ms: int) -> bytes:
    nframes = round(framerate * duration_ms / 1000)
    # A non-zero pattern, so "the original frames are a prefix" is a real check
    # and a run of the same byte silence would not also pass it.
    frame = bytes((i % 250) + 1 for i in range(sampwidth * nchannels))
    out = io.BytesIO()
    with wave.open(out, "wb") as w:
        w.setnchannels(nchannels)
        w.setsampwidth(sampwidth)
        w.setframerate(framerate)
        w.writeframes(frame * nframes)
    return out.getvalue()


def _island(speaker=3, lines=None):
    if lines is None:
        lines = [{"idx": 0, "ja": "おはよう"}, {"idx": 1, "ja": "こんにちは"}]
    return {"speaker": speaker, "lines": lines}


# ---------------------------------------------------------------------------
# normalise
# ---------------------------------------------------------------------------

def test_normalise_clamps_and_rounds_high():
    assert export.normalise(0.72, 9, 99999) == export.Spec(0.7, 4, 5000)


def test_normalise_clamps_low():
    assert export.normalise(0.1, 0, -5) == export.Spec(0.5, 1, 0)


def test_normalise_leaves_in_range_values_unchanged():
    assert export.normalise(1.0, 2, 2000) == export.Spec(1.0, 2, 2000)


# ---------------------------------------------------------------------------
# assemble_wav
# ---------------------------------------------------------------------------

def test_assemble_wav_layout():
    wav_a = _make_wav(24000, 1, 2, 100)
    wav_b = _make_wav(24000, 1, 2, 100)
    spec = export.Spec(1.0, 2, 200, lead_ms=500)

    out = export.assemble_wav([wav_a, wav_b], spec)

    with wave.open(io.BytesIO(wav_a)) as src:
        line_frames = src.readframes(src.getnframes())
    frame_size = 1 * 2

    with wave.open(io.BytesIO(out)) as dst:
        params = dst.getparams()
        assert params.nchannels == 1
        assert params.sampwidth == 2
        assert params.framerate == 24000
        total_frames = dst.readframes(dst.getnframes())

    lead_frames = 12000  # 500ms @ 24000
    play_frames = 2400  # 100ms @ 24000
    gap_frames = 4800  # 200ms @ 24000

    expected_total = lead_frames + 2 * 2 * (play_frames + gap_frames)
    assert len(total_frames) // frame_size == expected_total

    def region(start_frame, nframes):
        return total_frames[start_frame * frame_size: (start_frame + nframes) * frame_size]

    # lead is silence
    assert region(0, lead_frames) == b"\x00" * (lead_frames * frame_size)

    # first line, first play
    off = lead_frames
    assert region(off, play_frames) == line_frames
    off += play_frames
    # gap after first play
    assert region(off, gap_frames) == b"\x00" * (gap_frames * frame_size)
    off += gap_frames
    # first line, second play
    assert region(off, play_frames) == line_frames
    off += play_frames
    assert region(off, gap_frames) == b"\x00" * (gap_frames * frame_size)
    off += gap_frames

    # second line starts right after, at lead + 2 * (play + gap)
    assert off == lead_frames + 2 * (play_frames + gap_frames)
    assert region(off, play_frames) == line_frames


def test_assemble_wav_plain_concatenation_with_no_repeats_gap_or_lead():
    wav_a = _make_wav(24000, 1, 2, 50)
    wav_b = _make_wav(24000, 1, 2, 50)
    spec = export.Spec(1.0, 1, 0, lead_ms=0)

    out = export.assemble_wav([wav_a, wav_b], spec)

    with wave.open(io.BytesIO(wav_a)) as src:
        frames_a = src.readframes(src.getnframes())
    with wave.open(io.BytesIO(wav_b)) as src:
        frames_b = src.readframes(src.getnframes())

    with wave.open(io.BytesIO(out)) as dst:
        total = dst.readframes(dst.getnframes())

    assert total == frames_a + frames_b


def test_assemble_wav_empty_list_raises():
    with pytest.raises(export.ExportError):
        export.assemble_wav([], export.Spec(1.0, 1, 0))


def test_assemble_wav_mismatched_rate_raises():
    wav_a = _make_wav(24000, 1, 2, 100)
    wav_b = _make_wav(44100, 1, 2, 100)
    with pytest.raises(export.ExportError):
        export.assemble_wav([wav_a, wav_b], export.Spec(1.0, 1, 0))


# ---------------------------------------------------------------------------
# cache_key
# ---------------------------------------------------------------------------

def test_cache_key_is_12_hex_chars():
    key = export.cache_key(_island(), export.Spec(0.7, 2, 2000))
    assert len(key) == 12
    int(key, 16)  # raises if not hex


def test_cache_key_stable_for_same_input():
    spec = export.Spec(0.7, 2, 2000)
    assert export.cache_key(_island(), spec) == export.cache_key(_island(), spec)


def test_cache_key_changes_with_speaker():
    spec = export.Spec(0.7, 2, 2000)
    a = export.cache_key(_island(speaker=3), spec)
    b = export.cache_key(_island(speaker=8), spec)
    assert a != b


def test_cache_key_changes_with_line_text():
    spec = export.Spec(0.7, 2, 2000)
    a = export.cache_key(_island(), spec)
    b = export.cache_key(
        _island(lines=[{"idx": 0, "ja": "おはよう!"}, {"idx": 1, "ja": "こんにちは"}]),
        spec,
    )
    assert a != b


def test_cache_key_changes_when_lines_swap_order():
    spec = export.Spec(0.7, 2, 2000)
    a = export.cache_key(_island(), spec)
    b = export.cache_key(
        _island(lines=[{"idx": 1, "ja": "こんにちは"}, {"idx": 0, "ja": "おはよう"}]),
        spec,
    )
    assert a != b


def test_cache_key_changes_with_speed_repeats_or_gap():
    base = export.cache_key(_island(), export.Spec(0.7, 2, 2000))
    assert base != export.cache_key(_island(), export.Spec(0.8, 2, 2000))
    assert base != export.cache_key(_island(), export.Spec(0.7, 3, 2000))
    assert base != export.cache_key(_island(), export.Spec(0.7, 2, 1000))


# ---------------------------------------------------------------------------
# export_path / clear_exports
# ---------------------------------------------------------------------------

def test_export_path_lands_under_audio_dir():
    assert export.export_path("abc", "0123456789ab") == (
        store.AUDIO_DIR / "abc" / "export-0123456789ab.m4a"
    )


def test_clear_exports_removes_only_export_files():
    iid = "island-clear-exports"
    folder = store.AUDIO_DIR / iid
    folder.mkdir(parents=True, exist_ok=True)
    (folder / "0.wav").write_bytes(b"x")
    (folder / "export-aaaaaaaaaaaa.m4a").write_bytes(b"x")
    (folder / "export-bbbbbbbbbbbb.tmp.m4a").write_bytes(b"x")

    export.clear_exports(iid)

    remaining = sorted(p.name for p in folder.iterdir())
    assert remaining == ["0.wav"]


def test_clear_exports_missing_folder_does_not_raise():
    export.clear_exports("no-such-island")


# ---------------------------------------------------------------------------
# file_name
# ---------------------------------------------------------------------------

def test_file_name_strips_unsafe_characters():
    assert export.file_name("Morning: coffee/tea?", 0.7) == "Morning coffee tea 0.70x.m4a"


def test_file_name_empty_falls_back_to_island():
    assert export.file_name("", 1.0) == "Island 1.00x.m4a"


def test_file_name_cuts_long_titles_to_60_chars():
    title = "a" * 100
    name = export.file_name(title, 0.85)
    assert name == ("a" * 60) + " 0.85x.m4a"


def test_file_name_keeps_japanese():
    assert export.file_name("朝のコーヒー", 0.85) == "朝のコーヒー 0.85x.m4a"


# ---------------------------------------------------------------------------
# encode_m4a
# ---------------------------------------------------------------------------

@pytest.mark.skipif(shutil.which("ffmpeg") is None, reason="ffmpeg not installed")
def test_encode_m4a_produces_a_playable_m4a(tmp_path):
    wav = export.assemble_wav(
        [_make_wav(24000, 1, 2, 100)], export.Spec(1.0, 1, 0, lead_ms=0)
    )
    dst = tmp_path / "export-x.m4a"

    export.encode_m4a(wav, dst, "テスト")

    assert dst.exists()
    data = dst.read_bytes()
    assert len(data) > 200
    assert data[4:8] == b"ftyp"
    assert sorted(p.name for p in tmp_path.iterdir()) == ["export-x.m4a"]


def test_encode_m4a_unwritable_destination_raises(tmp_path, monkeypatch):
    wav = export.assemble_wav(
        [_make_wav(24000, 1, 2, 100)], export.Spec(1.0, 1, 0, lead_ms=0)
    )
    bad_dir = tmp_path / "no-such-dir"
    dst = bad_dir / "export-x.m4a"

    with pytest.raises(export.ExportError):
        export.encode_m4a(wav, dst, "title")


def test_encode_m4a_missing_ffmpeg_raises(tmp_path, monkeypatch):
    wav = export.assemble_wav(
        [_make_wav(24000, 1, 2, 100)], export.Spec(1.0, 1, 0, lead_ms=0)
    )
    monkeypatch.setattr(export, "FFMPEG", "/nonexistent/ffmpeg")
    dst = tmp_path / "export-x.m4a"

    with pytest.raises(export.ExportError):
        export.encode_m4a(wav, dst, "title")


def _fake_ffmpeg(calls, fail=False):
    """Stands in for subprocess.run: records the tmp paths ffmpeg was handed
    and writes a partial output file, then optionally fails like ffmpeg."""
    def run(args, **kwargs):
        tmp_wav = args[args.index("-i") + 1]
        tmp_m4a = args[-1]
        calls.append((tmp_wav, tmp_m4a))
        with open(tmp_m4a, "wb") as f:
            f.write(b"partial")
        if fail:
            raise subprocess.CalledProcessError(
                1, args, stderr=b"/home/secret/path: Invalid data found"
            )
    return run


def test_encode_m4a_uses_unique_tmp_names_per_call(tmp_path, monkeypatch):
    wav = export.assemble_wav(
        [_make_wav(24000, 1, 2, 100)], export.Spec(1.0, 1, 0, lead_ms=0)
    )
    calls = []
    monkeypatch.setattr(export.subprocess, "run", _fake_ffmpeg(calls))
    dst = tmp_path / "export-x.m4a"

    export.encode_m4a(wav, dst, "title")
    export.encode_m4a(wav, dst, "title")

    (wav_a, m4a_a), (wav_b, m4a_b) = calls
    assert wav_a != wav_b
    assert m4a_a != m4a_b
    for name in (wav_a, m4a_a, wav_b, m4a_b):
        assert name != str(dst)
        assert name.startswith(str(tmp_path / "export-x."))
    assert sorted(p.name for p in tmp_path.iterdir()) == ["export-x.m4a"]


def test_encode_m4a_ffmpeg_failure_cleans_up_and_hides_stderr(tmp_path, monkeypatch):
    wav = export.assemble_wav(
        [_make_wav(24000, 1, 2, 100)], export.Spec(1.0, 1, 0, lead_ms=0)
    )
    calls = []
    monkeypatch.setattr(export.subprocess, "run", _fake_ffmpeg(calls, fail=True))
    dst = tmp_path / "export-x.m4a"

    with pytest.raises(export.ExportError) as info:
        export.encode_m4a(wav, dst, "title")

    assert "/home/secret" not in str(info.value)
    assert list(tmp_path.iterdir()) == []
