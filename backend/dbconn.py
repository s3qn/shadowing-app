"""The per-thread sqlite connection every database module shares.

Routes hop onto asyncio.to_thread's reused worker threads, so one connection
per thread is a real cache, not a one-shot open-and-close. check_same_thread
stays on: a connection is only ever touched by the thread that opened it, the
same guarantee threading.local already gives its contents.
"""

import sqlite3
import threading
from collections.abc import Callable
from pathlib import Path


def thread_conn(
    local: threading.local, path: Path, *pragmas: str,
    setup: Callable[[sqlite3.Connection], None] | None = None, mkdir: bool = False,
) -> sqlite3.Connection:
    """This thread's connection to `path`, cached on `local.conn`. Opens a new
    one when the module's DB_PATH has changed (tests repoint it). Each pragma
    runs once on open, then `setup`; `mkdir` creates the folder first."""
    conn = getattr(local, "conn", None)
    if conn is None or getattr(local, "path", None) != path:
        if mkdir:
            path.parent.mkdir(parents=True, exist_ok=True)
        conn = sqlite3.connect(path)
        conn.row_factory = sqlite3.Row
        for pragma in pragmas:
            conn.execute(f"PRAGMA {pragma}")
        if setup is not None:
            setup(conn)
        local.conn = conn
        local.path = path
    return conn
