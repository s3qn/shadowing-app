# Routes for align, moved out of main.py.
import asyncio
import json
import logging
import wave
from pathlib import Path

from fastapi import APIRouter

import align
import caption_timing
import config
import latin
import segment
import store
import store_video
import youtube
import media as media_io
from services import captions

router = APIRouter()
log = logging.getLogger("shadow")

# --- bl36-align ---
_align_queue: asyncio.Queue | None = None
# Uploads that reached the consumer before their island finished building.
_align_deferred: set[str] = set()


def _get_align_queue() -> asyncio.Queue:
    global _align_queue
    if _align_queue is None:
        _align_queue = asyncio.Queue()
    return _align_queue


async def _asr_retime(island_id: str) -> None:
    """Retime one video island's lines from the ASR track in captions.json
    (caption_timing.transfer, which keeps timing-before.json). Any failure
    leaves the lines as they were and records asr_error."""
    store_video.set_align_status(island_id, "running")
    try:
        def work() -> dict:
            path = store.AUDIO_DIR / island_id / "captions.json"
            data = json.loads(path.read_text()) if path.exists() else {}
            tokens = youtube.asr_tokens(data.get("asr_events") or [])
            return caption_timing.transfer(island_id, tokens, apply=True)

        report = await asyncio.to_thread(work)
        store_video.set_align_status(island_id, "done", captions._asr_code(report))
        log.info("island %s asr transfer: anchored %d of %d, %d lines written, median shift %.2f s, max %.2f s",
                 island_id, report["anchored"], report["lines"], report["written"],
                 report["median_shift_s"], report["max_shift_s"])
    except Exception:
        log.exception("island %s asr transfer crashed", island_id)
        store_video.set_align_status(island_id, "failed", "asr_error")


def _align_cleanup(island_id: str) -> None:
    for kind in ("src", "wav", "job.json", "out.json"):
        store_video.video_audio_path(island_id, kind).unlink(missing_ok=True)


def _wav_seconds(path: Path) -> float:
    with wave.open(str(path), "rb") as w:
        return w.getnframes() / float(w.getframerate())


def _align_resume(island_id: str) -> None:
    """The captions build has ended (ready or failed). An upload the consumer
    parked while the lines were still being corrected and split goes back on
    the queue, so the aligner reads the final lines. Called with no await
    between it and set_ready/set_failed: see _align_one."""
    if island_id in _align_deferred:
        _align_deferred.discard(island_id)
        _get_align_queue().put_nowait(island_id)


async def _align_one(island_id: str) -> None:
    """Align one video island's captions to its uploaded audio. Any failure
    leaves the step-1 words and offsets and records a code on the video row.

    While the island is still building (BL-45 correction can outlast any fixed
    wait) the job is parked in _align_deferred, still 'queued', upload kept, and
    _align_resume requeues it when the build ends. The status read and the
    park/run decision are synchronous, as are set_ready and _align_resume, so
    exactly one of them runs it: no double run, no lost job."""
    status = store_video.island_status(island_id)
    if status is None:
        _align_cleanup(island_id)
        return
    if status in ("pending", "working"):
        _align_deferred.add(island_id)
        log.info("island %s still building, alignment waits for it", island_id)
        return
    try:
        if status != "ready":
            raise align.AlignError("align_not_ready")
        store_video.set_align_status(island_id, "running")
        island = await asyncio.to_thread(store.get_island, island_id)
        if island is None:
            return
        lines = [
            {"idx": ln["idx"], "text": ln["ja"], "offset": ln["offset"],
             "duration": ln["duration"], "words": ln["words"]}
            for ln in island["lines"]
        ]
        src = store_video.video_audio_path(island_id, "src")
        wav = store_video.video_audio_path(island_id, "wav")
        if not src.exists() or not await asyncio.to_thread(media_io._to_wav, src, wav, config.ALIGN_MAX_SECONDS):
            raise align.AlignError("align_decode")
        try:
            audio_len = await asyncio.to_thread(_wav_seconds, wav)
        except Exception as exc:
            raise align.AlignError("align_decode") from exc
        windows = align.windows_from_lines(lines, audio_len)
        if windows:
            job = store_video.video_audio_path(island_id, "job.json")
            job.write_text(json.dumps({
                "wav": str(wav),
                "language": align.LANGUAGE_NAMES.get(island.get("language", "ja"), "Japanese"),
                "windows": [{k: w[k] for k in ("id", "start", "end", "text")} for w in windows],
            }, ensure_ascii=False), encoding="utf-8")
            result = await asyncio.to_thread(
                align.run_job, job, store_video.video_audio_path(island_id, "out.json"),
                timeout=config.ALIGN_TIMEOUT_S, unit=island_id,
            )
            by_idx = {ln["idx"]: ln for ln in lines}
            updates = align.apply(windows, lines, result)
            for upd in updates:
                line = by_idx[upd["idx"]]
                if island.get("language", "ja") == "ja":
                    words = await asyncio.to_thread(
                        segment.align_pieces, line["text"], upd["pieces"], upd["duration"])
                else:
                    words = await asyncio.to_thread(
                        latin.align, line["text"], upd["pieces"], upd["duration"])
                wrote = await asyncio.to_thread(
                    store.set_words, island_id, upd["idx"], words, line["words"])
                if wrote:
                    store_video.set_line_span(island_id, upd["idx"], upd["offset"], upd["duration"])
            log.info("island %s aligned: %d lines retimed, peak_rss_mb=%s", island_id,
                     len(updates), result.get("peak_rss_mb"))
        store_video.set_align_status(island_id, "done")
    except align.AlignError as exc:
        log.warning("island %s alignment failed: %s", island_id, exc)
        store_video.set_align_status(island_id, "failed", exc.code)
    except Exception:
        log.exception("island %s alignment crashed", island_id)
        store_video.set_align_status(island_id, "failed", "align_error")
    finally:
        _align_cleanup(island_id)


async def _align_consumer() -> None:
    queue = _get_align_queue()
    while True:
        island_id = await queue.get()
        try:
            await _align_one(island_id)
        except Exception:
            log.exception("align consumer: island %s", island_id)
        finally:
            queue.task_done()


def _align_recover() -> None:
    """Rows still queued or running died with the old process: requeue those
    whose upload survived, fail the rest."""
    for island_id in store_video.list_align_pending():
        if store_video.video_audio_path(island_id, "src").exists():
            store_video.set_align_status(island_id, "queued")
            _get_align_queue().put_nowait(island_id)
        else:
            store_video.set_align_status(island_id, "failed", "align_interrupted")
# --- end bl36-align ---
