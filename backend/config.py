# Settings read from the environment once, at import. Moved out of main.py unchanged.
# load_dotenv() is idempotent, so these reads are safe whatever the import order.

import os

from dotenv import load_dotenv

load_dotenv()

SHADOW_TOKEN = os.getenv("SHADOW_TOKEN", "")
MAX_UPLOAD_BYTES = 25 * 1024 * 1024
IMPORT_MAX_BYTES = 300 * 1024 * 1024
IMPORT_MAX_SECONDS = 1800  # 30 minutes: how much of an import an island keeps
# --- bl36-align ---
VIDEO_AUDIO_MAX_BYTES = 40 * 1024 * 1024
ALIGN_MAX_SECONDS = 1800
ALIGN_TIMEOUT_S = 1800
ALIGN_MAX_ATTEMPTS = 3
ASR_MIN_ANCHORED = 0.2  # yt-precise: under this share of lines anchored is asr_low_match
# --- end bl36-align ---
SRT_MAX_BYTES = 2 * 1024 * 1024
SLICE_RATE = 24000  # aec.SR: VOICEVOX's rate, which the take cleaner and slicer assume

# --- say-it ---
DAILY_SAYS = int(os.getenv("SHADOW_DAILY_SAYS", "40"))
