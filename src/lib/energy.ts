/**
 * The daily AI energy meter: one store for GET /energy, read by the Home
 * badge and every AI button. `on` false (metering off) means no UI at all.
 * A spend is optimistic so the bolt starts draining on the tap; the refresh
 * after the request puts the server's number back.
 */
import { useCallback, useEffect, useSyncExternalStore } from 'react';

import { getEnergy, type Energy } from '@/lib/api';

const DAY_MS = 86_400_000;

/** The paid kinds. Every other AI call is free under the server's hidden daily caps. */
export type EnergyKind = 'create' | 'import' | 'regenerate';
export type EnergyLevel = 'full' | 'low' | 'empty';

/** Some left but less than one island (5): the meter turns amber. */
export const ENERGY_LOW = 4;
const DEV_MAX = 5;
const FALLBACK_PRICES: Record<string, number> = { create: 5, import: 10, regenerate: 3 };

let server: Energy | null = null;
let dev: { daily: number; granted: number } | null = null;
let devTimer: ReturnType<typeof setTimeout> | null = null;
let snap: Energy | null = null;
const listeners = new Set<() => void>();

/** The next 00:00 UTC as an ISO string, the shape the server's `refill_at` has. */
export function nextUtcMidnight(now = new Date()): string {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1)).toISOString();
}

function rebuild(): void {
  if (dev !== null) {
    const spent = Math.min(DEV_MAX, Math.max(0, DEV_MAX - dev.daily));
    snap = {
      on: true,
      daily_max: DEV_MAX,
      daily_left: dev.daily,
      granted_left: dev.granted,
      refill_at: nextUtcMidnight(),
      spent_today: { units: spent, by_kind: spent > 0 ? { create: spent } : {} },
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

/** Dev simulate: pin the meter to n daily units (plus a grant), or null to go back to the server. */
export function setDevEnergy(n: number | null, granted = 0): void {
  if (!__DEV__) return;
  if (devTimer) {
    clearTimeout(devTimer);
    devTimer = null;
  }
  dev = n === null ? null : { daily: n, granted };
  rebuild();
}

/** Dev simulate: the next step of a motion, `ms` later (a spend, refill or purchase without a build). */
export function setDevEnergyLater(n: number, granted: number, ms: number): void {
  if (!__DEV__) return;
  devTimer = setTimeout(() => {
    devTimer = null;
    setDevEnergy(n, granted);
  }, ms);
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

/** The meter as it stands, for code outside React (the regenerate gate in a hook's plain function). */
export function energyNow(): Energy | null {
  return snap;
}

/** Hours and minutes until `refillAt`, and `waited`, the share of the day
 * already behind us (0..1). A missing or unreadable value means the next 00:00 UTC. */
export function refillCountdown(refillAt: string | undefined, now: number): { h: number; m: number; waited: number } {
  const parsed = refillAt ? Date.parse(refillAt) : NaN;
  const at = Number.isFinite(parsed) ? parsed : Date.parse(nextUtcMidnight(new Date(now)));
  const mins = Math.max(0, Math.ceil((at - now) / 60_000));
  return { h: Math.floor(mins / 60), m: mins % 60, waited: Math.min(1, Math.max(0, 1 - (at - now) / DAY_MS)) };
}

/** "6h 12m" (or "12m") until `refillAt`. */
export function untilRefill(refillAt: string | undefined, now: number): string {
  const { h, m } = refillCountdown(refillAt, now);
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}

/** The current minute (ms / 60 000), re-read once a minute while `on`; a change of `on` re-reads it at once. */
export function useMinute(on: boolean): number {
  const subscribe = useCallback(
    (notify: () => void) => {
      if (!on) return () => {};
      const id = setInterval(notify, 60_000);
      return () => clearInterval(id);
    },
    [on],
  );
  return useSyncExternalStore(subscribe, () => Math.floor(Date.now() / 60_000));
}

// --- empty-energy moment ---
// A paid tap at 0 ⚡ is never a disabled button: it asks for energy here and
// `NoEnergyHost` (mounted once in _layout.tsx, like the confirm sheet) shows
// the empty-energy sheet. In memory, one request at a time.
export type NoEnergyRequest = { kind: EnergyKind; seq: number };
let noEnergy: NoEnergyRequest | null = null;
let noEnergySeq = 0;
const noEnergyListeners = new Set<() => void>();

export function requestEnergy(kind: EnergyKind): void {
  noEnergy = { kind, seq: ++noEnergySeq };
  noEnergyListeners.forEach((l) => l());
}

/** The host calls this once its sheet has left the screen. */
export function clearNoEnergy(): void {
  noEnergy = null;
  noEnergyListeners.forEach((l) => l());
}

export function useNoEnergy(): NoEnergyRequest | null {
  return useSyncExternalStore(
    (l) => {
      noEnergyListeners.add(l);
      return () => noEnergyListeners.delete(l);
    },
    () => noEnergy,
    () => noEnergy,
  );
}

/** A paid button's tap: run the action when it is affordable, else open the empty-energy sheet. */
export function gateEnergy(kind: EnergyKind, run: () => void): void {
  if (canAfford(snap, kind)) run();
  else requestEnergy(kind);
}
// --- end empty-energy moment ---

/** The optimistic drop, split like the server's ledger: the daily units go
 * first and the rest comes out of the grant. */
function spend(kind: EnergyKind): void {
  const e = snap;
  if (!e || !e.on || e.owner) return;
  const price = priceOf(e, kind);
  const fromDaily = Math.min(Math.max(0, e.daily_left), price);
  const daily = e.daily_left - fromDaily;
  const granted = Math.max(0, e.granted_left - (price - fromDaily));
  if (dev !== null) dev = { daily, granted };
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

// --- support-packs ---
/** A verified pack's answer carries the meter: swap the snapshot in place, no
 * second fetch. Under a simulate key the fake store is the truth, so a server
 * snapshot is ignored. */
export function applyServerEnergy(e: Energy): void {
  if (dev !== null) return;
  server = e;
  rebuild();
}

/** Dev simulate: move the grant balance by `delta` (a fake pack, a fake
 * refund), never below 0. Pins the meter to the fake store if it was not. */
export function devAdjustGranted(delta: number): void {
  if (!__DEV__) return;
  const base = dev ?? { daily: snap?.daily_left ?? DEV_MAX, granted: snap?.granted_left ?? 0 };
  dev = { daily: base.daily, granted: Math.max(0, base.granted + delta) };
  rebuild();
}
// --- end support-packs ---

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
