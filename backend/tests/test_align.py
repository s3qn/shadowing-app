"""Pure logic of align.py: windows, mapping pieces to lines, retiming, the
worker command line. No model, no ffmpeg, no network."""

import json
import subprocess

import pytest

import align


def line(idx, text, offset, duration):
    return {"idx": idx, "text": text, "offset": offset, "duration": duration, "words": []}


def piece(text, start, end):
    return {"text": text, "start": start, "end": end}


# --- windows ---

def test_windows_group_close_lines_and_pad():
    lines = [line(0, "こんにちは", 1.0, 2.0), line(1, "元気ですか", 3.5, 2.0)]
    (w,) = align.windows_from_lines(lines, 100.0)
    assert w["line_idx"] == [0, 1]
    assert w["start"] == 0.5 and w["end"] == 6.0
    assert w["text"] == "こんにちは 元気ですか"


def test_windows_split_on_gap():
    lines = [line(0, "あ", 0.0, 1.0), line(1, "い", 3.5, 1.0)]
    windows = align.windows_from_lines(lines, 100.0)
    assert [w["line_idx"] for w in windows] == [[0], [1]]
    assert [w["id"] for w in windows] == [0, 1]


def test_windows_split_at_sixty_seconds():
    lines = [line(i, "あい", i * 20.0, 20.0) for i in range(5)]
    windows = align.windows_from_lines(lines, 1000.0)
    assert [w["line_idx"] for w in windows] == [[0, 1, 2], [3, 4]]


def test_windows_clamp_pad_to_audio_and_skip_late_or_empty_lines():
    lines = [line(0, "あ", 0.2, 1.0), line(1, "。", 1.2, 1.0), line(2, "い", 50.0, 1.0)]
    (w,) = align.windows_from_lines(lines, 1.5)
    assert w["start"] == 0.0 and w["end"] == 1.5
    assert w["line_idx"] == [0]


# --- split_pieces ---

def test_split_pieces_ignores_punctuation_and_case():
    lines = [line(0, "Hello, world.", 0, 2), line(1, "Good day!", 2, 2)]
    window = {"line_idx": [0, 1]}
    pieces = [piece("hello", 0, 1), piece("world", 1, 2), piece("good", 2, 3), piece("day", 3, 4)]
    out = align.split_pieces(window, pieces, lines)
    assert [p["text"] for p in out[0]] == ["hello", "world"]
    assert [p["text"] for p in out[1]] == ["good", "day"]


def test_split_pieces_straddling_piece_goes_to_first_line():
    lines = [line(0, "ABC", 0, 1), line(1, "DEF", 1, 1)]
    window = {"line_idx": [0, 1]}
    pieces = [piece("AB", 0, 0.5), piece("CD", 0.5, 1.2), piece("EF", 1.2, 2)]
    out = align.split_pieces(window, pieces, lines)
    assert [p["text"] for p in out[0]] == ["AB", "CD"]
    assert [p["text"] for p in out[1]] == ["EF"]


def test_split_pieces_drops_unmatched_piece_and_rejects_poor_match():
    lines = [line(0, "ABCDEF", 0, 1)]
    window = {"line_idx": [0]}
    out = align.split_pieces(window, [piece("ABC", 0, 1), piece("zzz", 1, 2), piece("DEF", 2, 3)], lines)
    assert [p["text"] for p in out[0]] == ["ABC", "DEF"]
    assert align.split_pieces(window, [piece("xyz", 0, 1)], lines) is None
    assert align.split_pieces(window, [], lines) is None


# --- retime ---

def test_retime_moves_line_and_makes_pieces_relative():
    lines = [line(0, "ab", 10.0, 2.0)]
    (r,) = align.retime(lines, {0: [piece("a", 10.6, 11.0), piece("b", 11.0, 11.8)]})
    assert r["offset"] == pytest.approx(10.5)
    assert r["duration"] == pytest.approx(1.4)
    assert r["pieces"][0] == {"text": "a", "start": 0.1, "end": 0.5}
    assert r["pieces"][1]["end"] == pytest.approx(1.3)


def test_retime_drift_guard_keeps_caption_timing():
    lines = [line(0, "ab", 10.0, 2.0), line(1, "cd", 12.0, 2.0)]
    pieces = {0: [piece("a", 14.0, 15.0)], 1: [piece("c", 12.1, 13.9)]}
    results = align.retime(lines, pieces)
    assert [r["idx"] for r in results] == [1]


def test_retime_accepts_an_end_well_before_the_caption_end():
    # The caption runs until the next caption; the speech stopped at 12.5.
    lines = [line(0, "ab", 10.0, 6.0)]
    (r,) = align.retime(lines, {0: [piece("a", 10.2, 11.0), piece("b", 11.0, 12.5)]})
    assert r["offset"] == pytest.approx(10.1)
    assert r["duration"] == pytest.approx(2.5)


def test_retime_still_rejects_a_late_end_and_a_drifted_start():
    lines = [line(0, "ab", 10.0, 6.0), line(1, "cd", 20.0, 6.0)]
    pieces = {0: [piece("a", 10.2, 18.0)], 1: [piece("c", 22.0, 23.0)]}
    assert align.retime(lines, pieces) == []


