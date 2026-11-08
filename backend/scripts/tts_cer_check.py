"""Opt-in, model-backed check: render each language's preview sentence with
its default local voice, transcribe it with faster-whisper small and print
the character error rate. Not part of the pytest suite (it loads models and
spawns the engine workers).

    backend/.venv/bin/python backend/scripts/tts_cer_check.py zh he ar

Uses a throwaway SHADOW_DATA_DIR unless one is set, so it never touches the
real islands.db. Skips when less than 1.5 GB of memory is available.
"""

import asyncio
import io
import os
import re
import sys
import tempfile
import unicodedata
from pathlib import Path

BACKEND = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(BACKEND))
os.environ.setdefault("SHADOW_DATA_DIR", tempfile.mkdtemp(prefix="shadow-cer-"))
os.environ.setdefault("SHADOW_TOKEN", "cer-check")

import tts_local  # noqa: E402
import tts_registry  # noqa: E402
import voices  # noqa: E402
from routers.voices import PREVIEW_TEXT  # noqa: E402

MIN_FREE_MB = 1500


def _norm(s: str) -> str:
    s = unicodedata.normalize("NFKD", s.lower())
    s = "".join(c for c in s if not unicodedata.combining(c))
    return re.sub(r"[^\w]", "", s)


def _lev(a: str, b: str) -> int:
    prev = list(range(len(b) + 1))
    for i in range(1, len(a) + 1):
        cur = [i] + [0] * len(b)
        for j in range(1, len(b) + 1):
            cur[j] = min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] != b[j - 1]))
        prev = cur
    return prev[-1]


async def main(langs: list[str]) -> int:
    free = tts_local.mem_available_mb()
    if free < MIN_FREE_MB:
        print(f"skipped: {free} MB available, {MIN_FREE_MB} needed")
        return 1
    from faster_whisper import WhisperModel

    model = WhisperModel("small", device="cpu", compute_type="int8", cpu_threads=4)
    for lang in langs:
        ref = PREVIEW_TEXT[lang]
        for vid in [tts_registry.default_voice(lang)] + [
            int(x) for x in os.getenv("CER_EXTRA_VOICES", "").split(",") if x and tts_registry.language_for(int(x)) == lang
        ]:
            try:
                out = await voices.render(ref, vid)
            except Exception as exc:
                print(f"{lang} {vid}: render failed: {type(exc).__name__}: {exc}")
                continue
            segs, _ = model.transcribe(io.BytesIO(out.wav), language=lang, beam_size=1)
            hyp = "".join(s.text for s in segs)
            a, b = _norm(ref), _norm(hyp)
            cer = _lev(a, b) / max(len(a), 1)
            print(f"{lang} {vid} ({out.voice}, {out.duration:.2f}s): CER {cer:.3f} | {hyp.strip()}")
    if tts_local._idle_task is not None:
        tts_local._idle_task.cancel()
    await tts_local._stop()
    return 0


if __name__ == "__main__":
    sys.exit(asyncio.run(main(sys.argv[1:] or ["zh", "he", "ar"])))
