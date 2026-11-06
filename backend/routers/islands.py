# Routes for islands, moved out of main.py.
import asyncio
import logging

from fastapi import APIRouter, Form, Header, HTTPException
from fastapi.responses import FileResponse

import config
import dependencies
import export
import progression
import store
import voicevox
import gloss as glossary
from services import build
from services import line_audio as line_audio_svc

router = APIRouter()
log = logging.getLogger("shadow")


@router.get("/shadow/islands")
def list_islands(authorization: str | None = Header(None), device: str = "",
                  x_shadow_device: str = Header("")) -> list[dict]:
    dependencies.require_token(authorization)
    dev = dependencies._require_device(x_shadow_device, device)
    # A say that failed (unclear, empty, no audio) already told the person on
    # the record screen, which reads it by id. It never gets a Home row.
    rows = [r for r in store.list_islands(dev)
            if not (r["source_name"] == "say" and r["status"] == "failed")]
    for row in rows:
        row["eta_s"] = build._eta_s(row)
        row["has_audio"] = store.line_audio_path(row["id"], 0).exists()
    return rows


@router.get("/shadow/islands/{island_id}")
async def get_island(island_id: str, authorization: str | None = Header(None),
                      x_shadow_device: str = Header("")) -> dict:
    dependencies.require_token(authorization)
    device = dependencies._require_device(x_shadow_device)
    island = await asyncio.to_thread(dependencies._own_island, island_id, device)
    island["known"] = await asyncio.to_thread(store.known_idxs, device, island_id)
    island["eta_s"] = await asyncio.to_thread(build._eta_s, island)
    # A re-voice or regenerate rewrites lines while the phone polls this
    # route, so backfill only a settled island.
    if island["status"] == "ready":
        await asyncio.to_thread(build._fill_words, island_id, island["lines"])
        await build._fill_accent(island)
    return island


@router.get("/shadow/islands/{island_id}/lines/{idx}/audio")
async def line_audio(island_id: str, idx: int, token: str = "", speed: float = 1.0,
                     pad: int = 0, start: int = -1, end: int = -1, device: str = "",
                     authorization: str | None = Header(None),
                     x_shadow_device: str = Header("")) -> FileResponse:
    """One line's wav. With `speed` other than 1, the line is re-synthesized
    at that speedScale (rounded to 0.05) and cached beside the original, so
    slow playback is natural speech rather than a stretched recording. With
    `pad` above 0, `pad` ms of silence is appended, cached beside the render,
    so the player can loop natively with the breath baked in rather than
    timing it in JS. With `start` and `end` both given, in milliseconds of
    the rendered audio, only that span (a phrase loop) is sliced out and
    served, cached beside the render the same way."""
    # Audio is fetched by the player, which cannot always set a header, so a
    # token query parameter is accepted here as well as the usual header.
    dependencies._token_or_header(token, authorization)
    dev = dependencies._require_device(x_shadow_device, device)
    await asyncio.to_thread(dependencies._require_owner, island_id, dev)
    span = line_audio_svc._span(start, end)
    path = await line_audio_svc._resolve_line_audio({"id": island_id}, idx, speed, span)
    if not await asyncio.to_thread(path.exists):
        raise HTTPException(404, "no audio for that line")
    pad = line_audio_svc._clamp_pad(pad)
    if pad > 0:
        speed_r = round(min(config.SPEED_MAX, max(config.SPEED_MIN, speed)) * 20) / 20
        # The "@" is what the stale sweep in _synthesize_lines (line 210) keys
        # on, so a padded file is removed along with the render it came from.
        padded = path.with_name(f"{line_audio_svc._variant(idx, speed_r, span)}+{pad}.wav")
        await asyncio.to_thread(line_audio_svc._cached_transform, path, padded, lambda b: voicevox.pad_wav(b, pad))
        path = padded
    return FileResponse(path, media_type="audio/wav")


@router.get("/shadow/islands/{island_id}/episode")
async def episode_audio(island_id: str, token: str = "", device: str = "",
                        authorization: str | None = Header(None),
                        x_shadow_device: str = Header("")) -> FileResponse:
    """The whole podcast or imported episode as one m4a, for continuous
    listening. FileResponse answers Range requests, which players need to seek."""
    dependencies._token_or_header(token, authorization)
    dev = dependencies._require_device(x_shadow_device, device)
    island = await asyncio.to_thread(dependencies._own_island, island_id, dev)
    if island.get("source") not in ("podcast", "import"):
        raise HTTPException(409, detail={"code": "no_episode"})
    path = await line_audio_svc._ensure_episode(island_id, island.get("title") or "Episode")
    return FileResponse(path, media_type="audio/mp4")


# Per island and cache key. Entries are tiny and keys are bounded by what one
# user exports, so they are never evicted.
_export_locks: dict[str, asyncio.Lock] = {}


