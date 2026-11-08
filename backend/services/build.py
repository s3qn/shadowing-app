# The island build pipelines: voice synthesis, the recording, import, podcast,
# phrase, say and grammar builders, plus the read-time ETA and backfills.
import asyncio
import copy
import logging
import os
import re
import shutil
import time
from pathlib import Path

import config
import corpus
import cues
import eta
import export
import generate
import grammar
import kokoro_tts
import lang_text
import latin
import media as media_io
import podcast
import segment
import starter
import store
import transcribe
import tts_registry
import voicevox
import voices

from services import line_audio

log = logging.getLogger("shadow")


def _asr_steer(language: str) -> dict:
    """The `initial_prompt` kwarg for a pinned language that has one in the
    table (zh, ko, fr, pt), nothing for the rest."""
    prompt = lang_text.asr_prompt(language)
    return {"initial_prompt": prompt} if prompt else {}


async def _synthesize_lines(island_id: str, lines: list[dict], speaker: int,
                            language: str = "ja", device: str = "") -> int:
    """Render every line to its own wav. Returns how many succeeded.

    Word timing follows what the voice gives back: VOICEVOX's mora timeline
    (segment.align), a hosted provider's word pieces (latin.align), Kokoro's
    phoneme durations (latin.align_phonemes), else the line is re-transcribed
    with whisper right after rendering and the words mapped on with
    latin.align; a transcription failure never fails the island, just that
    line's timing (steady-pace fallback, logged). `device` (the island's
    owner when not given) counts hosted lines against the daily cap; when a
    hosted voice fell back the island's speaker becomes the voice it got."""
    if not device:
        row = await asyncio.to_thread(store.get_island, island_id)
        device = (row or {}).get("device") or ""
    requested = speaker
    if tts_registry.voice(speaker) is None:
        # A saved hosted voice whose provider is gone (no key): the free voice.
        speaker = tts_registry.default_voice(language)
        log.warning("island %s: voice %d is not registered, using %d", island_id, requested, speaker)
    done = 0
    fell = 0
    used = speaker
    for idx, line in enumerate(lines):
        try:
            out = await voices.render(line["ja"], speaker, device)
        except voices.VOICE_ERRORS:
            log.exception("synthesis failed for line %d of %s", idx, island_id)
            continue
        if out.fallback or speaker != requested:
            fell += 1
            used = out.voice
        if out.fallback == "error":
            # The provider is failing: the rest of the build goes straight to
            # the free voice instead of waiting on it once per line.
            speaker = tts_registry.default_voice(language)
        timeline, duration = out.timeline, out.duration
        # Write beside the target and swap, so a player streaming the old file
        # never reads a half-written one.
        target = store.line_audio_path(island_id, idx)
        tmp = target.with_suffix(".tmp")
        tmp.write_bytes(out.wav)
        os.replace(tmp, target)
        voice = tts_registry.voice(out.voice)
        timing = voice.timing if voice else "none"
        words = []
        if timing == "mora":
            words = await asyncio.to_thread(segment.align, line["ja"], timeline)
        elif timing == "pieces" and out.pieces:
            words = await asyncio.to_thread(latin.align, line["ja"], out.pieces, duration, language)
        elif timing == "phoneme":
            words = latin.align_phonemes(line["ja"], out.phonemes, duration, language)
        if not words and timing != "mora":
            log.info("no provider timings for line %d, timing with whisper", idx)
            result = await asyncio.to_thread(
                transcribe.transcribe, target, lang_text.asr_language(language),
                word_timestamps=True, **_asr_steer(language),
            )
            if not result.get("ok"):
                log.warning(
                    "island %s: whisper could not time line %d, falling back to a steady pace",
                    island_id, idx,
                )
            if lang_text.segmenter(language) == "mora":
                # Unspaced text: the same kanji-aware alignment and reading an import gets.
                words = await asyncio.to_thread(
                    segment.align_pieces, line["ja"], result.get("words", []), duration)
                line = {**line, "kana": line.get("kana") or await asyncio.to_thread(segment.reading, line["ja"])}
            else:
                words = await asyncio.to_thread(
                    latin.align, line["ja"], result.get("words", []), duration, language)
        if lang_text.segmenter(language) != "mora":
            lang_text.ruby(words, language)
        store.add_line(island_id, idx, line, duration, timeline, words)
        done += 1
    if done and fell == done and used != requested:
        # Only when every line fell back: a mixed build keeps the requested voice.
        store.set_speaker(island_id, used)
    # A re-voice or regenerate with fewer lines must not leave old wavs behind.
    for stale in (store.AUDIO_DIR / island_id).glob("*.wav"):
        base = stale.stem.split("@")[0]
        if base.isdigit() and (int(base) >= len(lines) or "@" in stale.stem):
            stale.unlink(missing_ok=True)
    # An export built from the old lines no longer matches this island's
    # content, so it must not be served again under the same cache key.
    export.clear_exports(island_id)
    # A take was cleaned against the line that used to be at this index. A
    # regenerate or revoice replaces that line, so the old take (and its
    # cleaned copy) no longer matches anything and would be misleading.
    shutil.rmtree(store.TAKES_DIR / island_id, ignore_errors=True)
    return done


