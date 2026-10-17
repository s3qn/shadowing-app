/**
 * A `{ [islandId]: value }` JSON file in the document directory with an
 * in-memory cache and a 1s debounced write. Shared by last-line.ts and
 * speed-ladder.ts. `parse` returns the value for one stored entry, or
 * undefined to drop it; `prepare` runs once before parsing and its result is
 * passed to `parse`.
 */

import { documentDirectory, getInfoAsync, readAsStringAsync, writeAsStringAsync } from 'expo-file-system/legacy';

export function persistedMap<T, C = undefined>(
  name: string,
  parse: (value: unknown, ctx: C) => T | undefined,
  prepare?: () => Promise<C>,
) {
  const file = `${documentDirectory ?? ''}${name}`;
  let cache: Record<string, T> | null = null;
  let loading: Promise<Record<string, T>> | null = null;
  let writeTimer: ReturnType<typeof setTimeout> | null = null;

  /** Reads the file once; a missing or bad file reads as empty. */
  function load(): Promise<Record<string, T>> {
    if (cache) return Promise.resolve(cache);
    if (!loading) {
      loading = (async () => {
        const ctx = (await prepare?.()) as C;
        try {
          if (!(await getInfoAsync(file)).exists) return (cache = {});
          const parsed = JSON.parse(await readAsStringAsync(file)) as unknown;
          if (typeof parsed !== 'object' || parsed === null) return (cache = {});
          const next: Record<string, T> = {};
          for (const [id, v] of Object.entries(parsed as Record<string, unknown>)) {
            const item = parse(v, ctx);
            if (item !== undefined) next[id] = item;
          }
          return (cache = next);
        } catch {
          return (cache = {});
        }
      })();
    }
    return loading;
  }

  /** Stores the map and schedules the debounced write. */
  function save(all: Record<string, T>): void {
    cache = all;
    if (writeTimer) return;
    writeTimer = setTimeout(() => {
      writeTimer = null;
      void writeAsStringAsync(file, JSON.stringify(cache ?? {})).catch(() => {});
    }, 1000);
  }

  return { load, save, peek: () => cache };
}