@router.get("/shadow/islands/{island_id}/export")
async def export_island(island_id: str, speed: float = 1.0, repeats: int = 2,
                        gap: int = 2000, token: str = "", device: str = "",
                        authorization: str | None = Header(None),
                        x_shadow_device: str = Header("")) -> FileResponse:
    """The island as one m4a file for listening outside the app: each line
    played `repeats` times with `gap` ms of silence after every play, at
    `speed`, in the island's voice. Built once per distinct content and
    parameters and kept on disk under a content hash; dropped whenever the
    island is re-voiced or regenerated."""
    dependencies._token_or_header(token, authorization)
    dev = dependencies._require_device(x_shadow_device, device)
    island = await asyncio.to_thread(dependencies._own_island, island_id, dev)
    if island["status"] != "ready":
        raise HTTPException(409, "the island is still being built")
    if not island["lines"]:
        raise HTTPException(409, "the island has no lines")

    spec = export.normalise(speed, repeats, gap)
    key = export.cache_key(island, spec)
    path = export.export_path(island["id"], key)
    if not path.exists():
        # One build per key at a time. A second request for the same key waits
        # here and then finds the file the first one wrote.
        async with _export_locks.setdefault(f"{island['id']}/{key}", asyncio.Lock()):
            if not path.exists():
                wavs = []
                for line in island["lines"]:
                    p = await line_audio_svc._resolve_line_audio(island, line["idx"], spec.speed)
                    if not p.exists():
                        raise HTTPException(409, f"line {line['idx'] + 1} has no audio")
                    wavs.append(p.read_bytes())
                try:
                    await asyncio.to_thread(
                        export.build, wavs, spec, path, island["title"] or "Island"
                    )
                except export.ExportError as exc:
                    log.error("export %s/%s failed: %s", island["id"], key, exc)
                    raise HTTPException(500, "could not build the audio file") from exc

    return FileResponse(
        path,
        media_type="audio/mp4",
        filename=export.file_name(island["title"], spec.speed),
        headers={"Cache-Control": "no-store"},
    )


@router.delete("/shadow/islands/{island_id}")
def delete_island(island_id: str, authorization: str | None = Header(None),
                   x_shadow_device: str = Header("")) -> dict:
    dependencies.require_token(authorization)
    device = dependencies._require_device(x_shadow_device)
    dependencies._require_owner(island_id, device)
    store.delete_island(island_id)
    return {"ok": True}


@router.patch("/shadow/islands/{island_id}/title")
def rename_island(
    island_id: str,
    title: str = Form(...),
    authorization: str | None = Header(None),
    x_shadow_device: str = Header(""),
) -> dict:
    dependencies.require_token(authorization)
    device = dependencies._require_device(x_shadow_device)
    dependencies._require_owner(island_id, device)
    title = title.strip() or "Untitled island"
    store.set_title(island_id, title)
    return {"id": island_id, "title": title}


@router.get("/shadow/islands/{island_id}/glosses")
async def island_glosses(island_id: str, authorization: str | None = Header(None),
                         x_shadow_device: str = Header("")) -> dict:
    """The meanings of every word in a Japanese island, keyed by the word as
    the word-audio route cleans it. Lets the phone store them for offline
    use in one request instead of one per word. Other languages have no
    glosses and return {}."""
    dependencies.require_token(authorization)
    device = dependencies._require_device(x_shadow_device)
    island = await asyncio.to_thread(dependencies._own_island, island_id, device)
    if island.get("language", "ja") != "ja":
        return {}
    words: list[str] = []
    seen: set[str] = set()
    for line in island.get("lines", []):
        for w in line.get("words") or []:
            clean = (w.get("text") or "").strip(config.WORD_STRIP)
            if clean and clean not in seen:
                seen.add(clean)
                words.append(clean)

    def _all() -> dict:
        return {w: glossary.gloss(w) for w in words}

    return await asyncio.to_thread(_all)


def _known_line(island_id: str, idx: int, device: str) -> None:
    """404 unless `device` owns the island and the line exists."""
    island = dependencies._own_island(island_id, device)
    if not any(l["idx"] == idx for l in island["lines"]):
        raise HTTPException(404, "no such line")


def _mark_known(device: str, island_id: str, idx: int) -> dict:
    _known_line(island_id, idx, device)
    award = None
    if store.mark_known(device, island_id, idx) and store.has_line_take(device, island_id, idx):
        award = progression.award_known(device, island_id, idx)
    return {"known": store.known_idxs(device, island_id),
            "total": store.count_known(device), "award": award}


def _unmark_known(device: str, island_id: str, idx: int) -> dict:
    _known_line(island_id, idx, device)
    store.unmark_known(device, island_id, idx)
    return {"known": store.known_idxs(device, island_id), "total": store.count_known(device)}


@router.post("/shadow/islands/{island_id}/lines/{idx}/known")
async def mark_known(
    island_id: str,
    idx: int,
    authorization: str | None = Header(None),
    x_shadow_device: str = Header(""),
) -> dict:
    """"Easy for me": the line leaves Practice now and the island's later
    lines skip the prep passes. The award pays once per line, only when the
    mark is new and the line was ever taken whole; otherwise `award` is
    None. Returns the island's known idxs and the device's total."""
    dependencies.require_token(authorization)
    device = dependencies._require_device(x_shadow_device)
    return await asyncio.to_thread(_mark_known, device, island_id, idx)


@router.delete("/shadow/islands/{island_id}/lines/{idx}/known")
async def unmark_known(
    island_id: str,
    idx: int,
    authorization: str | None = Header(None),
    x_shadow_device: str = Header(""),
) -> dict:
    """Takes the mark back. Idempotent; a paid award stays paid."""
    dependencies.require_token(authorization)
    device = dependencies._require_device(x_shadow_device)
    return await asyncio.to_thread(_unmark_known, device, island_id, idx)
