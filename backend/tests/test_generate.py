"""Tests for generate.py: turning a transcript into Japanese lines.

_extract_json is pure string parsing and is tested directly. generate_lines
shells out to the `claude` CLI, so it is never actually invoked here: the
subprocess call is monkeypatched with a fake `subprocess.run` in every test
that reaches it, and the CLI-missing test asserts the call would not even
happen for an empty transcript.
"""

import json
import subprocess

import generate


class FakeCompleted:
    """Stands in for subprocess.CompletedProcess: only the fields generate.py reads."""

    def __init__(self, returncode=0, stdout="", stderr=""):
        self.returncode = returncode
        self.stdout = stdout
        self.stderr = stderr


# -- _extract_json ------------------------------------------------------


def test_extract_json_bare_array():
    assert generate._extract_json("[1, 2, 3]") == [1, 2, 3]


def test_extract_json_object_wrapper():
    assert generate._extract_json('{"a": 1, "b": [2, 3]}') == {"a": 1, "b": [2, 3]}


def test_extract_json_fenced_in_code_block():
    text = '```json\n{"title": "x", "lines": []}\n```'
    assert generate._extract_json(text) == {"title": "x", "lines": []}


def test_extract_json_with_prose_before_and_after():
    text = 'Here is the result:\n{"a": 1}\nLet me know if that works.'
    assert generate._extract_json(text) == {"a": 1}


def test_extract_json_empty_string_returns_none():
    assert generate._extract_json("") is None


def test_extract_json_unparseable_text_returns_none():
    # No braces or brackets at all: the module's contract for genuinely
    # unparseable output is None, never an exception.
    assert generate._extract_json("Sorry, I can't help with that.") is None


def test_extract_json_dangling_brace_returns_none():
    # Has a '{' to try, but no valid JSON follows it anywhere in the string.
    assert generate._extract_json("{not actually json") is None


# -- generate_lines -------------------------------------------------------


def test_generate_lines_empty_transcript_never_calls_cli(monkeypatch):
    def fail_if_called(*args, **kwargs):
        raise AssertionError("subprocess.run should not run for an empty transcript")

    monkeypatch.setattr(generate.subprocess, "run", fail_if_called)

    assert generate.generate_lines("   ", complexity="simple") == {"title": "", "lines": []}


def test_generate_lines_cli_not_found_returns_empty(monkeypatch):
    def fake_run(*args, **kwargs):
        raise FileNotFoundError()

    monkeypatch.setattr(generate.subprocess, "run", fake_run)

    result = generate.generate_lines("I went to the store.", complexity="simple")
    assert result == {"title": "", "lines": []}


def test_generate_lines_cli_timeout_returns_empty(monkeypatch):
    def fake_run(*args, **kwargs):
        raise subprocess.TimeoutExpired(cmd="claude", timeout=generate.CLI_TIMEOUT_S)

    monkeypatch.setattr(generate.subprocess, "run", fake_run)

    result = generate.generate_lines("I went to the store.", complexity="simple")
    assert result == {"title": "", "lines": []}


def test_generate_lines_nonzero_exit_returns_empty(monkeypatch):
    monkeypatch.setattr(
        generate.subprocess, "run",
        lambda *a, **k: FakeCompleted(returncode=1, stderr="boom"),
    )

    result = generate.generate_lines("I went to the store.", complexity="simple")
    assert result == {"title": "", "lines": []}


def test_generate_lines_unparseable_output_returns_empty(monkeypatch):
    monkeypatch.setattr(
        generate.subprocess, "run",
        lambda *a, **k: FakeCompleted(returncode=0, stdout="not json"),
    )

    result = generate.generate_lines("I went to the store.", complexity="simple")
    assert result == {"title": "", "lines": []}


def test_generate_lines_bare_array_output_returns_empty(monkeypatch):
    # _extract_json would happily parse a bare array, but generate_lines
    # requires the top-level value to be a dict (it has "title" and "lines").
    monkeypatch.setattr(
        generate.subprocess, "run",
        lambda *a, **k: FakeCompleted(returncode=0, stdout="[1, 2, 3]"),
    )

    result = generate.generate_lines("I went to the store.", complexity="simple")
    assert result == {"title": "", "lines": []}


