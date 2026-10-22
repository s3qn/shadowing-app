"""BL-36 step 2: align YouTube caption text to the real audio.

Pure logic (windows, mapping pieces back to lines, retiming) plus `run_job`,
which runs `align_worker.py` in its own torch venv under a memory cap. Nothing
here imports torch, so the main venv and the test suite stay light.

Lines are plain dicts `{idx, text, offset, duration, words}`. Pieces are
`{text, start, end}`: absolute video seconds from the worker, relative to the
line's own offset once `retime` has placed them (the shape `segment.align_pieces`
and `latin.align` already take).
"""

import difflib
import json
import logging
import subprocess
from pathlib import Path

log = logging.getLogger("shadow.align")

BACKEND = Path(__file__).parent

WINDOW_MAX_S = 60
WINDOW_GAP_S = 2.0
WINDOW_PAD_S = 0.5
DRIFT_S = 1.5
LINE_PAD_S = 0.1
MIN_LINE_S = 0.3
MIN_MATCH = 0.6
ALIGN_MEMORY_MAX = "3G"
ALIGN_CPU_QUOTA = "600%"
ALIGN_THREADS = 6

LANGUAGE_NAMES = {"ja": "Japanese", "en": "English", "es": "Spanish"}


class AlignError(Exception):
    """A whole-job failure. `code` is what lands in videos.align_error."""

    def __init__(self, code: str, detail: str = ""):
        super().__init__(f"{code}: {detail}" if detail else code)
        self.code = code


def _keep(ch: str) -> bool:
    return ch.isalnum()


def _chars(text: str) -> str:
    return "".join(ch.casefold() for ch in text if _keep(ch))


def windows_from_lines(lines: list[dict], audio_len: float) -> list[dict]:
    """Group consecutive caption lines into aligner windows. A window breaks at
    a gap over WINDOW_GAP_S between lines and when it would span more than
    WINDOW_MAX_S. Each side is padded by WINDOW_PAD_S and clamped to the audio.
    Lines with no text or starting past the audio are left out."""
    groups: list[list[dict]] = []
    for line in lines:
        if not _chars(line["text"]) or line["offset"] >= audio_len:
            continue
        end = line["offset"] + line["duration"]
        if groups:
            first, last = groups[-1][0], groups[-1][-1]
            gap = line["offset"] - (last["offset"] + last["duration"])
            if gap <= WINDOW_GAP_S and end - first["offset"] <= WINDOW_MAX_S:
                groups[-1].append(line)
                continue
        groups.append([line])
    windows = []
    for n, group in enumerate(groups):
        start = max(0.0, group[0]["offset"] - WINDOW_PAD_S)
        last = group[-1]
        end = min(audio_len, last["offset"] + last["duration"] + WINDOW_PAD_S)
        windows.append({
            "id": n,
            "start": round(start, 3),
            "end": round(end, 3),
            "text": " ".join(line["text"].strip() for line in group),
            "line_idx": [line["idx"] for line in group],
        })
    return windows


def split_pieces(window: dict, pieces: list[dict], lines: list[dict]) -> dict[int, list[dict]] | None:
    """Hand each aligned piece to the caption line that owns it.

    The window text is the lines joined in order, so every text character has a
    line. difflib matches the characters of the pieces against them (a piece
    spelled slightly differently still anchors on the characters it shares) and
    a piece goes to the line owning its first matched character. Unmatched
    pieces are dropped. None when too little of the text matched."""
    by_idx = {line["idx"]: line for line in lines}
    owners: list[int] = []
    text_chars: list[str] = []
    for idx in window["line_idx"]:
        for ch in _chars(by_idx[idx]["text"]):
            text_chars.append(ch)
            owners.append(idx)
    if not text_chars:
        return None
    piece_chars: list[str] = []
    piece_of: list[int] = []
    for p, piece in enumerate(pieces):
        for ch in _chars(piece["text"]):
            piece_chars.append(ch)
            piece_of.append(p)
    if not piece_chars:
        return None
    matcher = difflib.SequenceMatcher(None, "".join(text_chars), "".join(piece_chars), autojunk=False)
    first_owner: dict[int, int] = {}
    matched = 0
    for block in matcher.get_matching_blocks():
        for k in range(block.size):
            matched += 1
            first_owner.setdefault(piece_of[block.b + k], owners[block.a + k])
    if matched / len(text_chars) < MIN_MATCH:
        return None
    out: dict[int, list[dict]] = {}
    for p, piece in enumerate(pieces):
        if p in first_owner:
            out.setdefault(first_owner[p], []).append(piece)
    return out


