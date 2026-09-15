"""Tests for the register field on the island build and regenerate routes in
main.py. Importing main starts nothing: no server, no VOICEVOX, no whisper
model (see test_span.py). Form(...) defaults are FastAPI FieldInfo objects
with a `.default` attribute, inspected directly rather than through a live
HTTP request, so these need no TestClient and no network."""

import inspect

import main


def _form_default(func, name):
    return inspect.signature(func).parameters[name].default.default


def test_create_island_register_defaults_to_polite():
    assert _form_default(main.create_island, "register") == "polite"


def test_create_island_register_is_a_valid_register_rule():
    # The default must itself pass the route's own validation.
    assert _form_default(main.create_island, "register") in main.generate.REGISTER_RULES
