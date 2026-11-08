"""bl52-energy: a daily energy meter per device, spent by the three routes
that make a new island from scratch, with a global daily stop and owner
grants. Sean: "one island a day, which is 5 a day".

Everything is behind SHADOW_ENERGY, on by default (SHADOW_ENERGY=0 turns it
off). With it off `charge` is a no-op, `status` is never called by a route, and
no route sends `no_energy` or `global_limit`.

PRICES is the only price table and holds only the paid kinds, so a stray
charge of a free kind is a loud KeyError in tests instead of a silent spend.
One unit is at most about $0.001 on the cheapest mix, so while the backend
runs on the claude CLI and local whisper the global stop counts calls, never
dollars: 3000 a day is at most about 600 creates or 1000 regenerates.
Module-level constants so tests monkeypatch them without touching the
environment.
"""

import logging
import os
import threading
from datetime import datetime, timedelta, timezone

from fastapi import HTTPException

import store_energy
import suggest

log = logging.getLogger("shadow.energy")

ON = os.getenv("SHADOW_ENERGY", "1") != "0"
DAILY_UNITS = int(os.getenv("SHADOW_DAILY_UNITS", "5"))
GLOBAL_DAILY_UNITS = int(os.getenv("SHADOW_GLOBAL_DAILY_UNITS", "3000"))
WARN_FRACTION = float(os.getenv("SHADOW_ENERGY_WARN", "0.8"))
GRANT_MAX = 1000

# Only a new island costs energy. Explain, phrases, say, word audio, re-voice,
# picks, catch meanings, takes, playback, review and practice cost nothing and
# stay under the hidden daily caps (dependencies.DAILY_CAPS, config.DAILY_SAYS).
# Imports (file, podcast, YouTube) are a flat 10, whatever their length: one
# number to change if Sean wants it per minute.
PRICES = {
    "create": 5,
    "regenerate": 3,
    "import": 10,
}

# Kinds that used to cost energy and are free now. Builds up to 24 gate the
# Say button with canAfford(energy, "say") and fall back to a price of 1 when
# the server omits the kind, so status() sends these as an explicit 0. They
# stay out of PRICES, so charge() still refuses them.
FREE_FOR_OLD_CLIENTS = {"say": 0}

# The last warning relay thread, kept so a test can join it.
_warn_thread: threading.Thread | None = None


def refill_at(now: datetime | None = None) -> str:
    """The next 00:00 UTC as an ISO string: when every daily meter refills."""
    now = now or datetime.now(timezone.utc)
    nxt = (now + timedelta(days=1)).replace(hour=0, minute=0, second=0, microsecond=0)
    return nxt.isoformat(timespec="seconds")


def _balances(device: str) -> tuple[int, int]:
    """(daily_left, granted_left); see store_energy.energy_balances."""
    return store_energy.energy_balances(device, DAILY_UNITS)


def status(device: str, owner: bool) -> dict:
    """What the client shows. The owner is never charged and sees a full
    meter. `spent_today` feeds the energy sheet's "Spent today" bar: the
    day's net units per paid kind, so a refunded build is not shown."""
    if owner:
        daily_left, granted_left = DAILY_UNITS, 0
    else:
        daily_left, granted_left = _balances(device)
    last = store_energy.energy_last_grant(device)
    by_kind = store_energy.energy_spent_today_by_kind(device)
    return {
        "on": True,
        "daily_max": DAILY_UNITS,
        "daily_left": daily_left,
        "granted_left": granted_left,
        "refill_at": refill_at(),
        "spent_today": {"units": sum(by_kind.values()), "by_kind": by_kind},
        "prices": {**FREE_FOR_OLD_CLIENTS, **PRICES},
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
    code, after, warn = store_energy.energy_spend(
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
    if not store_energy.energy_refund(device, kind):
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
    store_energy.energy_add_grant(target_device, username, amount, note, granted_by)
    log.info("energy: %s granted %d to @%s (%s)", granted_by, amount, username, note)
    return status(target_device, target_owner)