def test_generate_lines_parses_and_filters_lines(monkeypatch):
    stdout = json.dumps({
        "title": "  Morning routine  ",
        "lines": [
            {"ja": "起きます", "kana": "おきます", "romaji": "okimasu", "en": "I get up"},
            {"ja": "   ", "kana": "x", "romaji": "y", "en": "z"},  # blank ja: dropped
            "not a dict",  # non-dict item: dropped
            {"ja": "寝ます"},  # missing optional fields: default to empty strings
        ],
    })
    monkeypatch.setattr(
        generate.subprocess, "run",
        lambda *a, **k: FakeCompleted(returncode=0, stdout=stdout),
    )

    result = generate.generate_lines(
        "I went to the store.", complexity="simple", count=8, language="en"
    )

    assert result["title"] == "Morning routine"
    assert result["lines"] == [
        {"ja": "起きます", "kana": "おきます", "romaji": "okimasu", "en": "I get up"},
        {"ja": "寝ます", "kana": "", "romaji": "", "en": ""},
    ]


# -- register (polite vs. casual) -----------------------------------------


def _captured_prompt(monkeypatch, **kwargs):
    """Call generate_lines with a fake CLI that returns one empty island, and
    return the prompt it was actually asked to write, so tests can check
    which instructions reached the model without invoking the real CLI."""
    seen = {}

    def fake_run(*args, **kw):
        seen["prompt"] = kw.get("input")
        return FakeCompleted(returncode=0, stdout=json.dumps({"title": "t", "lines": []}))

    monkeypatch.setattr(generate.subprocess, "run", fake_run)
    generate.generate_lines("I went to the store.", **kwargs)
    return seen["prompt"]


def test_generate_lines_default_register_is_polite(monkeypatch):
    prompt = _captured_prompt(monkeypatch, complexity="simple")
    assert generate.REGISTER_RULES["polite"] in prompt
    assert generate.REGISTER_RULES["casual"] not in prompt


def test_generate_lines_casual_register_instructs_plain_form(monkeypatch):
    prompt = _captured_prompt(monkeypatch, complexity="simple", register="casual")
    assert generate.REGISTER_RULES["casual"] in prompt
    assert generate.REGISTER_RULES["polite"] not in prompt
    # The whole point of the register: casual must explicitly rule out です/ます.
    assert "です" in prompt and "ます" in prompt


def test_generate_lines_unknown_register_falls_back_to_polite(monkeypatch):
    prompt = _captured_prompt(monkeypatch, complexity="simple", register="rude")
    assert generate.REGISTER_RULES["polite"] in prompt


# -- translate_lines --------------------------------------------------------


def test_translate_lines_empty_input_never_calls_cli(monkeypatch):
    def fail_if_called(*args, **kwargs):
        raise AssertionError("subprocess.run should not run for an empty batch")

    monkeypatch.setattr(generate.subprocess, "run", fail_if_called)

    assert generate.translate_lines([]) == []


def test_translate_lines_parses_json_array(monkeypatch):
    monkeypatch.setattr(
        generate.subprocess, "run",
        lambda *a, **k: FakeCompleted(returncode=0, stdout=json.dumps(["I get up", "I sleep"])),
    )

    result = generate.translate_lines(["起きます", "寝ます"])
    assert result == ["I get up", "I sleep"]


def test_translate_lines_parses_fenced_array(monkeypatch):
    stdout = '```json\n["I get up", "I sleep"]\n```'
    monkeypatch.setattr(
        generate.subprocess, "run",
        lambda *a, **k: FakeCompleted(returncode=0, stdout=stdout),
    )

    result = generate.translate_lines(["起きます", "寝ます"])
    assert result == ["I get up", "I sleep"]


def test_translate_lines_garbage_output_returns_empty(monkeypatch):
    monkeypatch.setattr(
        generate.subprocess, "run",
        lambda *a, **k: FakeCompleted(returncode=0, stdout="not json"),
    )

    assert generate.translate_lines(["起きます", "寝ます"]) == []


