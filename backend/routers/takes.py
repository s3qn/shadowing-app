# Routes for takes, moved out of main.py.
import asyncio
import logging
import shutil
import tempfile
import time
from pathlib import Path

from fastapi import APIRouter, File, Form, Header, HTTPException, UploadFile
from fastapi.responses import FileResponse
from pydantic import BaseModel, Field

import config
import dependencies
import progression
import review_session
import store
import transcribe
from services import line_audio as line_audio_svc

log = logging.getLogger("shadow")

router = APIRouter()


def _round(value: float | None, places: int = 1) -> float | None:
    return None if value is None else round(float(value), places)


def _run_calibration(src: Path, ref_path: Path, device: str) -> dict:
    """Learn the phone's speaker-to-mic path from a silent recording and store
    it. Blocking: two ffmpeg decodes and several passes of the filter, so it
    is called in a thread."""
    import aec

    profile = aec.calibrate(aec.decode(ref_path), aec.decode(src))
    aec.save_profile(line_audio_svc._take_profile_name(device), profile)
    return {
        "cleaned": True,
        "erleDb": _round(profile.erle_db),
        "delayMs": _round(profile.delay * 1000.0 / aec.SR),
        "driftSamples": None,
        "frozenBlocks": None,
        "note": "Speaker profile saved",
    }


def _is_guide_island(island: dict) -> bool:
    """The 3-line starter island the first-run guide opens. Only the
    guide's first take on it is scored leniently (BL-54)."""
    return island.get("source") == "starter"


def _run_clean(src: Path, ref_path: Path, profile, island_id: str, idx: int,
               line: dict, speed: float, span: tuple[int, int] | None,
               lag_ms: int, line_start_ms: int, language: str = "ja",
               lenient: bool = False, silent: bool = False) -> dict:
    """Take the played line back out of a take, store both versions, score
    the take's timing against the line's words, and analyse mora length and
    pitch accent. Blocking, for the same reasons as _run_calibration.

    `silent` is a turn-taking take: the phone was on its speaker, so the
    mic opened after the count with no line playing. There is no echo to
    remove and no bleed to check for; the score anchors on `line_start_ms`
    (0, the recording's start) like any uncleaned take."""
    import aec
    import take_analysis
    import take_score

    ref_audio = aec.decode(ref_path)
    mic = aec.decode(src)
    if silent:
        result = aec.Result(cleaned=False, note="No line played under the take", output=mic.copy())
    else:
        result = aec.clean(ref_audio, mic, profile)

    raw_path, clean_path = store.take_paths(island_id, idx)
    aec.encode(raw_path, mic)
    if result.cleaned:
        aec.encode(clean_path, result.output)
    else:
        # This line may have had a cleanable take before. Leaving that file
        # behind would let /take/clean serve the previous take's audio as if
        # it belonged to the one just uploaded.
        clean_path.unlink(missing_ok=True)

    if result.cleaned:
        anchor_ms, anchor = result.delay_ms, "echo"
    elif line_start_ms >= 0:
        anchor_ms, anchor = float(line_start_ms), "clock"
    else:
        anchor_ms, anchor = None, None
    take_for_score = result.output if result.cleaned else mic
    try:
        score = take_score.score_take(
            ref_audio, take_for_score, aec.SR, line["words"], speed, span,
            anchor_ms, lag_ms, anchor, lenient,
        )
    except Exception:
        log.exception("take scoring failed island=%s idx=%d", island_id, idx)
        n = len(line["words"])
        score = {
            "words": ["none"] * n,
            "offsetsMs": [None] * n,
            "behindMs": None,
            "anchor": anchor,
            "note": "Could not score the take",
        }

    try:
        analysis = take_analysis.analyse(
            ref_audio, take_for_score, aec.SR, line.get("timeline") or [],
            speed, span, anchor_ms, result.cleaned, result.erle_db,
        )
    except Exception:
        log.exception("take analysis failed island=%s idx=%d", island_id, idx)
        analysis = {
            "note": "Could not analyse the take",
            "aligned": None,
            "coverage": 0.0,
            "moras": [],
            "curve": {"line": [], "take": []},
        }

    import take_content

    # An uncleaned take recorded over the speaker still holds the line
    # itself, which whisper would read back as a perfect shadow. A silent
    # take had no line to pick up, so the check is skipped.
    try:
        echo_left = not silent and not result.cleaned and aec.heard_speaker(ref_audio, mic)
    except Exception:
        log.exception("bleed check failed island=%s idx=%d", island_id, idx)
        echo_left = False
    line_text = take_content.span_text(line["words"], span, speed, line["ja"], language)
    score = _bl51_total(score, analysis, clean_path if result.cleaned else raw_path,
                        line_text, language, echo_left)

    return {
        "cleaned": result.cleaned,
        "erleDb": _round(result.erle_db),
        "delayMs": _round(result.delay_ms),
        "driftSamples": result.drift_samples,
        "frozenBlocks": result.frozen_blocks,
        "note": result.note,
        "score": score,
        "analysis": analysis,
    }