async def _build_grammar(island_id: str, point: dict, speaker: int,
                         register: str = "polite", native: str = "en") -> None:
    """Build-up lines for one grammar point (picked or heard on the mic).
    The caller owns the try/except and the island row."""
    store.set_stage(island_id, "writing")
    alts = [a for a in re.split(r"[・/／]", point["pattern"].replace("～", "").replace("〜", ""))
            if a.strip()]
    seed = await asyncio.to_thread(
        corpus.search, "ja", [*alts, point["reading"]], "complex", 12)
    generated = await asyncio.to_thread(
        generate.generate_grammar, point, seed, register, native)
    lines = generated.get("lines") or []
    if not lines:
        store.set_failed(island_id, "No lines could be generated.", "no_lines")
        return
    store.set_stage(island_id, "speaking")
    made = await _synthesize_lines(island_id, lines, speaker, "ja")
    if made == 0:
        store.set_failed(island_id, "The voice engine produced no audio.", "voice_no_audio")
        return
    title = point["pattern"] + (f" · {point['meaning_short']}" if point.get("meaning_short") else "")
    store.set_ready(island_id, title)
    log.info("island %s ready: %d grammar lines", island_id, made)


def _script_language(text: str) -> str:
    """A stored transcript's language from its script, standing in for
    whisper's guess on a regenerate. Latin script cannot tell English from
    Spanish, so it stays "" and the prompt says so."""
    if re.search(r"[֐-׿]", text):
        return "he"
    if re.search(r"[぀-ヿ一-鿿]", text):
        return "ja"
    return ""


async def _build_island(island_id: str, audio_path: Path, complexity: str,
                        speaker: int, count: int, register: str = "polite",
                        learning: str = "ja", native: str = "en",
                        topic: bool = False, transcript: str = "") -> None:
    """The whole pipeline, run in the background so the upload returns at
    once. `learning` is the island's own language (what the lines are
    written in); `language` below is whatever whisper hears the recording
    itself spoken in, which only informs the writing prompt. A non-empty
    `transcript` (regenerate) skips whisper: the first build already stored
    what the recording says."""
    try:
        text, language = transcript, _script_language(transcript)
        if not text:
            store.set_stage(island_id, "transcribing")
            result = await asyncio.to_thread(transcribe.transcribe, audio_path)
            text = result.get("text", "")
            language = result.get("language", "")
            if not text:
                store.set_failed(
                    island_id, "Nothing could be transcribed from that recording.",
                    "transcribe_empty",
                )
                return
            store.set_transcript(island_id, text)
            log.info("island %s transcript: %d chars, language=%s",
                     island_id, len(text), language)

        # voice-topic: expand the spoken topic into keywords, pull real
        # Tatoeba sentences as seeds for the generator.
        seed = None
        if topic and learning == "ja":
            # A whole-string match on a grammar point switches modes.
            point = await asyncio.to_thread(grammar.match, text)
            if point:
                store.set_source(island_id, "grammar", point["id"])
                await _build_grammar(island_id, point, speaker, register, native)
                return
        if topic:
            store.set_stage(island_id, "writing")
            keywords = await asyncio.to_thread(generate.expand_topic, text, learning)
            seed = await asyncio.to_thread(corpus.search, learning, keywords, complexity)

        store.set_stage(island_id, "writing")
        generated = await asyncio.to_thread(
            generate.generate_lines, text, complexity, count, language, register,
            learning=learning, native=native, **({"seed": seed} if topic else {}),
        )
        lines = generated.get("lines") or []
        if not lines:
            store.set_failed(island_id, "No lines could be generated.", "no_lines")
            return

        store.set_stage(island_id, "speaking")
        made = await _synthesize_lines(island_id, lines, speaker, learning)
        if made == 0:
            store.set_failed(island_id, "The voice engine produced no audio.", "voice_no_audio")
            return

        title = generated.get("title") or text[:40]
        store.set_ready(island_id, title)
        log.info("island %s ready: %d lines", island_id, made)
    except Exception as exc:
        log.exception("island %s failed", island_id)
        store.set_failed(island_id, str(exc))


