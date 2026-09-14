/**
 * Where shadow takes live on disk. A take is the learner's own recording of a
 * line, kept on the phone under document storage: one file per line, newest
 * wins. Takes are wav (`<idx>-<ms>.wav`) and may have a cleaned sibling
 * (`<idx>-<ms>.clean.wav`) once the backend has removed the played line from
 * the recording. Older takes recorded before this change are `.m4a`; they
 * still play, just never have a cleaned counterpart.
 */

import { Directory, File, Paths } from 'expo-file-system';

export type Take = { uri: string; recordedAt: number; cleanUri: string | null };

/** Folder for one island's takes: <document>/takes/<islandId>. */
export function takeDir(islandId: string): Directory {
  return new Directory(Paths.document, 'takes', islandId);
}

/** Where a downloaded cleaned take for `<idx>-<recordedAt>.wav` should land. */
export function cleanTakeFile(islandId: string, idx: number, recordedAt: number): File {
  const dir = takeDir(islandId);
  if (!dir.exists) dir.create({ intermediates: true, idempotent: true });
  return new File(dir, `${idx}-${recordedAt}.clean.wav`);
}

/**
 * Newest take for a line, or null. Pairs a take with its cleaned sibling by
 * the `<ms>` stamp in the filename; `cleanUri` is set only when that file is
 * actually present. Reads the folder; never throws.
 */
export function findTake(islandId: string, idx: number): Take | null {
  const prefix = `${idx}-`;
  try {
    const dir = takeDir(islandId);
    if (!dir.exists) return null;
    const bases: { uri: string; recordedAt: number; ms: string }[] = [];
    const cleanByMs = new Map<string, string>();
    for (const entry of dir.list()) {
      const name = entry.name;
      if (!name.startsWith(prefix)) continue;
      const rest = name.slice(prefix.length);
      if (rest.endsWith('.clean.wav')) {
        cleanByMs.set(rest.slice(0, -'.clean.wav'.length), entry.uri);
        continue;
      }
      let ms: string | null = null;
      if (rest.endsWith('.wav')) ms = rest.slice(0, -'.wav'.length);
      else if (rest.endsWith('.m4a')) ms = rest.slice(0, -'.m4a'.length);
      if (ms === null) continue;
      const recordedAt = Number(ms);
      if (!Number.isFinite(recordedAt)) continue;
      bases.push({ uri: entry.uri, recordedAt, ms });
    }
    let newest: { uri: string; recordedAt: number; ms: string } | null = null;
    for (const base of bases) {
      if (!newest || base.recordedAt > newest.recordedAt) newest = base;
    }
    if (!newest) return null;
    return { uri: newest.uri, recordedAt: newest.recordedAt, cleanUri: cleanByMs.get(newest.ms) ?? null };
  } catch {
    return null;
  }
}

/**
 * Move a finished recording into place as `<idx>-<ms>.wav` and drop every
 * other take of that line, wav or m4a, cleaned or raw, so a stale
 * `.clean.wav` can never pair with the new take.
 */
export async function saveTake(islandId: string, idx: number, fromUri: string): Promise<Take> {
  const dir = takeDir(islandId);
  if (!dir.exists) dir.create({ intermediates: true, idempotent: true });
  const recordedAt = Date.now();
  const name = `${idx}-${recordedAt}.wav`;
  const dest = new File(dir, name);
  const source = new File(fromUri);
  await source.move(dest);
  const prefix = `${idx}-`;
  for (const entry of dir.list()) {
    if (entry.name === name) continue;
    if (!entry.name.startsWith(prefix)) continue;
    if (!entry.name.endsWith('.wav') && !entry.name.endsWith('.m4a')) continue;
    try {
      entry.delete();
    } catch {
      // Leftover file, not fatal: the newest take is what matters.
    }
  }
  return { uri: dest.uri, recordedAt, cleanUri: null };
}

/** Remove every take of one line, raw and cleaned. Never throws. */
export function deleteTake(islandId: string, idx: number): void {
  const prefix = `${idx}-`;
  try {
    const dir = takeDir(islandId);
    if (!dir.exists) return;
    for (const entry of dir.list()) {
      if (!entry.name.startsWith(prefix)) continue;
      if (!entry.name.endsWith('.wav') && !entry.name.endsWith('.m4a')) continue;
      try {
        entry.delete();
      } catch {
        // Leftover file, not fatal: findTake is not asked for it again until a new take replaces it.
      }
    }
  } catch {
    // No folder, or it could not be read: nothing to delete.
  }
}

/** Remove every take of an island. Missing folder is fine. */
export function deleteTakes(islandId: string): void {
  try {
    const dir = takeDir(islandId);
    if (dir.exists) dir.delete();
  } catch {
    // Nothing to clean up, or the folder was already gone.
  }
}
