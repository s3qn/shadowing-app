"""Stitching an island's line wavs into one shareable audio file.

The player already renders and caches one wav per line per speed
(`_resolve_line_audio` in main.py). This module concatenates those wavs into a
single track (each line `repeats` times with a breath after every play) and
encodes the result to AAC in an m4a container, the format both iOS and Android
share sheets treat as a native, playable file.

The cache key covers the island's speaker id and line text, not the wav bytes
themselves: `_synthesize_lines` already clears every export whenever it
re-renders a line, so a change in content always invalidates the key by the
time stale bytes could be read, and hashing text is far cheaper than hashing
every wav on every request.
"""

import hashlib
import io
import json
import logging
import os
import re
import subprocess
import uuid
import wave
from dataclasses import dataclass
from pathlib import Path

import store

SPEED_MIN, SPEED_MAX = 0.5, 1.5  # same as main.py
REPEATS_MAX = 4
GAP_MAX_MS = 5000  # same cap as the `pad` query parameter
LEAD_MS = 500
BITRATE = "96k"
SAMPLE_RATE = 44100
FFMPEG = "ffmpeg"

log = logging.getLogger("shadow.export")

_UNSAFE_CHARS = re.compile(r'[\\/:*?"<>|\x00-\x1f]')
_WHITESPACE = re.compile(r"\s+")


class ExportError(RuntimeError):
    """Assembling the wav or encoding it with ffmpeg failed."""


@dataclass(frozen=True)
class Spec:
    speed: float  # 0.5..1.5, multiple of 0.05
    repeats: int  # 1..4
    gap_ms: int  # 0..5000
    lead_ms: int = LEAD_MS


def normalise(speed: float, repeats: int, gap_ms: int) -> Spec:
    """Clamp and round a request's parameters to what `build` will accept."""
    speed = round(min(SPEED_MAX, max(SPEED_MIN, speed)) * 20) / 20
    repeats = min(REPEATS_MAX, max(1, repeats))
    gap_ms = min(GAP_MAX_MS, max(0, gap_ms))
    return Spec(speed, repeats, gap_ms)


def cache_key(island: dict, spec: Spec) -> str:
    """12 hex characters, stable for identical speaker, line text, order and
    parameters, and different otherwise."""
    payload = json.dumps(
        [
            island["speaker"],
            [[line["idx"], line["ja"]] for line in island["lines"]],
            spec.speed,
            spec.repeats,
            spec.gap_ms,
            spec.lead_ms,
            BITRATE,
            SAMPLE_RATE,
        ],
        ensure_ascii=False,
    )
    return hashlib.sha1(payload.encode("utf-8")).hexdigest()[:12]


def export_path(island_id: str, key: str) -> Path:
    return store.AUDIO_DIR / island_id / f"export-{key}.m4a"


def clear_exports(island_id: str) -> None:
    """Drop every export built for this island, plus any leftover tmp file
    from an interrupted encode. Fine to call for an island with no folder."""
    folder = store.AUDIO_DIR / island_id
    if not folder.is_dir():
        return
    for path in folder.glob("export-*.m4a"):
        path.unlink(missing_ok=True)


def assemble_wav(wavs: list[bytes], spec: Spec) -> bytes:
    """One wav: `lead_ms` of silence, then each line's frames `repeats` times
    with `gap_ms` of silence after every play, in order. The gap follows the
    last play too, so a looping player app gets a breath before it repeats."""
    if not wavs:
        raise ExportError("no lines to export")

    frames_list: list[bytes] = []
    params = None
    for wav in wavs:
        with wave.open(io.BytesIO(wav)) as src:
            this_params = (src.getnchannels(), src.getsampwidth(), src.getframerate())
            if params is None:
                params = this_params
            elif this_params != params:
                raise ExportError(
                    f"line wavs do not share format: {params} vs {this_params}"
                )
            frames_list.append(src.readframes(src.getnframes()))

    nchannels, sampwidth, framerate = params
    frame_size = nchannels * sampwidth

    def silence(ms: int) -> bytes:
        return b"\x00" * (round(framerate * ms / 1000) * frame_size)

    out_frames = [silence(spec.lead_ms)]
    gap = silence(spec.gap_ms)
    for frames in frames_list:
        for _ in range(spec.repeats):
            out_frames.append(frames)
            out_frames.append(gap)

    out = io.BytesIO()
    with wave.open(out, "wb") as dst:
        dst.setnchannels(nchannels)
        dst.setsampwidth(sampwidth)
        dst.setframerate(framerate)
        dst.writeframes(b"".join(out_frames))
    return out.getvalue()