def test_translate_lines_wrong_length_returns_empty(monkeypatch):
    monkeypatch.setattr(
        generate.subprocess, "run",
        lambda *a, **k: FakeCompleted(returncode=0, stdout=json.dumps(["only one"])),
    )

    assert generate.translate_lines(["起きます", "寝ます"]) == []


def test_translate_lines_cli_not_found_returns_empty(monkeypatch):
    def fake_run(*args, **kwargs):
        raise FileNotFoundError()

    monkeypatch.setattr(generate.subprocess, "run", fake_run)

    assert generate.translate_lines(["起きます"]) == []


def test_translate_lines_nonzero_exit_returns_empty(monkeypatch):
    monkeypatch.setattr(
        generate.subprocess, "run",
        lambda *a, **k: FakeCompleted(returncode=1, stderr="boom"),
    )

    assert generate.translate_lines(["起きます"]) == []


def test_translate_lines_native_hebrew_prompt_names_hebrew(monkeypatch):
    captured = {}

    def fake_run(*args, **kw):
        captured["prompt"] = kw.get("input")
        return FakeCompleted(returncode=0, stdout=json.dumps(["x"]))

    monkeypatch.setattr(generate.subprocess, "run", fake_run)

    generate.translate_lines(["起きます"], native="he")

    assert "Hebrew" in captured["prompt"]
    assert "English" not in captured["prompt"]


# -- generate_lines: learning languages (es/en) ----------------------------


def test_generate_lines_ja_prompt_is_byte_identical_to_today(monkeypatch):
    # learning="ja", native="en" are the defaults: adding es/en support must
    # not change a single byte of the prompt Japanese islands have always
    # gotten, or every existing island's generation behaviour would drift.
    captured = {}

    def fake_run(*args, **kw):
        captured["prompt"] = kw.get("input")
        return FakeCompleted(returncode=0, stdout=json.dumps({"title": "t", "lines": []}))

    monkeypatch.setattr(generate.subprocess, "run", fake_run)

    generate.generate_lines("I went to the store.", complexity="simple", count=8, language="en")

    expected = generate.PROMPT_TEMPLATE.format(
        transcript="I went to the store.",
        count=8,
        rules=generate.COMPLEXITY_RULES["simple"],
        register_rules=generate.REGISTER_RULES["polite"],
        language="English",
        native_name="English",
    )
    assert captured["prompt"] == expected


def test_generate_lines_es_prompt_names_spanish_and_hebrew_and_asks_for_text_translation(monkeypatch):
    captured = {}

    def fake_run(*args, **kw):
        captured["prompt"] = kw.get("input")
        return FakeCompleted(returncode=0, stdout=json.dumps({"title": "t", "lines": []}))

    monkeypatch.setattr(generate.subprocess, "run", fake_run)

    generate.generate_lines(
        "Fui a la tienda.", complexity="simple", count=5, language="es",
        learning="es", native="he",
    )

    prompt = captured["prompt"]
    assert "Spanish" in prompt
    assert "Hebrew" in prompt
    assert '"text"' in prompt
    assert '"translation"' in prompt
    assert "Japanese" not in prompt


def test_generate_lines_es_parses_text_and_translation_into_ja_and_en(monkeypatch):
    stdout = json.dumps({
        "title": "At the store",
        "lines": [
            {"text": "Fui a la tienda ayer.", "translation": "I went to the store yesterday."},
            {"text": "   ", "translation": "blank text dropped"},
        ],
    })
    monkeypatch.setattr(
        generate.subprocess, "run",
        lambda *a, **k: FakeCompleted(returncode=0, stdout=stdout),
    )

    result = generate.generate_lines(
        "I went to the store.", complexity="simple", learning="es", native="en",
    )

    assert result["lines"] == [
        {"ja": "Fui a la tienda ayer.", "kana": "", "romaji": "",
         "en": "I went to the store yesterday."},
    ]


def test_latin_prompt_asks_for_speakable_text(monkeypatch):
    prompt = _captured_prompt(monkeypatch, learning="es")
    assert "as words" in prompt
    assert "line breaks" in prompt