async def _build_from_cues(island_id: str, source_wav: Path, cue_list: list[dict],
                           title: str, total: float, language: str = "ja",
                           native: str = "en") -> None:
    """The shared tail of the import pipeline: slice one wav per cue out of
    source_wav, give each line its reading and word timings, and mark the
    island ready. `total` is source_wav's duration, the same value the words
    were attached with (cues.attach_words), so every attached word lies
    inside its line's slice. `made` may be less than len(cue_list) when a
    slice fails, so lines stay contiguously indexed from 0."""
    store.set_stage(island_id, "slicing")
    made = 0
    with_words = 0
    ja_texts: list[str] = []
    for i, cue in enumerate(cue_list):
        start, end = cues.slice_bounds(cue_list, i, total)
        target = store.line_audio_path(island_id, made)
        ok = await asyncio.to_thread(media_io._slice, source_wav, target, start, end)
        if not ok:
            continue
        duration = round(end - start, 3)
        pieces = [
            {"text": w["text"], "start": w["start"] - start, "end": w["end"] - start}
            for w in cue.get("words", [])
        ]
        if lang_text.segmenter(language) == "mora":
            words = await asyncio.to_thread(segment.align_pieces, cue["text"], pieces, duration)
            kana = segment.reading(cue["text"])
            romaji = ""
        else:
            words = await asyncio.to_thread(latin.align, cue["text"], pieces, duration, language)
            lang_text.ruby(words, language)
            kana = ""
            romaji = lang_text.reading(cue["text"], language)
        line = {"ja": cue["text"], "kana": kana, "romaji": romaji, "en": ""}
        store.add_line(island_id, made, line, duration, [], words, offset=start)
        if cue.get("words"):
            with_words += 1
        ja_texts.append(cue["text"])
        made += 1
    if made == 0:
        store.set_failed(island_id, "No line could be cut from that audio.", "no_line_cut")
        return
    store.set_ready(island_id, title)
    log.info(
        "island %s ready: %d lines, %d with whisper words (%d fell back to a steady pace)",
        island_id, made, with_words, made - with_words,
    )

    # The island is already ready, so a translation error only costs the
    # English. It must never reach _build_import's handler, which would mark
    # the island failed.
    try:
        for batch_start in range(0, len(ja_texts), generate.TRANSLATE_BATCH):
            batch = ja_texts[batch_start:batch_start + generate.TRANSLATE_BATCH]
            translations = await asyncio.to_thread(generate.translate_lines, batch, language, native)
            for offset, en in enumerate(translations):
                if en:
                    store.set_en(island_id, batch_start + offset, en)
            log.info(
                "island %s translated lines %d..%d (%d ok)",
                island_id, batch_start, batch_start + len(batch), len(translations),
            )
    except Exception:
        log.exception("island %s: translation stopped early, the island stays ready", island_id)


