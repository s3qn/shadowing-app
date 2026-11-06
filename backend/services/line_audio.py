"""Rendering and caching of a line's wav (speed, phrase span, pause pad), the
per-device take profile lookup and the whole-episode m4a. Moved out of main.py
unchanged."""

import asyncio
import logging
import os
import uuid
from pathlib import Path

from fastapi import HTTPException

import config
import dependencies
import export
import kokoro_tts
import media as media_io
import store
import voicevox
import voices

log = logging.getLogger("shadow")


def _variant(idx: int, speed: float, span: tuple[int, int] | None) -> str:
    """Stem of a cached render: the speed and, for a phrase, its span in
    ms. `speed` is already rounded to 0.05."""
    stem = f"{idx}@{speed:.2f}"
    return f"{stem}~{span[0]}-{span[1]}" if span else stem


def _span(start: int, end: int) -> tuple[int, int] | None:
    """The (start, end) ms pair a route was asked for, or None for the whole
    line. Both default to -1; any other negative value, giving one without
    the other, or an empty or backwards span, is a client error."""
    if start < -1 or end < -1:
        raise HTTPException(400, "start and end must be milliseconds, or -1 for the whole line")
    if start < 0 and end < 0:
        return None
    if start < 0 or end <= start:
        raise HTTPException(400, "start and end must be milliseconds with start < end")
    return (start, end)


# One calibration profile per device for the phone's speaker-to-mic path (see
# the take-bleed plan). It is not scoped to an island: the room and the phone
# are what it models, not any one recording. Before device-scope there was one
# shared profile, "default"; the owner device still falls back to it.
LEGACY_TAKE_PROFILE = "default"


def _take_profile_name(device: str) -> str:
    """The profile file name for `device`. Safe as a file name only because
    `dependencies._require_device` has already matched the id against dependencies.DEVICE_ID_RE or
    USER_RE."""
    return f"dev-{device}"


def _load_take_profile(aec, device: str):
    """The device's own profile, or for the owner device the legacy shared
    one when it has not calibrated since device-scope."""
    profile = aec.load_profile(_take_profile_name(device))
    if profile is None and dependencies.OWNER_DEVICE and device == dependencies.OWNER_DEVICE:
        profile = aec.load_profile(LEGACY_TAKE_PROFILE)
    return profile


def _write_atomic(path: Path, data: bytes) -> None:
    """Write `data` to `path` via a temp file and rename, so a reader never
    sees a partial write. The tmp name carries a random suffix so two
    concurrent writers targeting the same `path` (two requests racing to
    render the same line) never share, and clobber, one tmp file. Blocking
    IO, meant to run in a thread."""
    tmp = path.with_name(f"{path.name}.{uuid.uuid4().hex}.tmp")
    try:
        tmp.write_bytes(data)
        os.replace(tmp, path)
    except BaseException:
        tmp.unlink(missing_ok=True)
        raise


def _cached_transform(src: Path, dest: Path, transform) -> None:
    """If `dest` is not already on disk, read `src`, run the CPU-only
    `transform` over its bytes and atomically write the result to `dest`.
    Used for both the phrase slice and the pause pad: a stat, a read, the
    transform and a write-plus-rename, all blocking, so callers run this
    with asyncio.to_thread instead of on the event loop, matching every
    other route in this file that touches disk or does real work."""
    if dest.exists():
        return
    _write_atomic(dest, transform(src.read_bytes()))


async def _resolve_line_audio(island: dict, idx: int, speed: float,
                               span: tuple[int, int] | None = None) -> Path:
    """Path to a line's rendered wav at the given speed, rendering and caching
    it first if it is not already on disk. Shared by the line audio route and
    the take cleaner, which needs the exact reference the phone played: the
    whole line, or (`span` set) the phrase that was looping when the take was
    recorded."""
    speed = round(min(config.SPEED_MAX, max(config.SPEED_MIN, speed)) * 20) / 20
    path = store.line_audio_path(island["id"], idx)
    if speed != 1.0:
        path = path.with_name(f"{idx}@{speed:.2f}.wav")
        if not await asyncio.to_thread(path.exists):
            if "lines" not in island:
                # The line route passes only the id; load the lines for a render.
                island = await asyncio.to_thread(store.get_island, island["id"])
                if island is None:
                    raise HTTPException(404, "no such island")
            line = next((l for l in island.get("lines", []) if l["idx"] == idx), None)
            if line is None:
                raise HTTPException(404, "no such line")
            if island["source"] != "voice":
                # Imported islands play the source recording, not VOICEVOX:
                # slow it down (pitch preserved) instead of re-synthesizing.
                base = store.line_audio_path(island["id"], idx)
                if not await asyncio.to_thread(base.exists):
                    raise HTTPException(404, "no audio for that line")
                ok = await asyncio.to_thread(media_io._stretch, base, path, speed)
                if not ok:
                    raise HTTPException(502, "could not change the playback speed")
            else:
                try:
                    wav, _, _, _ = await voices.speak(line["ja"], island["speaker"], speed)
                except (voicevox.VoicevoxError, kokoro_tts.KokoroError) as exc:
                    log.warning("voice failed: %s", exc)
                    raise HTTPException(502, {"code": "voice_unreachable"}) from exc
                await asyncio.to_thread(_write_atomic, path, wav)
    if span:
        sliced = path.with_name(_variant(idx, speed, span) + ".wav")
        try:
            await asyncio.to_thread(
                _cached_transform, path, sliced, lambda b: voicevox.slice_wav(b, *span)
            )
        except ValueError as exc:
            raise HTTPException(400, str(exc)) from exc
        path = sliced
    return path


# The longest silence the line audio route appends. The player's Pause stops at
# 10 s, but Drive's shadow gap (1.2 x a slow line) needs up to 20 s.
PAD_MAX_MS = 20000


def _clamp_pad(pad: int) -> int:
    return max(0, min(PAD_MAX_MS, pad))


_episode_locks: dict[str, asyncio.Lock] = {}


async def _ensure_episode(island_id: str, title: str) -> Path:
    """The whole episode as m4a at AUDIO_DIR/<id>/episode.m4a, built once from
    source.wav under a per-island lock. Raises HTTPException 409 no_episode
    when there is no source.wav."""
    folder = store.AUDIO_DIR / island_id
    wav = folder / "source.wav"
    dst = folder / "episode.m4a"
    async with _episode_locks.setdefault(island_id, asyncio.Lock()):
        if await asyncio.to_thread(dst.exists):
            return dst
        if not await asyncio.to_thread(wav.exists):
            raise HTTPException(409, detail={"code": "no_episode"})
        await asyncio.to_thread(
            export.encode_file_m4a, wav, dst, title,
            bitrate="64k", sample_rate=24000, timeout_s=600,
        )
    return dst
