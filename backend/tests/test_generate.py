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