def test_retime_offsets_monotonic_without_overlap_and_min_duration():
    lines = [line(0, "ab", 0.0, 2.0), line(1, "cd", 2.0, 2.0)]
    pieces = {0: [piece("a", 0.2, 2.4)], 1: [piece("c", 2.1, 3.0)]}
    r0, r1 = align.retime(lines, pieces)
    assert r0["offset"] + r0["duration"] <= r1["offset"] + 1e-6
    assert r1["offset"] >= r0["offset"]
    assert r1["duration"] >= align.MIN_LINE_S


# --- apply ---

def test_apply_canned_output():
    lines = [line(0, "こんにちは", 1.0, 2.0), line(1, "元気ですか", 3.2, 2.0)]
    windows = align.windows_from_lines(lines, 60.0)
    result = {"windows": [{"id": 0, "pieces": [
        piece("こんにちは", 1.2, 2.6), piece("元気", 3.4, 4.0), piece("ですか", 4.0, 4.8),
    ]}], "errors": [], "peak_rss_mb": 1}
    updates = align.apply(windows, lines, result)
    assert [u["idx"] for u in updates] == [0, 1]
    assert updates[0]["offset"] == pytest.approx(1.1)
    assert len(updates[1]["pieces"]) == 2
    assert align.apply(windows, lines, {"windows": [], "errors": [{"id": 0, "error": "x"}]}) == []


# --- run_job ---

def test_run_job_command_line(monkeypatch, tmp_path):
    py = tmp_path / "python"
    py.write_text("")
    job, out = tmp_path / "job.json", tmp_path / "out.json"
    seen = []

    def fake_run(argv, **kwargs):
        seen.append((argv, kwargs))
        out.write_text(json.dumps({"windows": [], "errors": []}))
        return subprocess.CompletedProcess(argv, 0, "", "")

    monkeypatch.setattr(align.subprocess, "run", fake_run)
    assert align.run_job(job, out, python=py, timeout=99) == {"windows": [], "errors": []}
    argv, kwargs = seen[0]
    assert argv == [
        "systemd-run", "--user", "--scope", "-q", "--nice=10",
        "-p", "MemoryMax=3G", "-p", "MemorySwapMax=0", "-p", "CPUQuota=600%",
        "env", "OMP_NUM_THREADS=6", "HF_HUB_OFFLINE=1",
        str(py), str(align.BACKEND / "align_worker.py"), str(job), str(out),
    ]
    assert kwargs["timeout"] == 99


def test_run_job_names_its_scope(monkeypatch, tmp_path):
    py = tmp_path / "python"
    py.write_text("")
    out = tmp_path / "out.json"
    seen = []

    def fake_run(argv, **kwargs):
        seen.append(argv)
        out.write_text("{}")
        return subprocess.CompletedProcess(argv, 0, "", "")

    monkeypatch.setattr(align.subprocess, "run", fake_run)
    align.run_job(tmp_path / "job.json", out, python=py, unit="isl1")
    assert "--unit=shadow-align-isl1" in seen[0]
    assert align.build_command(tmp_path / "j", out, py, scope=False, unit="isl1")[0] == "env"


def test_stop_leftover_scopes(monkeypatch):
    seen = []
    monkeypatch.setattr(align.subprocess, "run",
                        lambda argv, **kw: seen.append((argv, kw)) or subprocess.CompletedProcess(argv, 5))
    align.stop_leftover_scopes(timeout=7)
    assert seen[0][0] == ["systemctl", "--user", "stop", "shadow-align-*.scope"]
    assert seen[0][1]["timeout"] == 7

    def hang(argv, **kw):
        raise subprocess.TimeoutExpired(argv, 7)

    monkeypatch.setattr(align.subprocess, "run", hang)
    align.stop_leftover_scopes(timeout=7)  # logged, not raised


def test_run_job_falls_back_without_scope(monkeypatch, tmp_path):
    py = tmp_path / "python"
    py.write_text("")
    job, out = tmp_path / "job.json", tmp_path / "out.json"
    calls = []

    def fake_run(argv, **kwargs):
        calls.append(argv)
        if argv[0] == "systemd-run":
            return subprocess.CompletedProcess(argv, 1, "", "Failed to connect to bus")
        out.write_text("{}")
        return subprocess.CompletedProcess(argv, 0, "", "")

    monkeypatch.setattr(align.subprocess, "run", fake_run)
    assert align.run_job(job, out, python=py) == {}
    assert calls[1][0] == "env"


@pytest.mark.parametrize("code,expected", [(137, "align_oom"), (2, "align_model"), (1, "align_failed")])
def test_run_job_error_codes(monkeypatch, tmp_path, code, expected):
    py = tmp_path / "python"
    py.write_text("")
    monkeypatch.setattr(
        align.subprocess, "run",
        lambda argv, **kw: subprocess.CompletedProcess(argv, code, "", "boom"),
    )
    with pytest.raises(align.AlignError) as err:
        align.run_job(tmp_path / "j", tmp_path / "o", python=py)
    assert err.value.code == expected


def test_run_job_missing_python(tmp_path):
    with pytest.raises(align.AlignError) as err:
        align.run_job(tmp_path / "j", tmp_path / "o", python=tmp_path / "nope")
    assert err.value.code == "aligner_missing"
