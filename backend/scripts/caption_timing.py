"""Score or rewrite the word timing of caption-only YouTube islands.

  python scripts/caption_timing.py score [--seed N] [--island ID]
  python scripts/caption_timing.py backfill [--apply] [--island ID]
  python scripts/caption_timing.py transfer --island ID [--apply]
  python scripts/caption_timing.py restore --island ID
  python scripts/caption_timing.py score-transfer [--seed N] [--island ID]

`score` is read-only: it measures the speech trim against VOICEVOX islands.
`backfill` is a dry run unless --apply; it rewrites only ja YouTube lines
that still carry the even spread. `transfer` moves an island's lines onto
the ASR track in audio/<id>/captions.json (yt-precise), a per-line table,
dry run unless --apply; `restore` puts back audio/<id>/timing-before.json;
`score-transfer` measures the transfer against VOICEVOX islands. Run from
backend/. Point SHADOW_DATA_DIR at a copy to try it without touching real
islands.
"""

import argparse
import sys
from pathlib import Path

# backend/ goes first so `import caption_timing` finds the module, not this script.
ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from dotenv import load_dotenv  # noqa: E402

load_dotenv(ROOT / ".env")

import caption_timing  # noqa: E402


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    sub = parser.add_subparsers(dest="cmd", required=True)
    sc = sub.add_parser("score", help="measure the trim against islands with exact word times")
    sc.add_argument("--seed", type=int, default=1)
    sc.add_argument("--island", help="one island id")
    bf = sub.add_parser("backfill", help="trim even-spread ja YouTube lines (dry run by default)")
    bf.add_argument("--apply", action="store_true", help="write the new words")
    bf.add_argument("--island", help="one island id")
    tr = sub.add_parser("transfer", help="move one island's lines onto its ASR track (dry run by default)")
    tr.add_argument("--island", required=True, help="the island id")
    tr.add_argument("--apply", action="store_true", help="write the new words and spans")
    rs = sub.add_parser("restore", help="put back timing-before.json")
    rs.add_argument("--island", required=True, help="the island id")
    st = sub.add_parser("score-transfer", help="measure the transfer against islands with exact word times")
    st.add_argument("--seed", type=int, default=1)
    st.add_argument("--island", help="one island id")
    args = parser.parse_args()
    if args.cmd == "score":
        print(caption_timing.format_score(caption_timing.score(seed=args.seed, island=args.island)))
    elif args.cmd == "backfill":
        print(caption_timing.format_backfill(caption_timing.backfill(apply=args.apply, island=args.island)))
    elif args.cmd == "transfer":
        tokens = caption_timing.tokens_from_captions_json(args.island)
        print(caption_timing.format_transfer(caption_timing.transfer(args.island, tokens, apply=args.apply)))
    elif args.cmd == "restore":
        try:
            print(f"restored {caption_timing.restore(args.island)} lines of island {args.island}")
        except caption_timing.RestoreError as exc:
            print(exc, file=sys.stderr)
            return 1
    else:
        print(caption_timing.format_score_transfer(
            caption_timing.score_transfer(seed=args.seed, island=args.island)))
    return 0


if __name__ == "__main__":
    sys.exit(main())
