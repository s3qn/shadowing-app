"""Bench the forced aligner against VOICEVOX ground truth. Run by hand, never
imported by tests, in backend/.venv-align under the runtime caps:

  systemd-run --user --scope -q --nice=10 -p MemoryMax=3G -p MemorySwapMax=0 \
    -p CPUQuota=600% env OMP_NUM_THREADS=6 HF_HUB_OFFLINE=1 \
    backend/.venv-align/bin/python backend/scripts/align_bench.py --island <id>

Reads an existing ja island from SHADOW_DATA_DIR (line wavs + stored words),
aligns each line, then one concatenation of the lines (0.5 s silence between,
capped at 60 s) with known offsets. Prints median and p90 of word-start error,
wall time, RTF and peak RSS.
"""
import argparse
import json
import os
import re
import sqlite3
import statistics
import sys
import time
from pathlib import Path

import numpy as np
import soundfile as sf

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
import align_worker as aw  # noqa: E402

DATA = Path(os.getenv("SHADOW_DATA_DIR", Path(__file__).resolve().parent.parent / "data"))
GAP_S = 0.5
SKIP = re.compile(r"[\s、。，．,.!?！？「」『』…・\-ー~〜]")


def load_lines(island: str) -> list[dict]:
    conn = sqlite3.connect(DATA / "islands.db")
    rows = conn.execute(
        "SELECT idx, ja, words FROM lines WHERE island_id=? ORDER BY idx", (island,)
    ).fetchall()
    conn.close()
    out = []
    for idx, ja, words in rows:
        wav = DATA / "audio" / island / f"{idx}.wav"
        if wav.exists():
            out.append({"idx": idx, "ja": ja, "words": json.loads(words or "[]"), "wav": wav})
    return out


def to_16k(path: Path) -> np.ndarray:
    import librosa

    audio, _ = librosa.load(str(path), sr=aw.SAMPLE_RATE, mono=True)
    return audio.astype("float32")


def errors_for(words: list[dict], pieces: list[dict], shift: float) -> list[float]:
    """Absolute start error (s) of each stored word against the piece that
    contains the word's first non-punctuation character."""
    bounds, pos = [], 0
    for piece in pieces:
        n = len(SKIP.sub("", piece["text"]))
        bounds.append((pos, pos + n, piece["start"]))
        pos += n
    errs, cpos = [], 0
    for word in words:
        chars = SKIP.sub("", word["text"])
        if not chars:
            continue
        for lo, hi, start in bounds:
            if lo <= cpos < hi:
                errs.append(abs(start - (word["start"] + shift)))
                break
        cpos += len(chars)
    return errs


def report(label: str, errs: list[float], audio_s: float, wall_s: float) -> None:
    errs = sorted(errs)
    med = statistics.median(errs) * 1000 if errs else float("nan")
    p90 = errs[int(0.9 * (len(errs) - 1))] * 1000 if errs else float("nan")
    print(f"{label}: n={len(errs)} median={med:.0f}ms p90={p90:.0f}ms "
          f"audio={audio_s:.1f}s wall={wall_s:.1f}s RTF={wall_s / max(audio_s, 1e-9):.2f}")


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--island", required=True)
    ap.add_argument("--language", default="Japanese")
    args = ap.parse_args()
    lines = load_lines(args.island)
    if not lines:
        print("no lines with audio", file=sys.stderr)
        return 1
    t0 = time.time()
    model = aw.load_model()
    print(f"model load {time.time() - t0:.1f}s, rss={aw.peak_rss_mb()} MB")

    errs, audio_s = [], 0.0
    t0 = time.time()
    for line in lines:
        audio = to_16k(line["wav"])
        audio_s += len(audio) / aw.SAMPLE_RATE
        win = {"start": 0.0, "end": len(audio) / aw.SAMPLE_RATE, "text": line["ja"]}
        pieces = aw.align_window(model, audio, win, args.language)
        errs += errors_for(line["words"], pieces, 0.0)
    report("per-line", errs, audio_s, time.time() - t0)

    parts, offsets, cursor, total = [], [], 0.0, 0.0
    for line in lines:
        audio = to_16k(line["wav"])
        dur = len(audio) / aw.SAMPLE_RATE
        if cursor + dur > 60.0 and parts:
            break
        offsets.append((line, cursor))
        parts += [audio, np.zeros(int(GAP_S * aw.SAMPLE_RATE), dtype="float32")]
        cursor += dur + GAP_S
        total += dur
    big = np.concatenate(parts)
    text = " ".join(line["ja"] for line, _ in offsets)
    t0 = time.time()
    pieces = aw.align_window(
        model, big, {"start": 0.0, "end": len(big) / aw.SAMPLE_RATE, "text": text}, args.language
    )
    wall = time.time() - t0
    errs, pos = [], 0
    bounds = []
    for piece in pieces:
        n = len(SKIP.sub("", piece["text"]))
        bounds.append((pos, pos + n, piece))
        pos += n
    cpos = 0
    for line, off in offsets:
        for word in line["words"]:
            chars = SKIP.sub("", word["text"])
            if not chars:
                continue
            for lo, hi, piece in bounds:
                if lo <= cpos < hi:
                    errs.append(abs(piece["start"] - (word["start"] + off)))
                    break
            cpos += len(chars)
    report(f"concat({len(offsets)} lines)", errs, len(big) / aw.SAMPLE_RATE, wall)
    print(f"peak_rss_mb={aw.peak_rss_mb()}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
