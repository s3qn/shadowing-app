"""Tests for main._span: the start/end ms pair the audio and take routes
accept for a phrase. Importing main starts nothing: no server, no VOICEVOX,
no whisper model."""

import pytest
from fastapi import HTTPException

import main


def test_span_both_minus_one_is_the_whole_line():
    assert main._span(-1, -1) is None


def test_span_valid_pair_passes_through():
    assert main._span(120, 900) == (120, 900)


@pytest.mark.parametrize(
    "start,end",
    [
        (-2, 500),  # below -1
        (100, -5),  # below -1
        (-7, -7),  # both below -1 must not read as the whole line
        (-1, 500),  # one without the other
        (500, 500),  # empty
        (900, 100),  # backwards
    ],
)
def test_span_rejects_bad_pairs_with_400(start, end):
    with pytest.raises(HTTPException) as exc:
        main._span(start, end)
    assert exc.value.status_code == 400
