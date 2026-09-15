"""The line audio route's pad clamp in main.py. The player's Pause goes up to
10s and is sent as the `pad` query param, so the route must not cut it short.
Importing main starts nothing (see test_span.py)."""

import main


def test_pad_keeps_the_longest_pause():
    assert main._clamp_pad(10000) == 10000


def test_pad_keeps_a_half_second_step():
    assert main._clamp_pad(7500) == 7500


def test_pad_clamps_out_of_range():
    assert main._clamp_pad(-1) == 0
    assert main._clamp_pad(60000) == main.PAD_MAX_MS