async def _build_import(island_id: str, media: Path, srt_text: str | None,
                        title: str, start_s: float, tmp_dir: Path | None = None,
                        language: str = "ja", native: str = "en") -> None:
    """The import pipeline, run in the background so the upload returns at
    once: pull the audio out (trimmed to the 30-minute cap from `start_s`),
    run whisper once over the whole clip for word timings, get cues from the
    .srt if one was given (whisper's own segments otherwise), then slice."""
    try:
        store.set_stage(island_id, "extracting")
        probe = await asyncio.to_thread(media_io._probe_streams, media)
        if not probe.get("streams"):
            store.set_failed(island_id, "That media file could not be decoded.", "media_undecodable")
            return
        stream = media_io.pick_audio_stream(probe)
        if stream is None:
            store.set_failed(island_id, "That media file has no audio track.", "media_no_audio")
            return
        source_total = await asyncio.to_thread(media_io._probe_duration, media)
        if source_total > 0 and start_s >= source_total:
            store.set_failed(
                island_id,
                f"The start time ({start_s / 60.0:.0f} min) is past the end of the media"
                f" ({source_total / 60.0:.0f} min).",
                "start_past_end",
            )
            return
        wav = store.AUDIO_DIR / island_id / "source.wav"
        ok = await asyncio.to_thread(
            media_io._extract_audio, media, wav, stream, start_s, config.IMPORT_MAX_SECONDS
        )
        if not ok:
            store.set_failed(island_id, "That media file could not be decoded.", "media_undecodable")
            return
        total = await asyncio.to_thread(media_io._probe_duration, wav)
        if total <= 0:
            store.set_failed(island_id, "That media file could not be decoded.", "media_undecodable")
            return

        # A suffix whenever the island does not cover the source from its
        # very start to its very end, so the range is never a silent surprise.
        trimmed = start_s > 0 or (source_total > 0 and source_total - start_s > total + 0.5)
        if trimmed:
            start_min, end_min = start_s / 60.0, (start_s + total) / 60.0
            title = f"{title} ({start_min:.0f}–{end_min:.0f} min)"

        store.set_media(island_id, total)
        store.set_stage(island_id, "transcribing")
        result = await asyncio.to_thread(
            transcribe.transcribe, wav, lang_text.asr_language(language), True, True,
            **_asr_steer(language),
        )
        if not result.get("ok"):
            store.set_failed(
                island_id,
                "Whisper could not transcribe that audio, so the lines would have no word"
                " timings. Check the backend log, then delete this island and import again.",
                "whisper_no_timings",
            )
            return
        if not result["words"]:
            log.warning(
                "island %s: whisper heard no words in %s; every line falls back to a steady pace",
                island_id, wav,
            )

        if srt_text:
            cue_list = cues.parse_srt(srt_text)
            cue_list = cues.window(cue_list, start_s, total)
            if not cue_list:
                store.set_failed(
                    island_id, "No subtitle lines fall inside that time range.", "no_subtitles_in_range"
                )
                return
            cue_list = cues.attach_words(cue_list, result["words"], total)
        else:
            seg_cues = [
                {"start": s["start"], "end": s["end"], "text": s["text"], "words": s["words"]}
                for s in result["segments"]
                if s["text"]
            ]
            cue_list = cues.split_long(seg_cues, max_seconds=8.0)
            if not cue_list:
                store.set_failed(
                    island_id, "Nothing could be transcribed from that audio.", "transcribe_empty"
                )
                return

        await _build_from_cues(island_id, wav, cue_list, title, total, language, native)
        built = store.get_island(island_id)
        if built and built["status"] == "ready":
            try:
                await line_audio._ensure_episode(island_id, title)
            except Exception:
                log.exception("episode encode for %s failed; it will build on first open", island_id)
    except Exception as exc:
        log.exception("import %s failed", island_id)
        store.set_failed(island_id, str(exc))
    finally:
        if tmp_dir is not None:
            shutil.rmtree(tmp_dir, ignore_errors=True)


