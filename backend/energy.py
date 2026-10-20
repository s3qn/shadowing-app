"""bl52-energy: a daily energy meter per device, spent by the routes that cost
an AI call, with a global daily stop and owner grants.

Everything is behind SHADOW_ENERGY, off by default. With it off `charge` is a
no-op, `status` is never called by a route, and no route sends `no_energy` or
`global_limit`, so the backend behaves exactly as before the flag existed.

PRICES is the only price table. One unit is at most about $0.001 on the
cheapest mix, so while the backend runs on the claude CLI and local whisper
the global stop counts calls, never dollars: 3000 a day is at most about 600
creates or 1500 explain turns. Module-level constants so tests monkeypatch
them without touching the environment.
"""

import logging
import os
import threading
from datetime import datetime, timedelta, timezone

from fastapi import HTTPException

import store
import suggest

log = logging.getLogger("shadow.energy")

ON = os.getenv("SHADOW_ENERGY", "0") == "1"
DAILY_UNITS = int(os.getenv("SHADOW_DAILY_UNITS", "60"))
GLOBAL_DAILY_UNITS = int(os.getenv("SHADOW_GLOBAL_DAILY_UNITS", "3000"))
WARN_FRACTION = float(os.getenv("SHADOW_ENERGY_WARN", "0.8"))
GRANT_MAX = 1000

# Takes, word audio, playback, review and practice cost nothing and stay
# under main.DAILY_CAPS. Imports (file, podcast, YouTube) are a flat 10,
# whatever their length: one number to change if Sean wants it per minute.
PRICES = {
    "create": 5,
    "phrases": 1,
    "regenerate": 3,
    "revoice": 1,
    "import": 10,
    "explain": 2,
    "word": 1,
}

# The last warning relay thread, kept so a test can join it.
_warn_thread: threading.Thread | None = None


def refill_at(now: datetime | None = None) -> str:
    """The next 00:00 UTC as an ISO string: when every daily meter refills."""
    now = now or datetime.now(timezone.utc)
    nxt = (now + timedelta(days=1)).replace(hour=0, minute=0, second=0, microsecond=0)
    return nxt.isoformat(timespec="seconds")


def _balances(device: str) -> tuple[int, int]:
    """(daily_left, granted_left); see store.energy_balances."""
    return store.energy_balances(device, DAILY_UNITS)


def status(device: str, owner: bool) -> dict:
    """What the client shows. The owner is never charged and sees a full
    meter."""
    if owner:
        daily_left, granted_left = DAILY_UNITS, 0
    else:
        daily_left, granted_left = _balances(device)
    last = store.energy_last_grant(device)
    return {
        "on": True,
        "daily_max": DAILY_UNITS,
        "daily_left": daily_left,
        "granted_left": granted_left,
        "refill_at": refill_at(),
        "prices": dict(PRICES),
        "owner": owner,
        "last_grant": (
            {"id": last["id"], "amount": last["amount"], "at": last["created_at"]}
            if last else None
        ),
    }


def _relay_warning(text: str) -> None:
    suggest._relay_to_discord(text, prefix="")


def charge(device: str, kind: str, owner: bool) -> None:
    """Spends PRICES[kind] for the device, or raises 429 before any write.
    Callers run it after their own cap check and before the build-slot
    write, so a refused charge never burns a slot and a cap 429 never burns
    energy. The global stop and the one-a-day warning read the whole
    ledger."""
    global _warn_thread
    if not ON or owner:
        return
    units = PRICES[kind]
    code, after, warn = store.energy_spend(
        device, kind, units, DAILY_UNITS, GLOBAL_DAILY_UNITS,
        GLOBAL_DAILY_UNITS * WARN_FRACTION,
    )
    if code == "no_energy":
        raise HTTPException(
            429, {"code": "no_energy", "refill_at": refill_at(), "need": units}
        )
    if code == "global_limit":
        raise HTTPException(429, {"code": "global_limit", "refill_at": refill_at()})
    if warn:
        text = (
            f"Energy: {round(WARN_FRACTION * 100)}% of today's global budget used"
            f" ({after} of {GLOBAL_DAILY_UNITS} ⚡)"
        )
        log.warning(text)
        _warn_thread = threading.Thread(target=_relay_warning, args=(text,), daemon=True)
        _warn_thread.start()


def refund(device: str, kind: str, owner: bool) -> bool:
    """Gives back the device's last charge of `kind`, for a call whose AI
    step failed and left nothing cached, so a retap is not charged twice.
    A negative ledger row with the same kind and split, so the daily, grant
    and global totals all net out. No-op where `charge` was one. True when
    a charge was given back."""
    if not ON or owner:
        return False
    if not store.energy_refund(device, kind):
        return False
    log.info("energy: refunded %s to %s", kind, device)
    return True


def grant(granted_by: str, target_device: str, username: str, amount: int,
          note: str = "", target_owner: bool = False) -> dict:
    """Adds `amount` to the target's grant balance and returns their status.
    Grants never expire; spending one still counts against the global
    budget."""
    if not (1 <= amount <= GRANT_MAX):
        raise HTTPException(400, {"code": "bad_amount"})
    store.energy_add_grant(target_device, username, amount, note, granted_by)
    log.info("energy: %s granted %d to @%s (%s)", granted_by, amount, username, note)
    return status(target_device, target_owner)
