"""Forced-alignment subprocess. Runs only in backend/.venv-align (torch, qwen-asr).

    align_worker.py <job.json> <out.json>

job.json: {"wav": "/abs/16k.wav", "language": "Japanese",
           "windows": [{"id": 0, "start": 12.3, "end": 70.1, "text": "..."}]}
out.json: {"windows": [{"id": 0, "pieces": [{"text", "start", "end"}]}],
           "errors": [{"id": 3, "error": "..."}], "peak_rss_mb": 2210}

Times are absolute video seconds. A failing window never aborts the job. Exit
code 2 means the model could not be loaded. Importing this module has no side
effects, and it cannot be imported from the main venv (no torch there).
"""
import json
import os
import resource
import sys

import numpy as np
import soundfile as sf
import torch

MODEL_ID = "Qwen/Qwen3-ForcedAligner-0.6B"
SAMPLE_RATE = 16000


def load_model():
    from qwen_asr import Qwen3ForcedAligner

    torch.set_num_threads(int(os.getenv("OMP_NUM_THREADS", "6")))
    return Qwen3ForcedAligner.from_pretrained(
        MODEL_ID, dtype=torch.bfloat16, device_map="cpu"
    )


def read_wav(path: str) -> np.ndarray:
    audio, sr = sf.read(path, dtype="float32", always_2d=False)
    if audio.ndim > 1:
        audio = audio.mean(axis=1)
    if sr != SAMPLE_RATE:
        raise ValueError(f"expected {SAMPLE_RATE} Hz wav, got {sr}")
    return audio


def align_window(model, audio: np.ndarray, window: dict, language: str) -> list[dict]:
    """Pieces for one window, in absolute seconds."""
    first = max(0, int(window["start"] * SAMPLE_RATE))
    last = min(len(audio), int(window["end"] * SAMPLE_RATE))
    if last - first < SAMPLE_RATE // 10:
        raise ValueError("window has no audio")
    shift = first / SAMPLE_RATE
    result = model.align(
        audio=(audio[first:last], SAMPLE_RATE), text=window["text"], language=language
    )[0]
    return [
        {
            "text": item.text,
            "start": round(item.start_time + shift, 3),
            "end": round(item.end_time + shift, 3),
        }
        for item in result.items
    ]


def peak_rss_mb() -> int:
    return int(resource.getrusage(resource.RUSAGE_SELF).ru_maxrss / 1024)


def main(argv: list[str]) -> int:
    job_path, out_path = argv[1], argv[2]
    with open(job_path, encoding="utf-8") as fh:
        job = json.load(fh)
    try:
        model = load_model()
    except Exception as exc:  # noqa: BLE001
        print(f"align_worker: model load failed: {exc}", file=sys.stderr)
        return 2
    audio = read_wav(job["wav"])
    out: dict = {"windows": [], "errors": []}
    for window in job["windows"]:
        try:
            pieces = align_window(model, audio, window, job["language"])
            out["windows"].append({"id": window["id"], "pieces": pieces})
        except Exception as exc:  # noqa: BLE001
            out["errors"].append({"id": window["id"], "error": str(exc)[:300]})
    out["peak_rss_mb"] = peak_rss_mb()
    with open(out_path, "w", encoding="utf-8") as fh:
        json.dump(out, fh, ensure_ascii=False)
    print(f"align_worker: peak_rss_mb={out['peak_rss_mb']}", file=sys.stderr)
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
