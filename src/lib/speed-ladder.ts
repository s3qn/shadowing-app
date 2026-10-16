/**
 * Each island's own playback speed, climbing from `LADDER_MIN` toward
 * `LADDER_MAX` when the shadower keeps up with most of the words, and
 * stepping back when they fall behind. One JSON file in the app's document
 * directory, shaped `{ [islandId]: Rung }`, same file, cache and debounce
 * pattern as `last-line.ts`. Takes and their scores live only on the phone
 * (`takes.ts`), so this file lives there too: no server column, no
 * migration.
 *
 * Only a rung the shadower set by hand (`manual`) opens an island below the
 * Settings default speed. The ladder's own moves never drop under that
 * default, and an automatic rung stored below it (from when the default was
 * 0.5, or from a default raised since) reads as absent.
 */

import { documentDirectory, getInfoAsync, readAsStringAsync, writeAsStringAsync } from 'expo-file-system/legacy';

import { SPEED_MAX, SPEED_MIN } from '@/constants/theme';
import { getSettings, getSettingsSync } from '@/lib/settings';

export const LADDER_MIN = 0.5;
export const LADDER_MAX = 1.2;
export const LADDER_STEP = 0.05;
export const LADDER_UP = 0.9;
export const LADDER_DOWN = 0.85;
export const LADDER_TAKES = 3;
export const LADDER_MIN_WORDS = 10;

/** An island's rung on the speed ladder: its current speed, the takes pooled
 * toward the next decision, and whether the speed was set by hand. */
export type Rung = { speed: number; takes: number; kept: number; total: number; manual?: boolean };

function round2(speed: number): number {
  return Math.round(speed * 100) / 100;
}

/**
 * Folds one scored take into a rung. Pools `kept`/`total` words across
 * `LADDER_TAKES` takes rather than averaging per-take percentages, so one
 * short line cannot outweigh a long one, and holds off any decision until
 * `LADDER_MIN_WORDS` words have been seen. Once a decision is made (climb,
 * drop or hold), the counters reset to 0 so the next decision starts fresh
 * from the current speed. An automatic rung never steps below `floor` (the
 * Settings default speed); a manual one keeps its flag and steps down to
 * `LADDER_MIN`.
 */
export function stepRung(
  rung: Rung,
  take: { kept: number; total: number },
  floor: number = LADDER_MIN,
): { rung: Rung; moved: 'up' | 'down' | null } {
  const takes = rung.takes + 1;
  const kept = rung.kept + take.kept;
  const total = rung.total + take.total;
  if (takes < LADDER_TAKES || total < LADDER_MIN_WORDS) {
    return { rung: { ...rung, takes, kept, total }, moved: null };
  }
  const ratio = kept / total;
  if (ratio >= LADDER_UP) {
    const speed = rung.speed < LADDER_MAX ? round2(Math.min(LADDER_MAX, rung.speed + LADDER_STEP)) : rung.speed;
    return { rung: { ...rung, speed, takes: 0, kept: 0, total: 0 }, moved: rung.speed < LADDER_MAX ? 'up' : null };
  }
  if (ratio < LADDER_DOWN) {
    const low = rung.manual ? LADDER_MIN : Math.max(LADDER_MIN, Number.isFinite(floor) ? floor : LADDER_MIN);
    // Never climbs: a rung already under the floor holds where it is.
    const speed = Math.min(rung.speed, round2(Math.max(low, rung.speed - LADDER_STEP)));
    return { rung: { ...rung, speed, takes: 0, kept: 0, total: 0 }, moved: speed === rung.speed ? null : 'down' };
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
  const rung: Rung = { speed, takes: takes as number, kept: kept as number, total: total as number };
  if (r.manual === true) rung.manual = true;
  return rung;
}

/** The rung, unless it is an automatic one below the default speed: those
 * predate the default being raised (or the ladder flooring at it) and must
 * not open the island slower than Settings says. */
function live(rung: Rung | undefined, defaultSpeed: number): Rung | undefined {
  if (!rung) return undefined;
  if (!rung.manual && rung.speed < defaultSpeed - 0.001) return undefined;
  return rung;
}

async function load(): Promise<Record<string, Rung>> {
  if (cache) return cache;
  if (!loading) {
    loading = (async () => {
      // Reads settings first so `peekRung`'s synchronous default is the saved
      // one by the time the cache is warm.
      const defaultSpeed = await getSettings()
        .then((s) => s.defaultSpeed)
        .catch(() => getSettingsSync().defaultSpeed);
      try {
        if (!(await getInfoAsync(FILE)).exists) return (cache = {});
        const raw = await readAsStringAsync(FILE);
        const parsed = JSON.parse(raw) as unknown;
        if (typeof parsed !== 'object' || parsed === null) return (cache = {});
        const next: Record<string, Rung> = {};
        for (const [id, v] of Object.entries(parsed as Record<string, unknown>)) {
          const rung = live(validRung(v) ?? undefined, defaultSpeed);
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
  return live(all[islandId], getSettingsSync().defaultSpeed) ?? { speed: start, takes: 0, kept: 0, total: 0 };
}

/** The rung if the file has already been read, else undefined. Call `getRung` or `loadLadder` earlier to have it read by then. */
export function peekRung(islandId: string): Rung | undefined {
  return live(cache?.[islandId], getSettingsSync().defaultSpeed);
}

/** Manual override: sets the island's speed, marks it manual so it outranks
 * the default speed, and zeroes its pooled counters, discarding any pending
 * ladder decision. */
export function setRungSpeed(islandId: string, speed: number): void {
  void load().then((all) => {
    all[islandId] = { speed, takes: 0, kept: 0, total: 0, manual: true };
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
  const floor = getSettingsSync().defaultSpeed;
  const current = live(all[islandId], floor) ?? { speed: start, takes: 0, kept: 0, total: 0 };
  const { rung, moved } = stepRung(current, take, floor);
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
