/**
 * Where an island's player was left, so reopening it resumes there
 * instead of restarting at line 1 every time. Serves every island, the
 * podcast and the video player, which share the island id. One JSON
 * file in the app's document directory, shaped `{ [islandId]: idx }`, same
 * file pattern and error handling as settings.ts.
 */

import { persistedMap } from '@/lib/persisted-map';

const store = persistedMap<number>('last-line.json', (v) =>
  typeof v === 'number' && Number.isInteger(v) && v >= 0 ? v : undefined,
);

/** The line index islandId was last on, or 0 if it has never been saved. */
export async function getLastLine(islandId: string): Promise<number> {
  const all = await store.load();
  return all[islandId] ?? 0;
}

/** The saved line (0 if never saved) once the file has been read, else
 * undefined. Call `getLastLine` earlier (on a press-in, say) to have it read
 * by then. */
export function peekLastLine(islandId: string): number | undefined {
  const cache = store.peek();
  return cache ? (cache[islandId] ?? 0) : undefined;
}

/** The line to open on. 0 when nothing is saved or there is one line. The
 * last line reads as finished, so it also opens at the top. */
export function resumeLine(saved: number | undefined, lineCount: number): number {
  if (saved === undefined || lineCount <= 1) return 0;
  return saved >= lineCount - 1 ? 0 : Math.max(0, saved);
}

/** Remembers idx as the line islandId was last on. Debounced 1s so stepping through lines doesn't write on every step. */
export function setLastLine(islandId: string, idx: number): void {
  void store.load().then((all) => {
    all[islandId] = idx;
    store.save(all);
  });
}

/** Forgets a deleted island's saved line. */
export function forgetLastLine(islandId: string): void {
  void store.load().then((all) => {
    if (!(islandId in all)) return;
    delete all[islandId];
    store.save(all);
  });
}
