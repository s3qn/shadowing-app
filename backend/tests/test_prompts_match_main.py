"""The ja, es and en generate and say prompts and the say cache key are
byte-identical to the launch build. tests/fixtures/main_prompts.json was
rendered by the pre-languages generate.py (git main) for fixed inputs."""
import json
from pathlib import Path

import pytest

import generate
import llm
import store

EXPECTED = json.loads((Path(__file__).parent / "fixtures" / "main_prompts.json").read_text("utf-8"))


@pytest.mark.parametrize("lang", ["ja", "es", "en"])
def test_prompts_and_say_key_match_main(monkeypatch, lang):
    seen = []
    monkeypatch.setattr(llm, "model_for", lambda tag: "M")
    monkeypatch.setattr(store, "get_say_cache", lambda k: None)
    monkeypatch.setattr(llm, "complete", lambda prompt, schema, **k: (seen.append(prompt), None)[1])
    generate.generate_lines("hola mundo", "simple", 3, "en", "polite", lang, "he")
    generate.generate_lines("hola mundo", "simple", 3, "en", "polite", lang, "he",
                            seed=[{"text": "uno", "en": "one"}])
    generate.say_lines("quiero un café", lang, "he", "casual")
    assert seen == [EXPECTED[f"generate_{lang}"], EXPECTED[f"topic_{lang}"], EXPECTED[f"say_{lang}"]]
    assert generate._say_key("quiero un café", lang, "he", "casual") == EXPECTED[f"key_{lang}"]