def _op_take_reply(response: dict) -> dict:
    """The take reply as stored for an op replay: everything but the
    analysis curve, which is the one large part and only draws a picture."""
    analysis = response.get("analysis")
    if not isinstance(analysis, dict) or "curve" not in analysis:
        return response
    return {**response, "analysis": {k: v for k, v in analysis.items() if k != "curve"}}


@router.post("/shadow/islands/{island_id}/lines/{idx}/take")
async def upload_take(
    island_id: str,
    idx: int,
    take: UploadFile = File(...),
    speed: float = Form(1.0),
    calibrate: str = Form("0"),
    start: int = Form(-1),
    end: int = Form(-1),
    lag: int = Form(0),
    line_start: int = Form(-1),
    guide: str = Form("0"),
    silent: str = Form("0"),
    op: str = Form(""),
    authorization: str | None = Header(None),
    x_shadow_device: str = Header(""),
) -> dict:
    """Clean a shadow take against the line that was playing while it was
    recorded, or (calibrate=1) learn the phone's speaker-to-mic path from a
    silent recording of that same line. A take recorded over a phrase carries
    `start`/`end` so it is cleaned against that same phrase, not the whole
    line. `lag` (the phone's Lag setting, ms) and `line_start` (ms from the
    start of the recording to the line's first audio, for takes with no
    echo to find the anchor in) feed the take's timing score; both are
    ignored for a calibration upload. `guide=1` comes from the first-run
    guide's shadow moment: that island's first take is scored leniently.
    `silent=1` is a turn-taking take (speaker, no line under the voice):
    the speaker profile and the bleed check are skipped and the score
    anchors on `line_start`, which the client sends as 0. `op` (offline-first)
    is the phone's id for this take: a replay of a claimed op (the outbox
    resending after a lost reply) scores nothing, pays nothing and gets the
    first reply back, minus the analysis curve. Ignored for a calibration.

    A take uploaded before the phone has a stored profile is kept as
    recorded and scored on `line_start` rather than refused: with headphones
    there is nothing to clean, and Speak-with-headset is now the common
    first upload on a new phone. Calibration still learns the speaker-to-mic
    path for anyone who later shadows over the speaker. See aec.py for how
    the path is learned and applied."""
    dependencies.require_token(authorization)
    device = dependencies._require_device(x_shadow_device)
    began_at = time.monotonic()
    is_calibration = calibrate == "1"
    is_silent = silent == "1" and not is_calibration
    op = "" if is_calibration or not isinstance(op, str) else op
    if op and not store.valid_op(op):
        raise HTTPException(400, "bad op")

    island = await asyncio.to_thread(dependencies._own_island, island_id, device)
    line = next((l for l in island["lines"] if l["idx"] == idx), None)
    if line is None:
        raise HTTPException(404, "no such line")
    # Claimed before the daily slot and the clean, so a replay costs nothing.
    if op and not await asyncio.to_thread(store.claim_op, device, op):
        return await asyncio.to_thread(store.op_reply, device, op) or {}
    span = line_audio_svc._span(start, end)
    # The same rounding _resolve_line_audio applies before it renders, so the
    # score's word windows use the speed the reference audio was actually
    # played at rather than the raw value the client sent.
    render_speed = round(
        min(line_audio_svc.SPEED_MAX, max(line_audio_svc.SPEED_MIN, speed)) * 20
    ) / 20

    try:
        # Imported lazily so the app still starts if this module is broken
        # or, since it is being written in parallel, does not exist yet.
        import aec
    except Exception as exc:
        log.exception("aec module unavailable")
        raise HTTPException(503, "the take cleaner is not available") from exc

    profile = None
    if not is_calibration and not is_silent:
        profile = line_audio_svc._load_take_profile(aec, device)

    raw = await take.read()
    if not raw:
        raise HTTPException(400, "empty upload")
    if len(raw) > config.MAX_UPLOAD_BYTES:
        raise HTTPException(413, "take too large")

    dependencies._take_use_slot(device, "take")
    tmp_dir = Path(tempfile.mkdtemp(prefix=f"take-{island_id}-{idx}-"))
    try:
        suffix = Path(take.filename or "take.wav").suffix or ".wav"
        src = tmp_dir / f"upload{suffix}"
        src.write_bytes(raw)
        ref_path = await line_audio_svc._resolve_line_audio(island, idx, speed, span)

        # ffmpeg and the filter are seconds of blocking CPU. On the event loop
        # they would stall every other request for the duration, including the
        # island list the phone polls while it waits for this one.
        if is_calibration:
            response = await asyncio.to_thread(_run_calibration, src, ref_path, device)
        else:
            lag_ms = max(0, min(5000, lag))
            lenient = (guide == "1" and _is_guide_island(island)
                       and not await asyncio.to_thread(store.has_take_score, device, island_id))
            response = await asyncio.to_thread(
                _run_clean, src, ref_path, profile, island_id, idx,
                line, render_speed, span, lag_ms, line_start, island.get("language", "ja"),
                lenient, silent=is_silent,
            )
            try:
                response["award"] = await asyncio.to_thread(
                    # cat-xp awards
                    progression.award_take, device, island_id, idx,
                    response.get("score"), render_speed, span is None,
                    [l["idx"] for l in island["lines"]],
                )
            except Exception:
                log.exception("take award failed")
            try:
                await asyncio.to_thread(
                    store.add_take_score, device, island_id, idx, island.get("language", "ja"),
                    response["score"], render_speed, span is None,
                )
            except Exception:
                log.exception("take score save failed")
            if op:
                try:
                    await asyncio.to_thread(
                        store.set_op_reply, device, op, _op_take_reply(response)
                    )
                except Exception:
                    log.exception("take op reply save failed")
    finally:
        shutil.rmtree(tmp_dir, ignore_errors=True)
        log.info(
            "take island=%s idx=%d calibrate=%s took %.2fs",
            island_id, idx, is_calibration, time.monotonic() - began_at,
        )
    return response


