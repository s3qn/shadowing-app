"""Tests for explain.py: word-in-context gloss and sentence chat.

Both functions shell out to the `claude` CLI, so it is never actually invoked
here: subprocess.run is monkeypatched with a fake in every test that reaches
it, same pattern as test_generate.py.
"""

import json
import subprocess

import explain


class FakeCompleted:
    """Stands in for subprocess.CompletedProcess: only the fields explain.py reads."""

    def __init__(self, returncode=0, stdout="", stderr=""):
        self.returncode = returncode
        self.stdout = stdout
        self.stderr = stderr


# -- word_context -----------------------------------------------------------


def test_word_context_empty_word_never_calls_cli(monkeypatch):
    def fail_if_called(*args, **kwargs):
        raise AssertionError("subprocess.run should not run for an empty word")

    monkeypatch.setattr(explain.subprocess, "run", fail_if_called)

    assert explain.word_context("  ", "行きます。", "I go.") == ""


def test_word_context_empty_sentence_never_calls_cli(monkeypatch):
    def fail_if_called(*args, **kwargs):
        raise AssertionError("subprocess.run should not run for an empty sentence")

    monkeypatch.setattr(explain.subprocess, "run", fail_if_called)

    assert explain.word_context("行きます", "  ", "I go.") == ""


def test_word_context_cli_not_found_returns_empty(monkeypatch):
    def fake_run(*args, **kwargs):
        raise FileNotFoundError()

    monkeypatch.setattr(explain.subprocess, "run", fake_run)

    assert explain.word_context("行きます", "学校に行きます。", "I go to school.") == ""


def test_word_context_cli_timeout_returns_empty(monkeypatch):
    def fake_run(*args, **kwargs):
        raise subprocess.TimeoutExpired(cmd="claude", timeout=explain.CLI_TIMEOUT_S)

    monkeypatch.setattr(explain.subprocess, "run", fake_run)

    assert explain.word_context("行きます", "学校に行きます。", "I go to school.") == ""


def test_word_context_nonzero_exit_returns_empty(monkeypatch):
    monkeypatch.setattr(
        explain.subprocess, "run",
        lambda *a, **k: FakeCompleted(returncode=1, stderr="boom"),
    )

    assert explain.word_context("行きます", "学校に行きます。", "I go to school.") == ""


def test_word_context_empty_output_returns_empty(monkeypatch):
    monkeypatch.setattr(
        explain.subprocess, "run",
        lambda *a, **k: FakeCompleted(returncode=0, stdout="   "),
    )

    assert explain.word_context("行きます", "学校に行きます。", "I go to school.") == ""


def test_word_context_parses_normal_response(monkeypatch):
    monkeypatch.setattr(
        explain.subprocess, "run",
        lambda *a, **k: FakeCompleted(
            returncode=0,
            stdout="  Here, 行きます is the polite present form of 行く, marking the "
                   "action the speaker will do next.  \n",
        ),
    )

    result = explain.word_context("行きます", "学校に行きます。", "I go to school.")
    assert result == (
        "Here, 行きます is the polite present form of 行く, marking the action the "
        "speaker will do next."
    )


# -- chat_answer --------------------------------------------------------------


def test_chat_answer_empty_question_never_calls_cli(monkeypatch):
    def fail_if_called(*args, **kwargs):
        raise AssertionError("subprocess.run should not run for an empty question")

    monkeypatch.setattr(explain.subprocess, "run", fail_if_called)

    result = explain.chat_answer("学校に行きます。", "I go to school.", ["行きます"], "  ", [])
    assert result == ""


def test_chat_answer_cli_not_found_returns_empty(monkeypatch):
    def fake_run(*args, **kwargs):
        raise FileNotFoundError()

    monkeypatch.setattr(explain.subprocess, "run", fake_run)

    result = explain.chat_answer(
        "学校に行きます。", "I go to school.", ["行きます"], "why is this polite form?", []
    )
    assert result == ""


def test_chat_answer_cli_timeout_returns_empty(monkeypatch):
    def fake_run(*args, **kwargs):
        raise subprocess.TimeoutExpired(cmd="claude", timeout=explain.CLI_TIMEOUT_S)

    monkeypatch.setattr(explain.subprocess, "run", fake_run)

    result = explain.chat_answer(
        "学校に行きます。", "I go to school.", ["行きます"], "why is this polite form?", []
    )
    assert result == ""


def test_chat_answer_nonzero_exit_returns_empty(monkeypatch):
    monkeypatch.setattr(
        explain.subprocess, "run",
        lambda *a, **k: FakeCompleted(returncode=1, stderr="boom"),
    )

    result = explain.chat_answer(
        "学校に行きます。", "I go to school.", ["行きます"], "why is this polite form?", []
    )
    assert result == ""


def test_chat_answer_empty_output_returns_empty(monkeypatch):
    monkeypatch.setattr(
        explain.subprocess, "run",
        lambda *a, **k: FakeCompleted(returncode=0, stdout=""),
    )

    result = explain.chat_answer(
        "学校に行きます。", "I go to school.", ["行きます"], "why is this polite form?", []
    )
    assert result == ""


def test_chat_answer_includes_marked_words_and_history_in_prompt(monkeypatch):
    captured = {}

    def fake_run(argv, input=None, **kwargs):
        captured["input"] = input
        return FakeCompleted(returncode=0, stdout="It marks the destination.")

    monkeypatch.setattr(explain.subprocess, "run", fake_run)

    history = [
        {"role": "user", "text": "what does 行きます mean?"},
        {"role": "assistant", "text": "It means 'go', polite present form."},
    ]
    result = explain.chat_answer(
        "学校に行きます。", "I go to school.", ["行きます", "学校"],
        "why is に used here?", history,
    )

    assert result == "It marks the destination."
    prompt = captured["input"]
    assert "行きます, 学校" in prompt
    assert "why is に used here?" in prompt
    assert "what does 行きます mean?" in prompt
    assert "It means 'go', polite present form." in prompt


