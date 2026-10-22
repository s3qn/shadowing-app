#!/usr/bin/env bash
# usage: tools/analyze-video.sh <file> [out_dir]
# Writes into out_dir (default: <file>.analysis): frames/ (scene changes plus
# the first frame and one every 10 s, 540 px wide, timestamp drawn), sheets/ (3x4 contact sheets),
# audio.wav (16 kHz mono) and transcript.txt ([mm:ss] per segment, faster-whisper
# medium on CPU, language auto).
set -euo pipefail
IN="${1:?usage: analyze-video.sh <file> [out_dir]}"
OUT="${2:-$IN.analysis}"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PY="$ROOT/backend/.venv/bin/python"
mkdir -p "$OUT/frames" "$OUT/sheets"

DUR="$(ffprobe -v error -show_entries format=duration -of csv=p=0 "$IN")"
echo "duration: ${DUR}s" | tee "$OUT/info.txt"

# Scene changes plus one frame every 10 s.
ffmpeg -v error -y -i "$IN" -an \
  -vf "select='isnan(prev_selected_t)+gt(scene,0.3)+gte(t-prev_selected_t,10)',scale=540:-2,drawtext=text='%{pts\:hms}':x=8:y=8:fontsize=22:fontcolor=white:box=1:boxcolor=black@0.6" \
  -fps_mode vfr -q:v 4 "$OUT/frames/f_%05d.jpg"

# 3x4 contact sheets.
ffmpeg -v error -y -pattern_type glob -i "$OUT/frames/f_*.jpg" \
  -vf "tile=3x4:padding=4" -fps_mode vfr -q:v 4 "$OUT/sheets/sheet_%03d.jpg"

ffmpeg -v error -y -i "$IN" -vn -ac 1 -ar 16000 "$OUT/audio.wav"

"$PY" -I - "$OUT/audio.wav" "$OUT/transcript.txt" <<'PYEOF'
import sys
from faster_whisper import WhisperModel

wav, out = sys.argv[1], sys.argv[2]
model = WhisperModel("medium", device="cpu", compute_type="int8", cpu_threads=6)
segments, info = model.transcribe(wav, vad_filter=True, beam_size=5)
with open(out, "w", encoding="utf-8") as f:
    for s in segments:
        m, sec = divmod(int(s.start), 60)
        f.write(f"[{m:02d}:{sec:02d}] {s.text.strip()}\n")
print("language:", info.language)
PYEOF
echo "done: $OUT"
