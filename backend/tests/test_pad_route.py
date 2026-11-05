"""The line audio route's pad clamp in main.py. The player's Pause goes up to
10s and is sent as the `pad` query param, so the route must not cut it short.
Importing main starts nothing (see test_span.py)."""

from services import line_audio


def test_pad_keeps_the_longest_pause():
    assert line_audio._clamp_pad(10000) == 10000


def test_pad_keeps_a_half_second_step():
    assert line_audio._clamp_pad(7500) == 7500


def test_pad_clamps_out_of_range():
    assert line_audio._clamp_pad(-1) == 0
    assert line_audio._clamp_pad(60000) == line_audio.PAD_MAX_MS


def test_pad_keeps_the_drive_gap():
    assert line_audio._clamp_pad(20000) == 20000
