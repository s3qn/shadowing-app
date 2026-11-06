# Routes for grammar, moved out of main.py.
import logging

from fastapi import APIRouter, BackgroundTasks, Form, Header, HTTPException

import dependencies
import generate
import grammar
import store
import voices
import voicevox
from services import build

log = logging.getLogger("shadow")

router = APIRouter()


# --- grammar-islands ---
@router.get("/shadow/grammar/levels")
def grammar_levels(authorization: str | None = Header(None),
                   x_shadow_device: str = Header("")) -> dict:
    dependencies.require_token(authorization)
    dependencies._require_device(x_shadow_device)
    return {"levels": grammar.levels()}


@router.get("/shadow/grammar/points")
def grammar_points(level: str = "", q: str = "",
                   authorization: str | None = Header(None),
                   x_shadow_device: str = Header(""), point: str = "") -> dict:
    """Points for a level or a search; `point` reads that one id directly."""
    dependencies.require_token(authorization)
    device = dependencies._require_device(x_shadow_device)
    if point:
        row = grammar.get(point)
        points = [row] if row else []
    else:
        points = grammar.search(q) if q.strip() else grammar.list_points(level)
    if level and q.strip():
        points = [p for p in points if p["level"] == level]
    added = {
        i["source_name"] for i in store.list_islands(device)
        if i["source"] == "grammar" and i["status"] != "failed"
    }
    return {"points": [{**p, "added": p["id"] in added} for p in points]}


@router.post("/shadow/grammar/import")
async def import_grammar(
    background: BackgroundTasks,
    point: str = Form(...),
    speaker: int = Form(voicevox.DEFAULT_SPEAKER),
    register: str = Form("polite"),
    native: str = Form("en"),
    authorization: str | None = Header(None),
    x_shadow_device: str = Header(""),
) -> dict:
    """Add a grammar point as an island; a repeat pick returns the existing one."""
    dependencies.require_token(authorization)
    device = dependencies._require_device(x_shadow_device)
    if register not in generate.REGISTER_RULES:
        raise HTTPException(400, "register must be 'polite' or 'casual'")
    if native not in ("he", "en"):
        raise HTTPException(400, "native must be 'he' or 'en'")
    if voices.language_for(speaker) != "ja":
        raise HTTPException(400, "that voice does not speak Japanese")
    row = grammar.get(point)
    if row is None:
        raise HTTPException(404, f"no such grammar point: {point}")
    for existing in store.list_islands(device):
        if (existing["source"] == "grammar" and existing["status"] != "failed"
                and existing["source_name"] == row["id"]):
            return {"id": existing["id"], "status": existing["status"]}

    dependencies._take_build_slot(device, "create", "create")
    island_id = store.create_island(
        "simple", speaker, register, "ja", native=native, source="grammar",
        source_name=row["id"], device=device,
    )

    async def run() -> None:
        try:
            await build._build_grammar(island_id, row, speaker, register, native)
        except Exception as exc:
            log.exception("island %s failed", island_id)
            store.set_failed(island_id, str(exc))

    background.add_task(dependencies._refunding(run, island_id, device, "create", "create"))
    return {"id": island_id, "status": "pending"}