def test_chat_answer_caps_history_to_last_six_turns(monkeypatch):
    captured = {}

    def fake_run(argv, input=None, **kwargs):
        captured["input"] = input
        return FakeCompleted(returncode=0, stdout="answer")

    monkeypatch.setattr(explain.subprocess, "run", fake_run)

    history = [{"role": "user", "text": f"turn {i}"} for i in range(10)]
    explain.chat_answer("学校に行きます。", "I go to school.", [], "a question", history)

    prompt = captured["input"]
    assert "turn 0" not in prompt
    assert "turn 3" not in prompt
    assert "turn 4" in prompt
    assert "turn 9" in prompt


def test_chat_answer_no_marked_words_reads_as_whole_sentence(monkeypatch):
    captured = {}

    def fake_run(argv, input=None, **kwargs):
        captured["input"] = input
        return FakeCompleted(returncode=0, stdout="answer")

    monkeypatch.setattr(explain.subprocess, "run", fake_run)

    explain.chat_answer("学校に行きます。", "I go to school.", [], "what does this mean?", [])

    assert "(none, whole sentence)" in captured["input"]


# -- parse_explain_answer ------------------------------------------------------


def test_parse_explain_answer_empty_returns_empty_dict():
    assert explain.parse_explain_answer("") == {}
    assert explain.parse_explain_answer("   ") == {}


def test_parse_explain_answer_good_json():
    raw = """{
      "vocab": [{"word": "行きます", "reading": "いきます", "meaning": "to go", "pos": "verb"}],
      "grammar": [{"pattern": "に", "explanation": "marks the destination of motion."}],
      "summary": "The speaker says they are going to school."
    }"""

    result = explain.parse_explain_answer(raw)

    assert result == {
        "vocab": [{"word": "行きます", "reading": "いきます", "meaning": "to go", "pos": "verb"}],
        "grammar": [{"pattern": "に", "explanation": "marks the destination of motion."}],
        "summary": "The speaker says they are going to school.",
    }


def test_parse_explain_answer_strips_code_fences():
    raw = '```json\n{"summary": "A short sentence about going to school."}\n```'

    assert explain.parse_explain_answer(raw) == {
        "summary": "A short sentence about going to school."
    }


def test_parse_explain_answer_drops_items_missing_required_fields():
    raw = """{
      "vocab": [
        {"word": "学校", "meaning": "school", "pos": "noun"},
        {"word": "", "reading": "いきます", "meaning": "to go", "pos": "verb"},
        {"reading": "いきます", "meaning": "to go", "pos": "verb"}
      ],
      "grammar": [
        {"pattern": "に", "explanation": "marks the destination."},
        {"pattern": "を"}
      ]
    }"""

    result = explain.parse_explain_answer(raw)

    assert result["vocab"] == [{"word": "学校", "reading": "", "meaning": "school", "pos": "noun"}]
    assert result["grammar"] == [{"pattern": "に", "explanation": "marks the destination."}]
    assert "summary" not in result


def test_parse_explain_answer_invalid_pos_falls_back_to_other():
    raw = '{"vocab": [{"word": "学校", "meaning": "school", "pos": "not-a-real-group"}]}'

    result = explain.parse_explain_answer(raw)

    assert result["vocab"][0]["pos"] == "other"


def test_parse_explain_answer_caps_vocab_and_grammar_counts():
    vocab = [{"word": f"w{i}", "meaning": f"m{i}", "pos": "noun"} for i in range(10)]
    grammar = [{"pattern": f"p{i}", "explanation": f"e{i}"} for i in range(10)]
    raw = json.dumps({"vocab": vocab, "grammar": grammar})

    result = explain.parse_explain_answer(raw)

    assert len(result["vocab"]) == explain.MAX_VOCAB_ITEMS
    assert len(result["grammar"]) == explain.MAX_GRAMMAR_ITEMS


def test_parse_explain_answer_garbage_falls_back_to_summary():
    raw = "Sorry, I can't help with that request."

    assert explain.parse_explain_answer(raw) == {"summary": raw}


def test_parse_explain_answer_empty_object_returns_empty_dict():
    assert explain.parse_explain_answer("{}") == {}


# -- parse_explain_answer: grammar span -----------------------------------


def test_parse_explain_answer_keeps_span_that_is_a_real_substring():
    raw = json.dumps({
        "grammar": [{"pattern": "に", "explanation": "marks the destination.", "span": "学校に"}]
    })

    result = explain.parse_explain_answer(raw, sentence_ja="学校に行きます。")

    assert result["grammar"] == [
        {"pattern": "に", "explanation": "marks the destination.", "span": "学校に"}
    ]


def test_parse_explain_answer_grammar_item_without_span_is_unaffected():
    raw = json.dumps({"grammar": [{"pattern": "に", "explanation": "marks the destination."}]})

    result = explain.parse_explain_answer(raw, sentence_ja="学校に行きます。")

    assert result["grammar"] == [{"pattern": "に", "explanation": "marks the destination."}]
    assert "span" not in result["grammar"][0]


def test_parse_explain_answer_drops_span_that_is_not_a_substring():
    raw = json.dumps({
        "grammar": [{"pattern": "に", "explanation": "marks the destination.", "span": "not in the sentence"}]
    })

    result = explain.parse_explain_answer(raw, sentence_ja="学校に行きます。")

    assert result["grammar"] == [{"pattern": "に", "explanation": "marks the destination."}]
    assert "span" not in result["grammar"][0]
