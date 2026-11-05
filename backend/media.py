# ffmpeg and ffprobe helpers: audio normalising, stream picking, slicing,
# stretching, SRT reading and chunked upload copy. Blocking; callers use
# asyncio.to_thread. Moved out of main.py unchanged.
import json
import logging
import os
import secrets
import subprocess
from pathlib import Path

from fastapi import HTTPException, UploadFile

import config

log = logging.getLogger("shadow")


def _to_wav(src: Path, dst: Path, max_seconds: float | None = None) -> bool:
    """Normalise whatever the phone recorded to 16kHz mono wav for whisper."""
    limit = ["-t", str(max_seconds)] if max_seconds else []
    try:
        subprocess.run(
            ["ffmpeg", "-y", "-i", str(src), *limit, "-ac", "1", "-ar", "16000", str(dst)],
            capture_output=True,
            check=True,
            timeout=120,
        )
        return dst.exists()
    except Exception:
        log.exception("ffmpeg failed for %s", src)
        return False


JAPANESE_TAGS = ("jpn", "ja")


def pick_audio_stream(probe: dict) -> int | None:
    """The ffprobe stream index of the audio track to import, from ffprobe's
    parsed `-of json` output. Dual-audio releases often put an English dub
    first, so the first audio stream tagged `jpn` or `ja` wins; with no such
    tag, the first audio stream. None when there is no audio stream."""
    audio = [s for s in probe.get("streams", []) if s.get("codec_type") == "audio"]
    for stream in audio:
        language = str((stream.get("tags") or {}).get("language", "")).lower()
        if language in JAPANESE_TAGS:
            return int(stream["index"])
    return int(audio[0]["index"]) if audio else None


def _probe_streams(path: Path) -> dict:
    """ffprobe's stream list for a media file as parsed JSON, {} on failure.
    Blocking; callers use asyncio.to_thread."""
    try:
        result = subprocess.run(
            [
                "ffprobe", "-v", "error",
                "-show_entries", "stream=index,codec_type:stream_tags=language",
                "-of", "json", str(path),
            ],
            capture_output=True,
            check=True,
            timeout=60,
            text=True,
        )
        return json.loads(result.stdout)
    except Exception:
        log.exception("ffprobe streams failed for %s", path)
        return {}


def _unique_tmp(dst: Path) -> Path:
    """A tmp path beside dst that no other call shares, so two ffmpeg runs
    for the same target never write into one file."""
    return dst.with_name(f".{dst.stem}.{secrets.token_hex(6)}.tmp")


def _extract_audio(src: Path, dst: Path, stream: int, start_s: float = 0.0,
                   max_s: float | None = None) -> bool:
    """Pull audio stream `stream` (an ffprobe index, see pick_audio_stream)
    out of an imported file, as 24kHz mono 16-bit PCM: VOICEVOX's rate, which
    aec.SR and the take cleaner already assume. `start_s` and `max_s` trim
    the source in the same ffmpeg call, which is how the 30-minute import
    cap and a `start_min` offset are applied. Blocking; callers use
    asyncio.to_thread."""
    tmp = dst.with_suffix(".tmp")
    cmd = ["ffmpeg", "-y"]
    if start_s > 0:
        cmd += ["-ss", f"{start_s:.3f}"]
    cmd += ["-i", str(src)]
    if max_s is not None:
        cmd += ["-t", f"{max_s:.3f}"]
    cmd += [
        "-map", f"0:{stream}", "-ac", "1", "-ar", str(config.SLICE_RATE), "-c:a", "pcm_s16le",
        "-f", "wav", str(tmp),
    ]
    try:
        subprocess.run(cmd, capture_output=True, check=True, timeout=1200)
        if not tmp.exists():
            return False
        os.replace(tmp, dst)
        return dst.exists()
    except Exception:
        log.exception("ffmpeg extract failed for %s", src)
        tmp.unlink(missing_ok=True)
        return False


def _slice(src: Path, dst: Path, start: float, end: float) -> bool:
    """Cut one line's audio out of source.wav. `-ss` before `-i` on a wav is
    sample-accurate. Blocking; callers use asyncio.to_thread."""
    tmp = dst.with_suffix(".tmp")
    try:
        subprocess.run(
            [
                "ffmpeg", "-y",
                "-ss", f"{start:.3f}", "-i", str(src),
                "-t", f"{end - start:.3f}", "-c:a", "pcm_s16le",
                "-f", "wav", str(tmp),
            ],
            capture_output=True,
            check=True,
            timeout=120,
        )
        if not tmp.exists():
            return False
        os.replace(tmp, dst)
        return dst.exists()
    except Exception:
        log.exception("ffmpeg slice failed for %s [%.3f, %.3f)", src, start, end)
        tmp.unlink(missing_ok=True)
        return False


def _stretch(src: Path, dst: Path, speed: float) -> bool:
    """Slow (or speed up) a slice of imported audio with rubberband, pitch
    preserved. Output length is 1/speed of the input, which is what the
    client's w.start / speed assumes. Blocking; callers use asyncio.to_thread.

    Two requests for the same line and speed can both miss the cache and get
    here at once. Each writes its own tmp file and swaps it in with
    os.replace, so both finish with a whole file at dst and neither can
    read, move or delete the other's half-written output."""
    tmp = _unique_tmp(dst)
    try:
        subprocess.run(
            [
                "ffmpeg", "-y", "-i", str(src),
                "-filter:a", f"rubberband=tempo={speed}",
                "-c:a", "pcm_s16le",
                "-f", "wav", str(tmp),
            ],
            capture_output=True,
            check=True,
            timeout=120,
        )
        if not tmp.exists():
            return False
        os.replace(tmp, dst)
        return dst.exists()
    except Exception:
        log.exception("ffmpeg stretch failed for %s at %s", src, speed)
        tmp.unlink(missing_ok=True)
        return False


def _probe_duration(path: Path) -> float:
    """The duration of an audio file in seconds, 0.0 on failure."""
    try:
        result = subprocess.run(
            ["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", str(path)],
            capture_output=True,
            check=True,
            timeout=30,
            text=True,
        )
        return float(result.stdout.strip())
    except Exception:
        log.exception("ffprobe failed for %s", path)
        return 0.0


def _read_srt(path: Path) -> str:
    """Japanese subtitle files show up as utf-8-sig or, less often, Shift-JIS
    (cp932). Falls back to utf-8 with replacement rather than raising, so a
    stranger encoding imports as garbage text instead of failing the import."""
    raw = path.read_bytes()[:config.SRT_MAX_BYTES]
    for encoding in ("utf-8-sig", "cp932"):
        try:
            return raw.decode(encoding)
        except UnicodeDecodeError:
            continue
    return raw.decode("utf-8", errors="replace")


def _stream_upload(upload: UploadFile, dst: Path, max_bytes: int) -> int:
    """Copy an UploadFile to disk in chunks, so a large import is never held
    whole in memory. Raises HTTPException(413) past `max_bytes`. Blocking;
    callers use asyncio.to_thread."""
    size = 0
    with open(dst, "wb") as out:
        while True:
            chunk = upload.file.read(1024 * 1024)
            if not chunk:
                break
            size += len(chunk)
            if size > max_bytes:
                raise HTTPException(413, {"code": "file_too_large"})
            out.write(chunk)
    return size