def _tmp_paths(dst: Path) -> tuple[Path, Path]:
    """Scratch wav and m4a paths next to `dst`, unique per call, so two builds
    of the same key never write, truncate or delete each other's files. Both
    still match `export-*`, so `clear_exports` sweeps up a leftover m4a."""
    tag = uuid.uuid4().hex
    return (
        dst.with_name(f"{dst.stem}.{tag}.tmp.wav"),
        dst.with_name(f"{dst.stem}.{tag}.tmp.m4a"),
    )


def encode_m4a(wav: bytes, dst: Path, title: str) -> None:
    """Encode a wav to AAC at `dst`, tagged with `title`. Writes through
    per-call tmp files so a reader never sees a partial `dst`."""
    tmp_wav, tmp_m4a = _tmp_paths(dst)
    try:
        tmp_wav.write_bytes(wav)
        try:
            subprocess.run(
                [
                    FFMPEG,
                    "-y",
                    "-i", str(tmp_wav),
                    "-c:a", "aac",
                    "-b:a", BITRATE,
                    "-ar", str(SAMPLE_RATE),
                    "-ac", "1",
                    "-movflags", "+faststart",
                    "-metadata", f"title={title}",
                    "-metadata", "artist=Shadowing",
                    str(tmp_m4a),
                ],
                capture_output=True,
                check=True,
                timeout=120,
            )
        except subprocess.CalledProcessError as exc:
            # stderr names server paths, so it goes to the log, not the error.
            stderr = (exc.stderr or b"").decode("utf-8", "replace")[-2000:]
            log.error("ffmpeg exited %s encoding %s: %s", exc.returncode, dst, stderr)
            raise ExportError("ffmpeg failed") from exc
        except subprocess.TimeoutExpired as exc:
            log.error("ffmpeg timed out encoding %s", dst)
            raise ExportError("ffmpeg timed out") from exc
        except FileNotFoundError as exc:
            log.error("ffmpeg not found: %s", exc)
            raise ExportError("ffmpeg not found") from exc
        os.replace(tmp_m4a, dst)
    except OSError as exc:
        # ExportError is a RuntimeError, not an OSError, so the ffmpeg
        # branches above are already out of reach here; this only catches a
        # failed write_bytes or os.replace (e.g. an unwritable directory).
        log.error("export write failed for %s: %s", dst, exc)
        raise ExportError("could not write the export") from exc
    finally:
        tmp_wav.unlink(missing_ok=True)
        # Gone already after a successful replace; after a failed or killed
        # encode it may hold a partial file.
        tmp_m4a.unlink(missing_ok=True)


def build(wavs: list[bytes], spec: Spec, dst: Path, title: str) -> None:
    wav = assemble_wav(wavs, spec)
    encode_m4a(wav, dst, title)


def file_name(title: str, speed: float) -> str:
    """`<safe title> <speed>x.m4a`, safe for the filename fields of every
    share target: the phone's own Files app, Drive, a mail attachment."""
    safe = _WHITESPACE.sub(" ", _UNSAFE_CHARS.sub(" ", title)).strip()
    safe = safe[:60].strip()
    if not safe:
        safe = "Island"
    return f"{safe} {speed:.2f}x.m4a"
