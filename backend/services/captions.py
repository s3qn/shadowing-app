# Caption-based video islands: build from caption lines, parallel translation,
# the caption request body and captions.json, and the ASR context repair job.
import asyncio
import json
import logging

from fastapi import HTTPException, Request

import asr_transfer
import config
import generate
import latin
import repair
import segment
import store
import store_video
import youtube

log = logging.getLogger("shadow")


async def _build_from_captions(island_id: str, lines: list[dict], title: str,
                               language: str = "ja", native: str = "en", asr: bool = False,
                               asr_tokens: list[dict] | None = None) -> None:
    """Build a video island from caption lines. No audio exists, so lines get
    their reading and word times from the json3 seg onsets (an even pace when the track has none), with `offset` = the caption start.
    ja lines are split at clause ends; ASR ja text is repaired after the
    island is ready (repair.job, below).
    `asr_tokens` (youtube.asr_tokens of the auto track, when the picked track
    is manual) move ja lines onto the voice first: see asr_transfer."""
    from routers import align as align_r  # lazy: routers.align imports this module
    asr_report: dict | None = None
    try:
        store.set_media(island_id, max((ln["end"] for ln in lines), default=0.0))
        # yt-drift: a manual caption runs until the next caption, so a ja line
        # with no pieces ends its speech at mora count / the track's mora rate
        # and the rest is silence (segment.speech_end); the same clock places
        # the split cuts.
        rate = 0.0
        trimmed_s = 0.0
        if language == "ja":
            lines = await asyncio.to_thread(youtube.stretch_lumps, lines)
            rate = await asyncio.to_thread(
                segment.mora_rate, [(ln["text"], ln["end"] - ln["start"]) for ln in lines])
            if asr_tokens:
                lines, asr_report = await asyncio.to_thread(asr_transfer.attach, lines, asr_tokens, rate)
                log.info("island %s asr transfer: anchored %d of %d, median shift %.2f s, max %.2f s",
                         island_id, asr_report["anchored"], asr_report["lines"],
                         asr_report["median_shift_s"], asr_report["max_shift_s"])
            lines = youtube.split_lines(lines, rate=rate)
            if asr_report is not None:
                lines = asr_transfer.trim_tails(lines)
        cue_list = youtube.cues_from_lines(lines)
        store.set_stage(island_id, "aligning")
        ja_texts: list[str] = []
        last_end = 0.0
        for i, cue in enumerate(cue_list):
            duration = max(cue["end"] - cue["start"], 0.05)
            pieces = cue.get("pieces", [])
            if language == "ja":
                speech_end = None if pieces else segment.speech_end(cue["text"], duration, rate)
                if speech_end is not None:
                    trimmed_s += duration - speech_end
                words = await asyncio.to_thread(segment.align_pieces, cue["text"], pieces, duration, speech_end)
                kana = segment.reading(cue["text"])
            else:
                words = await asyncio.to_thread(latin.align, cue["text"], pieces, duration)
                kana = ""
            line = {"ja": cue["text"], "kana": kana, "romaji": "", "en": ""}
            store.add_line(island_id, i, line, round(duration, 3), [], words, offset=cue["start"])
            ja_texts.append(cue["text"])
            last_end = max(last_end, cue["end"])
        store_video.set_video_duration(island_id, last_end)
        # yt-precise: the timing is settled at build; the video screen only
        # syncs islands whose align status is still empty.
        store_video.set_align_status(island_id, "done", _asr_code(asr_report))
        # youtube-asr-context-repair: claim the text pass before the island
        # reads as ready, so the player's first open finds it queued and does
        # not start a second pass that races the translation loop below.
        repair_claimed = store_video.claim_repair(island_id, repair.REPAIR_MAX_ATTEMPTS, repair.VERSION)
        store.set_ready(island_id, title)
        align_r._align_resume(island_id)  # bl36-align: an upload that came in mid-build
        log.info("island %s ready from captions: %d lines, mora rate %.1f/s, trimmed %.1f s of silence",
                 island_id, len(ja_texts), rate, trimmed_s)
    except Exception as exc:
        log.exception("captions build %s failed", island_id)
        store.set_failed(island_id, str(exc))
        align_r._align_resume(island_id)
        return

    # Ready already: a translation error only costs the English.
    try:
        await _translate_batches(island_id, ja_texts, language, native)
    except Exception:
        log.exception("island %s: translation stopped early, the island stays ready", island_id)
    # youtube-asr-context-repair: the text pass runs once the English is in,
    # inside this background task, one video at a time.
    if repair_claimed:
        await _repair_job(island_id, asr and language == "ja")


