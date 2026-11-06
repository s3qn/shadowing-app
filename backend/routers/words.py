# Routes for words, moved out of main.py.
import asyncio
import json
import logging

from fastapi import APIRouter, Header
from pydantic import BaseModel

import dependencies
import explain
import gloss as glossary
import store

router = APIRouter()
log = logging.getLogger("shadow")


@router.get("/shadow/gloss")
async def word_gloss(word: str, authorization: str | None = Header(None)) -> dict:
    """Base form, reading and dictionary senses for one word from a line."""
    dependencies.require_token(authorization)
    return await asyncio.to_thread(glossary.gloss, word)


@router.get("/shadow/explain-word")
async def explain_word(word: str, sentence_ja: str, sentence_en: str = "",
                       language: str = "ja", native: str = "en",
                       authorization: str | None = Header(None),
                       x_shadow_device: str = Header("")) -> dict:
    """How one word functions in one particular sentence. Cached in sqlite,
    keyed on (word, understood language + sentence_ja), since the same word
    in the same sentence answered in the same language always gets the same
    answer. A cache hit is free; a miss is a Claude call and takes an
    `explain_word` slot from the daily cap."""
    dependencies.require_token(authorization)
    device = dependencies._require_device(x_shadow_device)
    # An English answer keeps the plain key it always had, so cached answers
    # from before other native languages existed still hit.
    cache_key = sentence_ja if native == "en" else f"{native}:{sentence_ja}"
    cached = await asyncio.to_thread(store.get_word_context, word, cache_key)
    if cached is not None:
        return {"context": cached}
    dependencies._take_use_slot(device, "explain_word", "word")
    context = await asyncio.to_thread(
        explain.word_context, word, sentence_ja, sentence_en, language=language, native=native
    )
    if context:
        await asyncio.to_thread(store.set_word_context, word, cache_key, context)
    else:
        # The CLI failed and nothing was cached, so a retap would pay again.
        await asyncio.to_thread(dependencies._refund_use_slot, device, "explain_word", "word")
    return {"context": context}


class ExplainChatBody(BaseModel):
    sentence_ja: str
    sentence_en: str = ""
    marked: list[str] = []
    question: str
    history: list[dict] = []
    language: str = "ja"
    native: str = "en"


@router.post("/shadow/explain-chat")
async def explain_chat(body: ExplainChatBody,
                       authorization: str | None = Header(None),
                       x_shadow_device: str = Header("")) -> dict:
    """One turn about a sentence, structured as {"vocab", "grammar",
    "summary"} (any of the three may be absent). The thread itself lives in
    the client's own state, not persisted here. The opening turn of a thread
    (no history yet) is cached in sqlite as JSON, keyed on (sentence, marked
    words, question): that is the Explain sheet's fixed question re-run on
    the same selection, and it always gets the same answer. A follow-up turn
    carries history and is never cached, since it depends on the thread so
    far."""
    dependencies.require_token(authorization)
    question_key = body.question if body.native == "en" else f"{body.native}:{body.question}"
    if not body.history:
        cached = await asyncio.to_thread(
            store.get_explain_answer, body.sentence_ja, body.marked, question_key
        )
        if cached is not None:
            try:
                return json.loads(cached)
            except json.JSONDecodeError:
                # A row sqlite cannot parse back is no better than no row:
                # fall through to a fresh answer, which overwrites it below.
                log.warning("explain cache row is not valid JSON, treating as a miss")
    device = dependencies._require_device(x_shadow_device)
    dependencies._take_use_slot(device, "explain", "explain")
    raw = await asyncio.to_thread(
        explain.chat_answer, body.sentence_ja, body.sentence_en, body.marked,
        body.question, body.history, language=body.language, native=body.native,
    )
    answer = explain.parse_explain_answer(raw, body.sentence_ja)
    if not answer:
        # The CLI failed and nothing was cached, so a retap would pay again.
        await asyncio.to_thread(dependencies._refund_use_slot, device, "explain", "explain")
    if answer and not body.history:
        await asyncio.to_thread(
            store.set_explain_answer, body.sentence_ja, body.marked, question_key,
            json.dumps(answer, ensure_ascii=False),
        )
    return answer
