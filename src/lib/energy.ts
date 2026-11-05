/**
 * The daily AI energy meter: one store for GET /energy, read by the Home
 * badge and every AI button. `on` false (metering off) means no UI at all.
 * A spend is optimistic so the bolt starts draining on the tap; the refresh
 * after the request puts the server's number back.
 */
import { useEffect, useSyncExternalStore } from 'react';

import { getEnergy, type Energy } from '@/lib/api';

export type EnergyKind = 'create' | 'import' | 'regenerate' | 'say';
export type EnergyLevel = 'full' | 'low' | 'empty';

export const ENERGY_LOW = 10;
const FALLBACK_PRICES: Record<string, number> = { create: 5, import: 10, regenerate: 3, say: 1 };

let server: Energy | null = null;
let dev: number | null = null;
let snap: Energy | null = null;
const listeners = new Set<() => void>();

function rebuild(): void {
  if (dev !== null) {
    snap = {
      on: true,
      daily_max: 60,
      daily_left: dev,
      granted_left: 0,
      refill_at: 0,
      prices: server?.prices ?? FALLBACK_PRICES,
      owner: false,
      last_grant: null,
      builds_max: 5,
      builds_left: 5,
    };
  } else {
    snap = server;
  }
  listeners.forEach((l) => l());
}

export async function refreshEnergy(): Promise<void> {
  if (dev !== null) return;
  try {
    server = await getEnergy();
    rebuild();
  } catch {
    // Offline or an older server: keep what we had.
  }
}

/** Dev simulate: pin the meter to n units, or null to go back to the server. */
export function setDevEnergy(n: number | null): void {
  if (!__DEV__) return;
  dev = n;
  rebuild();
}

export function priceOf(e: Energy | null, kind: EnergyKind): number {
  return e?.prices?.[kind] ?? FALLBACK_PRICES[kind];
}

export function energyLevel(left: number): EnergyLevel {
  return left <= 0 ? 'empty' : left <= ENERGY_LOW ? 'low' : 'full';
}

/** Whether an AI action of this kind can run. Metering off or the owner always can. */
export function canAfford(e: Energy | null, kind: EnergyKind): boolean {
  if (!e || !e.on || e.owner) return true;
  return e.daily_left + e.granted_left >= priceOf(e, kind);
}

/** The optimistic drop, split like the server's ledger: the daily units go
 * first and the rest comes out of the grant. */
function spend(kind: EnergyKind): void {
  const e = snap;
  if (!e || !e.on || e.owner) return;
  const price = priceOf(e, kind);
  const fromDaily = Math.min(Math.max(0, e.daily_left), price);
  const daily = e.daily_left - fromDaily;
  const granted = Math.max(0, e.granted_left - (price - fromDaily));
  if (dev !== null) dev = daily;
  else if (server) server = { ...server, daily_left: daily, granted_left: granted };
  rebuild();
}

/** After an explain or word tap, which the server may have charged: re-read
 * the meter while metering is on. */
export function refreshEnergyAfterAi(): void {
  if (snap?.on && !snap.owner) void refreshEnergy();
}

/** Run an AI action: the meter drops on the tap and is refreshed from the server afterwards. */
export async function withEnergy<T>(kind: EnergyKind, run: () => Promise<T>): Promise<T> {
  spend(kind);
  try {
    return await run();
  } finally {
    void refreshEnergy();
  }
}

export function useEnergy(): Energy | null {
  const e = useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => snap,
    () => snap,
  );
  useEffect(() => {
    if (!snap) void refreshEnergy();
  }, []);
  return e;
}
