"""Pins the HTTP surface while main.py is split into routers.

(a) the set of (methods, path) equals the snapshot, with no duplicates;
(b) for every pair of routes that can shadow each other (same method, same
segment count, each segment equal or one a {param}) the registration order
equals the old app's; (c) the OpenAPI document is unchanged.
Retake the snapshots with SNAPSHOT_WRITE=1 only for an intended API change.
"""

import json
import os
from pathlib import Path

import pytest

import main

SNAP = Path(__file__).parent / "snapshots"

pytestmark = pytest.mark.skipif(
    os.environ.get("SHADOW_ENV") == "prod", reason="dev routers are off in prod"
)


def _routes():
    out = []
    for r in main.app.routes:
        methods = getattr(r, "methods", None)
        if methods is None:
            continue
        out.append((sorted(methods), r.path))
    return out


def _collide(a: str, b: str) -> bool:
    sa, sb = a.strip("/").split("/"), b.strip("/").split("/")
    if len(sa) != len(sb):
        return False
    return all(
        x == y or (x.startswith("{") and x.endswith("}")) or (y.startswith("{") and y.endswith("}"))
        for x, y in zip(sa, sb)
    )


def _order():
    """[method, earlier path, later path] for each colliding pair, in
    registration order. Identical paths are skipped (a duplicate is caught
    by test (a))."""
    flat = [(m, r.path) for r in main.app.routes if getattr(r, "methods", None) for m in sorted(r.methods)]
    pairs = []
    for i, (m1, p1) in enumerate(flat):
        for m2, p2 in flat[i + 1 :]:
            if m1 == m2 and p1 != p2 and _collide(p1, p2):
                pairs.append([m1, p1, p2])
    return sorted(pairs)


def _load(name):
    return json.loads((SNAP / name).read_text())


def write_snapshots():
    SNAP.mkdir(exist_ok=True)
    routes = sorted([m, p] for m, p in _routes())
    (SNAP / "routes.json").write_text(json.dumps(routes, indent=1) + "\n")
    (SNAP / "route_order.json").write_text(json.dumps(_order(), indent=1) + "\n")
    (SNAP / "openapi.json").write_text(json.dumps(main.app.openapi(), indent=1, sort_keys=True) + "\n")


if os.environ.get("SNAPSHOT_WRITE") == "1":
    write_snapshots()


def test_route_set_unchanged():
    got = sorted([m, p] for m, p in _routes())
    assert len(got) == len({json.dumps(x) for x in got})
    assert got == _load("routes.json")


def test_colliding_route_order_unchanged():
    assert _order() == _load("route_order.json")


def test_openapi_unchanged():
    assert main.app.openapi() == _load("openapi.json")
