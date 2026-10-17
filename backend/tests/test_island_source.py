"""The island JSON carries `source`: the client hides Re-voice and Regenerate
for anything but a recorded island, which the backend refuses with 409."""

import asyncio

import pytest

import main
import schedule
import store


@pytest.fixture(autouse=True)
def _init_db():
    store.init()
    schedule.init()


AUTH = f"Bearer {main.SHADOW_TOKEN}"
DEV = "cccccccc-0000-4000-8000-000000000003"


@pytest.mark.parametrize("source", ["voice", "phrases", "import", "podcast", "youtube", "grammar"])
def test_get_island_and_list_return_source(source):
    iid = store.create_island("simple", 3, source=source, device=DEV)

    island = asyncio.run(main.get_island(iid, authorization=AUTH, x_shadow_device=DEV))
    assert island["source"] == source

    listed = next(i for i in store.list_islands(DEV) if i["id"] == iid)
    assert listed["source"] == source