TRANSLATE_WORKERS = 3


async def _translate_batches(island_id: str, texts: list[str], language: str, native: str) -> None:
    """Translate in TRANSLATE_BATCH chunks, TRANSLATE_WORKERS at a time. Each
    batch is saved as it lands, so a failure keeps the finished ones; the
    first error is raised after the rest settle."""
    sem = asyncio.Semaphore(TRANSLATE_WORKERS)
    n = generate.TRANSLATE_BATCH

    async def one(b: int) -> None:
        batch = texts[b:b + n]
        async with sem:
            translations = await asyncio.to_thread(
                generate.translate_lines, batch, language, native,
                texts[max(0, b - 2):b], texts[b + len(batch):b + len(batch) + 2])
        for offset, en in enumerate(translations):
            if en:
                store.set_en(island_id, b + offset, en)

    results = await asyncio.gather(*(one(b) for b in range(0, len(texts), n)),
                                   return_exceptions=True)
    for r in results:
        if isinstance(r, BaseException):
            raise r


async def _captions_body(request: Request) -> dict:
    """A caption request's JSON object, streamed under CAPTIONS_MAX_BODY:
    413 when bigger, 400 captions_invalid when not a JSON object."""
    declared = request.headers.get("content-length")
    if declared and declared.isdigit() and int(declared) > youtube.CAPTIONS_MAX_BODY:
        raise HTTPException(413, {"code": "captions_invalid"})
    raw = bytearray()
    async for chunk in request.stream():
        raw += chunk
        if len(raw) > youtube.CAPTIONS_MAX_BODY:
            raise HTTPException(413, {"code": "captions_invalid"})
    try:
        body = json.loads(bytes(raw))
    except ValueError:
        raise HTTPException(400, {"code": "captions_invalid"})
    if not isinstance(body, dict):
        raise HTTPException(400, {"code": "captions_invalid"})
    return body


def _asr_code(report: dict | None) -> str:
    """The align_error word for a finished transfer: asr_none (no ASR track
    or no tokens), asr_low_match (under a fifth of the lines anchored), asr."""
    if not report or not report.get("tokens", 1):
        return "asr_none"
    if report["anchored"] < config.ASR_MIN_ANCHORED * report["lines"]:
        return "asr_low_match"
    return "asr"


def _write_captions_json(island_id: str, video_id: str, events: list | None, asr_events: list) -> None:
    """audio/<id>/captions.json: both raw tracks, the retime's input and the
    fixture source. Keeps the manual events already on disk when the caller
    has none."""
    from services import line_audio
    path = store.AUDIO_DIR / island_id / "captions.json"
    if events is None and path.exists():
        try:
            events = json.loads(path.read_text()).get("events")
        except (OSError, ValueError):
            events = None
    path.parent.mkdir(parents=True, exist_ok=True)
    line_audio._write_atomic(path, json.dumps({"video_id": video_id, "events": events or [],
                                         "asr_events": asr_events}, ensure_ascii=False).encode())


# One video repairs at a time: the pass shares the claude CLI with builds and
# catch meanings. The island is already playable while it waits.
_repair_gate = asyncio.Semaphore(1)


async def _repair_job(island_id: str, asr: bool | None = None) -> None:
    """Run repair.job for one claimed island under the gate. The job sets
    the final status itself (done or failed)."""
    try:
        async with _repair_gate:
            await asyncio.to_thread(store_video.set_repair_status, island_id, "running")
            await asyncio.to_thread(repair.job, island_id, asr)
    except Exception:
        log.exception("repair job %s crashed", island_id)
        store_video.set_repair_status(island_id, "failed", "repair_error")


def _repair_recover() -> None:
    """Rows still queued or running died with the old process: run them again."""
    for island_id in store_video.list_repair_pending():
        store_video.set_repair_status(island_id, "queued")
        asyncio.get_event_loop().create_task(_repair_job(island_id))