async def _build_podcast(island_id: str, audio_url: str, title: str, start_s: float,
                         tmp_dir: Path, language: str = "ja", native: str = "en") -> None:
    """Download the episode audio into `tmp_dir`, then hand off to the same
    pipeline a file import uses. `_build_import` owns `tmp_dir` once it takes
    over; this only cleans up itself if the download never gets that far."""
    try:
        store.set_stage(island_id, "downloading")
        media = tmp_dir / "episode"
        await podcast.fetch(audio_url, media, config.IMPORT_MAX_BYTES)
    except podcast.PodcastError:
        store.set_failed(island_id, "The episode could not be downloaded.", "episode_download_failed")
        shutil.rmtree(tmp_dir, ignore_errors=True)
        return
    except Exception as exc:
        log.exception("podcast download %s failed", island_id)
        store.set_failed(island_id, str(exc))
        shutil.rmtree(tmp_dir, ignore_errors=True)
        return
    await _build_import(island_id, media, None, title, start_s, tmp_dir, language, native)


def _eta_s(island: dict) -> int | None:
    """Seconds left for a building island, None once it settles or while the
    media length is unknown (bl70-eta)."""
    if island.get("status") not in ("pending", "working"):
        return None
    kind = store.build_kind(island.get("source", ""))
    t0 = island.get("build_t0") or 0
    if not kind or t0 <= 0:
        return None
    return eta.estimate(kind, island.get("media_s") or 0, time.time() - t0, store.build_history(kind))


# Old islands get their word timings, furigana and pitch marks on first read
# rather than through a migration. Timings and ruby are local (janome) and
# fill every line in one read. Accent needs one VOICEVOX audio_query per
# line (no synthesis, about 50ms), so it is capped per read and an island
# with hundreds of lines fills over a few opens.
ACCENT_FILL_PER_READ = 16


def _fill_words(island_id: str, lines: list[dict]) -> None:
    """Word timings and ruby for lines stored before either existed. Blocking
    (janome), so the route runs it in a thread. Writes only when something
    was added, so a second read of the same island writes nothing, and only
    over the words it read, so a line replaced meanwhile is left alone."""
    for line in lines:
        before = copy.deepcopy(line["words"])
        if not line["words"] and line["timeline"]:
            line["words"] = segment.align(line["ja"], line["timeline"])
            # A whole-line fallback is not worth persisting; a later read may
            # do better once whatever failed is fixed.
            if not segment.is_fallback(line["ja"], line["words"]):
                store.set_words(island_id, line["idx"], line["words"], expected=before)
        elif segment.ensure_ruby(line["words"], line["timeline"]):
            store.set_words(island_id, line["idx"], line["words"], expected=before)


async def _fill_accent(island: dict) -> None:
    """`high` per mora for timelines stored before pitch marks existed, from
    a fresh audio_query of the same text. At most ACCENT_FILL_PER_READ engine
    calls, each with a short timeout; the first failure ends the pass (no
    marks this time, tried again next read). A line whose moras do not line
    up with the fresh query is stored with None so it is never asked again.
    Empty timelines have nothing to fill and are skipped. Writes only over
    the timeline it read."""
    calls = 0
    for line in island["lines"]:
        if not voicevox.needs_accent(line["timeline"]):
            continue
        if calls >= ACCENT_FILL_PER_READ:
            break
        calls += 1
        try:
            query = await voicevox.audio_query(
                line["ja"], island["speaker"], timeout=voicevox.BACKFILL_TIMEOUT_S
            )
        except Exception:
            log.warning("accent backfill: VOICEVOX unreachable or slow for %s", island["id"])
            break
        filled = voicevox.backfill_accent(line["timeline"], query)
        if filled is None:
            log.warning("accent backfill: moras differ for %s line %d", island["id"], line["idx"])
            filled = [{**m, "high": None} for m in line["timeline"]]
        if store.set_timeline(island["id"], line["idx"], filled, expected=line["timeline"]):
            line["timeline"] = filled


async def _revoice(island_id: str, lines: list[dict], speaker: int, title: str,
                   language: str = "ja") -> None:
    try:
        made = await _synthesize_lines(island_id, lines, speaker, language)
        if made == 0:
            store.set_failed(island_id, "The voice engine produced no audio.", "voice_no_audio")
            return
        store.set_ready(island_id, title)
    except Exception as exc:
        log.exception("revoice %s failed", island_id)
        store.set_failed(island_id, str(exc))


