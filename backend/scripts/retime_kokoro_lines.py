"""Re-time existing es/en island lines from Kokoro's own phoneme durations.

Needs a Kokoro model exported with a `duration` output (KOKORO_MODEL_DIR).
For each ready es/en island made from voice or phrases, a line is re-timed
only when a fresh render has the same frame count as the stored wav, so the
durations describe the stored audio. Lines that differ are listed for a
revoice from the app. Never writes audio. Dry run unless --apply.

Run from backend/: python scripts/retime_kokoro_lines.py [--apply]
Point SHADOW_DATA_DIR at a copy to try it without touching real islands.
"""

import argparse
import sys
import wave
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from dotenv import load_dotenv  # noqa: E402

load_dotenv(ROOT / ".env")

import kokoro_tts  # noqa: E402
import latin  # noqa: E402
import store  # noqa: E402
import voices  # noqa: E402


def _frames(wav_bytes: bytes) -> int:
    import io

    with wave.open(io.BytesIO(wav_bytes), "rb") as w:
        return w.getnframes()


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    parser.add_argument("--apply", action="store_true", help="write the new words")
    args = parser.parse_args()

    print(f"Data dir: {store.DATA_DIR.resolve()}"
          + ("" if args.apply else " (dry run, nothing is written without --apply)"))
    print(f"Kokoro model dir: {kokoro_tts.MODEL_DIR}")
    kokoro_tts.warm_up()
    if not kokoro_tts.has_timings():
        print("The loaded Kokoro model has no duration output. Nothing to do.")
        return 1

    retimed = revoice = failed = 0
    for island in store.list_islands():
        if (island["status"] != "ready" or island["language"] not in ("es", "en")
                or island.get("source") not in ("voice", "phrases")):
            continue
        full = store.get_island(island["id"])
        voice = voices.KOKORO_VOICES.get(full["speaker"])
        if voice is None:
            continue
        name, _, _, lang = voice
        for idx, line in enumerate(full["lines"]):
            path = store.line_audio_path(island["id"], idx)
            tag = f"{island['id']} line {idx}"
            if not path.exists():
                continue
            try:
                wav, duration, timings = kokoro_tts.synthesize_timed(line["ja"], name, lang)
                with wave.open(str(path), "rb") as w:
                    stored = w.getnframes()
            except Exception as exc:
                print(f"{tag}: render failed ({exc})")
                failed += 1
                continue
            if _frames(wav) != stored:
                print(f"{tag}: audio differs, revoice from the app")
                revoice += 1
                continue
            words = latin.align_phonemes(line["ja"], timings, duration)
            if not words:
                print(f"{tag}: phoneme groups do not match the words, left as is")
                failed += 1
                continue
            retimed += 1
            if args.apply:
                store.set_words(island["id"], idx, words)
                print(f"{tag}: re-timed")
            else:
                print(f"{tag}: would re-time")
    print(f"{retimed} re-timed, {revoice} need a revoice, {failed} left as is"
          + ("" if args.apply else " (dry run)"))
    return 0


if __name__ == "__main__":
    sys.exit(main())