@router.get("/shadow/islands/{island_id}/lines/{idx}/take/clean")
async def take_clean(island_id: str, idx: int, token: str = "", v: str = "", device: str = "",
                     authorization: str | None = Header(None),
                     x_shadow_device: str = Header("")) -> FileResponse:
    """The cleaned copy of a take. `v` is the take's recordedAt, accepted so
    the player's cache key changes with each new take; the file is served
    with no-store regardless, since the same URL can point at a different
    take between calls."""
    dependencies._token_or_header(token, authorization)
    dev = dependencies._require_device(x_shadow_device, device)
    await asyncio.to_thread(dependencies._require_owner, island_id, dev)
    _, clean_path = store.take_paths(island_id, idx)
    if not clean_path.exists():
        raise HTTPException(404, "no cleaned take for that line")
    return FileResponse(
        clean_path, media_type="audio/wav", headers={"Cache-Control": "no-store"}
    )


# BL-51 score
def _bl51_total(score: dict, analysis: dict, take_path: Path, line_text: str, language: str,
                echo_left: bool = False) -> dict:
    """Adds total, parts, heard and totalNote to a take's score: whisper's
    reading of the take against the line, blended with timing and pitch.
    `echo_left` (the take still holds the played line) skips whisper and
    leaves content out of the blend. Never raises."""
    import take_content

    out = dict(score)
    try:
        if out.get("note") == "No voice heard in the take":
            out.update(total=None, parts={"content": None, "timing": None, "pitch": None},
                       heard="", totalNote=out["note"])
            return out
        heard = {"ok": False} if echo_left else transcribe.transcribe(take_path, language=language, fast=True)
        content = None
        if heard.get("ok"):
            content = take_content.content_score(line_text, heard.get("text", ""), language)
        timing = take_content.timing_score(out)
        pitch = take_content.pitch_score(analysis)
        total = take_content.blend(content, timing, pitch)
        out.update(
            total=total,
            parts={"content": content, "timing": timing, "pitch": pitch},
            heard=heard.get("text", "") if heard.get("ok") else "",
            totalNote="" if total is not None else "Could not hear the words",
        )
    except Exception:
        log.exception("take total failed")
        out.update(total=None, parts={"content": None, "timing": None, "pitch": None},
                   heard="", totalNote="Could not score the take")
    return out


# BL-51 xp
class ReviewFinishedBody(BaseModel):
    session_id: str = Field(min_length=1, max_length=64)
    sentences: int = Field(ge=0, le=10000)
    seconds: float = Field(ge=0, le=86400)
    avg_score: float | None = None
    local_day: str
    lines: list["SessionLine"] = Field(default_factory=list, max_length=200)
    completed: bool = True


class SessionLine(BaseModel):
    island_id: str = Field(min_length=1, max_length=64)
    idx: int = Field(ge=0, le=100000)
    seconds: float = Field(ge=0, le=86400)
    score: int | None = None


ReviewFinishedBody.model_rebuild()


@router.post("/shadow/review/session-finished")
async def review_session_finished(
    body: ReviewFinishedBody,
    authorization: str | None = Header(None),
    x_shadow_device: str = Header(""),
) -> dict:
    dependencies.require_token(authorization)
    device = dependencies._require_device(x_shadow_device)
    await asyncio.to_thread(
        review_session.finish, device, body.session_id, body.sentences, body.seconds,
        body.avg_score, [ln.model_dump() for ln in body.lines], body.completed,
    )
    return await asyncio.to_thread(
        progression.award_review, device, body.session_id, body.sentences,
        body.seconds, body.avg_score, body.local_day,
    )
