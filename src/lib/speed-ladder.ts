/**
 * Each island's own playback speed, climbing from `LADDER_MIN` toward
 * `LADDER_MAX` when the shadower keeps up with most of the words, and
 * stepping back when they fall behind. One JSON file in the app's document
 * directory, shaped `{ [islandId]: Rung }`, same file, cache and debounce
 * pattern as `last-line.ts`. Takes and their scores live only on the phone
 * (`takes.ts`), so this file lives there too: no server column, no
 * migration.
 */

import { documentDirectory, getInfoAsync, readAsStringAsync, writeAsStringAsync } from 'expo-file-system/legacy';

import { SPEED_MAX, SPEED_MIN } from '@/constants/theme';

export const LADDER_MIN = 0.5;
export const LADDER_MAX = 1.0;
export const LADDER_STEP = 0.05;
export const LADDER_UP = 0.9;
export const LADDER_DOWN = 0.85;
export const LADDER_TAKES = 3;
export const LADDER_MIN_WORDS = 10;

/** An island's rung on the speed ladder: its current speed and the takes pooled toward the next decision. */
export type Rung = { speed: number; takes: number; kept: number; total: number };

function round2(speed: number): number {
  return Math.round(speed * 100) / 100;
}

/**
 * Folds one scored take into a rung. Pools `kept`/`total` words across
 * `LADDER_TAKES` takes rather than averaging per-take percentages, so one
 * short line cannot outweigh a long one, and holds off any decision until
 * `LADDER_MIN_WORDS` words have been seen. Once a decision is made (climb,
 * drop or hold), the counters reset to 0 so the next decision starts fresh
 * from the current speed.
 */
export function stepRung(rung: Rung, take: { kept: number; total: number }): { rung: Rung; moved: 'up' | 'down' | null } {
  const takes = rung.takes + 1;
  const kept = rung.kept + take.kept;
  const total = rung.total + take.total;
  if (takes < LADDER_TAKES || total < LADDER_MIN_WORDS) {
    return { rung: { ...rung, takes, kept, total }, moved: null };
  }
  const ratio = kept / total;
  if (ratio >= LADDER_UP) {
    const speed = rung.speed < LADDER_MAX ? round2(Math.min(LADDER_MAX, rung.speed + LADDER_STEP)) : rung.speed;
    return { rung: { speed, takes: 0, kept: 0, total: 0 }, moved: rung.speed < LADDER_MAX ? 'up' : null };
  }
  if (ratio < LADDER_DOWN) {
    const speed = round2(Math.max(LADDER_MIN, rung.speed - LADDER_STEP));
    return { rung: { speed, takes: 0, kept: 0, total: 0 }, moved: speed === rung.speed ? null : 'down' };
  }
  return { rung: { ...rung, takes: 0, kept: 0, total: 0 }, moved: null };
}

const FILE = `${documentDirectory ?? ''}speed-ladder.json`;

let cache: Record<string, Rung> | null = null;
let loading: Promise<Record<string, Rung>> | null = null;

function validRung(v: unknown): Rung | null {
  if (typeof v !== 'object' || v === null) return null;
  const r = v as Record<string, unknown>;
  const { speed, takes, kept, total } = r;
  if (typeof speed !== 'number' || !Number.isFinite(speed) || speed < SPEED_MIN || speed > SPEED_MAX) return null;
  for (const n of [takes, kept, total]) {
    if (typeof n !== 'number' || !Number.isInteger(n) || n < 0) return null;
  }
  return { speed, takes: takes as number, kept: kept as number, total: total as number };
}

async function load(): Promise<Record<string, Rung>> {
  if (cache) return cache;
  if (!loading) {
    loading = (async () => {
      try {
        if (!(await getInfoAsync(FILE)).exists) return (cache = {});
        const raw = await readAsStringAsync(FILE);
        const parsed = JSON.parse(raw) as unknown;
        if (typeof parsed !== 'object' || parsed === null) return (cache = {});
        const next: Record<string, Rung> = {};
        for (const [id, v] of Object.entries(parsed as Record<string, unknown>)) {
          const rung = validRung(v);
          if (rung) next[id] = rung;
        }
        return (cache = next);
      } catch {
        return (cache = {});
      }
    })();
  }
  return loading;
}

let writeTimer: ReturnType<typeof setTimeout> | null = null;

function scheduleWrite(): void {
  if (writeTimer) return;
  writeTimer = setTimeout(() => {
    writeTimer = null;
    void writeAsStringAsync(FILE, JSON.stringify(cache ?? {})).catch(() => {});
  }, 1000);
}

/** Warms the cache so `peekRung` has something to read before the player mounts. */
export async function loadLadder(): Promise<void> {
  await load();
}

/** An island's rung, creating `{ speed: start, takes: 0, kept: 0, total: 0 }` in memory (not written) when absent. */
export async function getRung(islandId: string, start: number): Promise<Rung> {
  const all = await load();
  return all[islandId] ?? { speed: start, takes: 0, kept: 0, total: 0 };
}

/** The rung if the file has already been read, else undefined. Call `getRung` or `loadLadder` earlier to have it read by then. */
export function peekRung(islandId: string): Rung | undefined {
  return cache?.[islandId];
}

/** Manual override: sets the island's speed and zeroes its pooled counters, discarding any pending ladder decision. */
export function setRungSpeed(islandId: string, speed: number): void {
  void load().then((all) => {
    all[islandId] = { speed, takes: 0, kept: 0, total: 0 };
    cache = all;
    scheduleWrite();
  });
}

/** Folds one scored take into the island's rung (creating it at `start` if absent) and writes the result. */
export async function recordTake(
  islandId: string,
  start: number,
  take: { kept: number; total: number },
): Promise<{ moved: 'up' | 'down' | null; speed: number }> {
  const all = await load();
  const current = all[islandId] ?? { speed: start, takes: 0, kept: 0, total: 0 };
  const { rung, moved } = stepRung(current, take);
  all[islandId] = rung;
  cache = all;
  scheduleWrite();
  return { moved, speed: rung.speed };
}

/** Forgets a deleted island's rung. */
export function forgetRung(islandId: string): void {
  void load().then((all) => {
    if (!(islandId in all)) return;
    delete all[islandId];
    cache = all;
    scheduleWrite();
  });
}