def test_japanese_prompt_has_no_latin_speakable_rule(monkeypatch):
    prompt = _captured_prompt(monkeypatch)
    assert "as words" not in prompt
    assert "line breaks" not in prompt


# --- voice topic -----------------------------------------------------------

def _cli_ok(stdout, captured=None):
    def fake_run(argv, **kw):
        if captured is not None:
            captured.append(kw.get("input"))
        return subprocess.CompletedProcess(argv, 0, stdout=stdout, stderr="")
    return fake_run


SEED = [
    {"id": 901, "text": "ジムに行きます。", "en": "I go to the gym."},
    {"id": 902, "text": "運動は好きです。", "en": "I like exercise."},
]


def test_expand_topic_parses_array(monkeypatch):
    monkeypatch.setattr(generate.subprocess, "run", _cli_ok('["gym", "ジム", 3, ""]'))
    assert generate.expand_topic("phrases for the gym", "ja") == ["gym", "ジム"]


def test_expand_topic_falls_back_to_topic_words(monkeypatch):
    def fail(argv, **kw):
        return subprocess.CompletedProcess(argv, 1, stdout="", stderr="boom")
    monkeypatch.setattr(generate.subprocess, "run", fail)
    assert generate.expand_topic("Phrases for the gym, gym!", "ja") == ["phrases", "for", "the", "gym"]


def test_topic_prompt_names_language_seeds_and_src(monkeypatch):
    captured = []
    monkeypatch.setattr(generate.subprocess, "run", _cli_ok('{"title": "Gym", "lines": []}', captured))
    generate.generate_lines("phrases for the gym", "simple", 5, "en", "polite",
                            learning="ja", native="en", seed=SEED)
    prompt = captured[0]
    assert "Japanese sentences" in prompt
    assert "1. ジムに行きます。\tI go to the gym." in prompt
    assert "2. 運動は好きです。" in prompt
    assert '"src"' in prompt

    captured.clear()
    generate.generate_lines("frases del gimnasio", "simple", 5, "es", "polite",
                            learning="es", native="en", seed=[])
    assert "Spanish sentences" in captured[0]
    assert "(none)" in captured[0]


def test_src_maps_to_tatoeba_id(monkeypatch):
    out = ('{"title": "Gym", "lines": ['
           '{"ja": "a", "kana": "a", "romaji": "a", "en": "a", "src": 2},'
           '{"ja": "b", "kana": "b", "romaji": "b", "en": "b", "src": 9},'
           '{"ja": "c", "kana": "c", "romaji": "c", "en": "c", "src": null}]}')
    monkeypatch.setattr(generate.subprocess, "run", _cli_ok(out))
    lines = generate.generate_lines("gym", seed=SEED)["lines"]
    assert [ln["tatoeba_id"] for ln in lines] == [902, None, None]


def test_generate_grammar_prompt_parse_and_span(monkeypatch):
    seen = {}
    reply = json.dumps({"title": "ながら", "lines": [
        {"ja": "歩きながら話す。", "kana": "", "romaji": "", "en": "a", "span": "ながら", "src": 1},
        {"ja": "走る。", "kana": "", "romaji": "", "en": "b", "span": "ながら"},
        {"ja": "", "en": "skipped"},
    ]})

    def fake(prompt, tag):
        seen["prompt"] = prompt
        return reply

    monkeypatch.setattr(generate, "_run_cli", fake)
    point = {"pattern": "AながらB", "reading": "ながら", "level": "N4", "connection": "Vます stem"}
    out = generate.generate_grammar(point, [{"id": 9, "text": "座りながら食べる。", "en": "x"}])
    assert "AながらB" in seen["prompt"] and "座りながら食べる。" in seen["prompt"]
    assert [ln["span"] for ln in out["lines"]] == ["ながら", ""]
    assert out["lines"][0]["tatoeba_id"] == 9
    assert out["title"] == "ながら"


def test_generate_grammar_cli_failure_is_empty(monkeypatch):
    monkeypatch.setattr(generate, "_run_cli", lambda *a: None)
    assert generate.generate_grammar({"pattern": "x"}) == {"title": "", "lines": []}