def retime(lines: list[dict], per_line: dict[int, list[dict]]) -> list[dict]:
    """New offset, duration and relative pieces for the lines whose aligned
    start agrees with the caption start to within DRIFT_S and whose aligned
    end is no later than the caption end plus DRIFT_S. An aligned end well
    before the caption end is the trailing pause of a caption that runs until
    the next one, not drift, so it is accepted. Other lines are absent from
    the result and keep their caption timing. Offsets stay monotonic and ends
    never run into the next line."""
    chosen: dict[int, tuple[float, float, list[dict]]] = {}
    prev_end = 0.0
    for line in lines:
        pieces = per_line.get(line["idx"])
        end = line["offset"] + line["duration"]
        if pieces:
            a_start = min(p["start"] for p in pieces)
            a_end = max(p["end"] for p in pieces)
            if abs(a_start - line["offset"]) <= DRIFT_S and a_end <= end + DRIFT_S and a_end > a_start:
                offset = max(prev_end, a_start - LINE_PAD_S)
                chosen[line["idx"]] = (offset, a_end + LINE_PAD_S, pieces)
                prev_end = chosen[line["idx"]][1]
                continue
        prev_end = max(prev_end, end)
    results = []
    for n, line in enumerate(lines):
        if line["idx"] not in chosen:
            continue
        offset, end, pieces = chosen[line["idx"]]
        if n + 1 < len(lines):
            nxt = lines[n + 1]
            next_offset = chosen[nxt["idx"]][0] if nxt["idx"] in chosen else nxt["offset"]
            end = min(end, next_offset)
        duration = max(end - offset, MIN_LINE_S)
        rel = []
        for p in pieces:
            start = min(max(p["start"] - offset, 0.0), duration)
            stop = min(max(p["end"] - offset, start), duration)
            rel.append({"text": p["text"], "start": round(start, 3), "end": round(stop, 3)})
        results.append({
            "idx": line["idx"], "offset": round(offset, 3),
            "duration": round(duration, 3), "pieces": rel,
        })
    return results


def apply(windows: list[dict], lines: list[dict], result: dict) -> list[dict]:
    """Turn a worker `out.json` into per-line updates: {idx, offset, duration,
    pieces}, pieces relative to the new offset. A window that failed, is
    missing, or matches its text poorly contributes nothing."""
    by_idx = {line["idx"]: line for line in lines}
    done = {w["id"]: w["pieces"] for w in result.get("windows", [])}
    per_line: dict[int, list[dict]] = {}
    for window in windows:
        pieces = done.get(window["id"])
        if not pieces:
            continue
        mine = [by_idx[i] for i in window["line_idx"] if i in by_idx]
        split = split_pieces(window, pieces, mine)
        if split:
            per_line.update(split)
    return retime(lines, per_line)


SCOPE_PREFIX = "shadow-align-"


def build_command(job_path: Path, out_path: Path, python: Path | str | None, scope: bool,
                  unit: str | None = None) -> list[str]:
    python = str(python or BACKEND / ".venv-align" / "bin" / "python")
    inner = [
        "env", f"OMP_NUM_THREADS={ALIGN_THREADS}", "HF_HUB_OFFLINE=1",
        python, str(BACKEND / "align_worker.py"), str(job_path), str(out_path),
    ]
    if not scope:
        return inner
    named = [f"--unit={SCOPE_PREFIX}{unit}"] if unit else []
    return [
        "systemd-run", "--user", "--scope", "-q", *named, "--nice=10",
        "-p", f"MemoryMax={ALIGN_MEMORY_MAX}", "-p", "MemorySwapMax=0",
        "-p", f"CPUQuota={ALIGN_CPU_QUOTA}", *inner,
    ]


def stop_leftover_scopes(timeout: float = 30) -> None:
    """Stop aligner scopes left by an earlier backend process. A scope lives
    outside the service, so a restart does not kill the worker inside it."""
    try:
        subprocess.run(
            ["systemctl", "--user", "stop", f"{SCOPE_PREFIX}*.scope"],
            capture_output=True, text=True, timeout=timeout,
        )
    except (FileNotFoundError, subprocess.TimeoutExpired) as exc:
        log.warning("could not stop leftover aligner scopes: %s", exc)


def run_job(job_path: Path, out_path: Path, python: Path | str | None = None,
            timeout: float = 1800, unit: str | None = None) -> dict:
    """Run the worker in its own venv under a systemd scope (named
    shadow-align-<unit> when given) and return the parsed out.json. Raises AlignError: aligner_missing, align_timeout, align_oom,
    align_model, align_failed."""
    py = Path(str(python or BACKEND / ".venv-align" / "bin" / "python"))
    if not py.exists():
        raise AlignError("aligner_missing")
    out_path = Path(out_path)
    out_path.unlink(missing_ok=True)

    def launch(scope: bool) -> subprocess.CompletedProcess:
        return subprocess.run(
            build_command(job_path, out_path, py, scope, unit),
            capture_output=True, text=True, timeout=timeout,
        )

    try:
        proc = launch(True)
        if proc.returncode == 1 and "connect to bus" in (proc.stderr or "") and not out_path.exists():
            log.warning("systemd-run unavailable, running the aligner without a memory cap")
            proc = launch(False)
    except subprocess.TimeoutExpired as exc:
        raise AlignError("align_timeout") from exc
    except FileNotFoundError:
        log.warning("systemd-run missing, running the aligner without a memory cap")
        try:
            proc = launch(False)
        except subprocess.TimeoutExpired as exc:
            raise AlignError("align_timeout") from exc
    if proc.returncode in (137, -9):
        raise AlignError("align_oom")
    if proc.returncode == 2:
        raise AlignError("align_model", (proc.stderr or "")[-300:])
    if proc.returncode != 0 or not out_path.exists():
        raise AlignError("align_failed", (proc.stderr or "")[-300:])
    return json.loads(out_path.read_text(encoding="utf-8"))
