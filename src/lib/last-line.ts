/**
 * Where a long island's player was left, so reopening it resumes there
 * instead of restarting a 47-minute episode at line 1 every time. One JSON
 * file in the app's document directory, shaped `{ [islandId]: idx }`, same
 * file pattern and error handling as settings.ts.
 */

import { documentDirectory, getInfoAsync, readAsStringAsync, writeAsStringAsync } from 'expo-file-system/legacy';

const FILE = `${documentDirectory ?? ''}last-line.json`;

let cache: Record<string, number> | null = null;
let loading: Promise<Record<string, number>> | null = null;

async function load(): Promise<Record<string, number>> {
  if (cache) return cache;
  if (!loading) {
    loading = (async () => {
      try {
        if (!(await getInfoAsync(FILE)).exists) return (cache = {});
        const raw = await readAsStringAsync(FILE);
        const parsed = JSON.parse(raw) as unknown;
        if (typeof parsed !== 'object' || parsed === null) return (cache = {});
        const next: Record<string, number> = {};
        for (const [id, v] of Object.entries(parsed as Record<string, unknown>)) {
          if (typeof v === 'number' && Number.isInteger(v) && v >= 0) next[id] = v;
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

/** The line index islandId was last on, or 0 if it has never been saved. */
export async function getLastLine(islandId: string): Promise<number> {
  const all = await load();
  return all[islandId] ?? 0;
}

/** The saved line if the file has already been read, else undefined. Call
 * `getLastLine` earlier (on a press-in, say) to have it read by then. */
export function peekLastLine(islandId: string): number | undefined {
  return cache?.[islandId];
}

/** Remembers idx as the line islandId was last on. Debounced 1s so stepping through lines doesn't write on every step. */
export function setLastLine(islandId: string, idx: number): void {
  void load().then((all) => {
    all[islandId] = idx;
    cache = all;
    scheduleWrite();
  });
}

/** Forgets a deleted island's saved line. */
export function forgetLastLine(islandId: string): void {
  void load().then((all) => {
    if (!(islandId in all)) return;
    delete all[islandId];
    cache = all;
    scheduleWrite();
  });
}