async def _build_phrases(island_id: str, texts: list[str], glosses: list[str], title: str,
                         speaker: int, language: str, native: str,
                         topic: str = "") -> None:
    """Voice a catalogue topic. No recording and no transcription: the lines
    are the catalogue's own phrases. A translator failure only costs the
    native text, the island still becomes ready. With `topic` set, the
    finished island is also kept as the shared render for (language, topic,
    speaker, native), so the next person who picks it gets a copy instead of
    a new synthesis."""
    try:
        store.set_stage(island_id, "speaking")
        translations = glosses
        translated = True
        if native != "en" and not all(glosses):
            try:
                translations = await asyncio.to_thread(
                    generate.translate_lines, texts, language, native
                )
            except Exception:
                log.exception("island %s: phrase translation failed", island_id)
                translations, translated = [], False
        lines = []
        for i, text in enumerate(texts):
            gloss = translations[i] if i < len(translations) else ""
            mora = lang_text.segmenter(language) == "mora"
            kana = await asyncio.to_thread(segment.reading, text) if mora else ""
            romaji = "" if mora else await asyncio.to_thread(lang_text.reading, text, language)
            lines.append({"ja": text, "kana": kana, "romaji": romaji, "en": gloss or ""})
        made = await _synthesize_lines(island_id, lines, speaker, language)
        if made == 0:
            store.set_failed(island_id, "The voice engine produced no audio.", "voice_no_audio")
            return
        store.set_ready(island_id, title)
        log.info("island %s ready: %d phrase lines", island_id, made)
    except Exception as exc:
        log.exception("island %s failed", island_id)
        store.set_failed(island_id, str(exc))
        return
    # Only a complete render is shared: a missing translation or a silent
    # line would otherwise reach every later learner of this key. save_cache
    # checks the stored lines again (count, idx and gloss).
    if not topic or not translated or made < len(texts):
        return
    # The island is ready whatever happens below: a cache that cannot be
    # written only means the next pick synthesises again.
    try:
        await asyncio.to_thread(starter.save_cache, island_id, language, topic, speaker, native)
    except Exception:
        log.exception("island %s: phrase cache not saved", island_id)


async def _build_say(island_id: str, wav: Path, speaker: int, register: str,
                     learning: str, native: str, transcript: str = "") -> None:
    """Transcribe the native sentence, ask for the line(s) in `learning`,
    voice them, mark the island ready with the native sentence as its title.
    A non-empty `transcript` (dev only) skips whisper. The whole clip is 1 to
    15 s, so whisper runs with no VAD and no fast flag."""
    try:
        text = (transcript or "").strip()
        if not text:
            store.set_stage(island_id, "transcribing")
            # The account's native setting is not the language spoken: hear
            # Hebrew vs English from the audio. detect_he_en answers only when
            # confident, so a weak lean (None) keeps the setting, as does a
            # detection of the language being learned.
            lang = await asyncio.to_thread(transcribe.detect_he_en, wav)
            if lang is None or lang == learning:
                lang = native
            model = "he" if lang == "he" else "default"
            result = await asyncio.to_thread(
                transcribe.transcribe, wav, lang_text.asr_language(lang),
                model=model, **_asr_steer(lang))
            if lang != native:
                native = lang
                store.set_island_native(island_id, lang)
            text = (result.get("text") or "").strip()
            if not text:
                store.set_failed(
                    island_id, "Nothing could be transcribed from that recording.",
                    "transcribe_empty",
                )
                return
        store.set_transcript(island_id, text)

        store.set_stage(island_id, "writing")
        said = await asyncio.to_thread(generate.say_lines, text, learning, native, register)
        lines = said.get("lines") or []
        if said.get("intent") == "unclear" or not lines:
            store.set_failed(island_id, "I did not catch that. Say it again.", "say_unclear")
            return

        store.set_stage(island_id, "speaking")
        made = await _synthesize_lines(island_id, lines, speaker, learning)
        if made == 0:
            store.set_failed(island_id, "The voice engine produced no audio.", "voice_no_audio")
            return

        store.set_ready(island_id, text[:40])
        log.info("say %s ready: intent=%s %d lines", island_id, said.get("intent"), made)
    except Exception as exc:
        log.exception("say %s failed", island_id)
        store.set_failed(island_id, str(exc))
