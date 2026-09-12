/**
 * Where shadow takes live on disk. A take is the learner's own recording of a
 * line, kept on the phone under document storage: one file per line, newest
 * wins.
 */

import { Directory, File, Paths } from 'expo-file-system';

export type Take = { uri: string; recordedAt: number };

/** Folder for one island's takes: <document>/takes/<islandId>. */
export function takeDir(islandId: string): Directory {
  return new Directory(Paths.document, 'takes', islandId);
}

/** Newest take for a line, or null. Reads the folder; never throws. */
export function findTake(islandId: string, idx: number): Take | null {
  const prefix = `${idx}-`;
  try {
    const dir = takeDir(islandId);
    if (!dir.exists) return null;
    let newest: Take | null = null;
    for (const entry of dir.list()) {
      const name = entry.name;
      if (!name.startsWith(prefix) || !name.endsWith('.m4a')) continue;
      const recordedAt = Number(name.slice(prefix.length, -'.m4a'.length));
      if (!Number.isFinite(recordedAt)) continue;
      if (!newest || recordedAt > newest.recordedAt) {
        newest = { uri: entry.uri, recordedAt };
      }
    }
    return newest;
  } catch {
    return null;
  }
}

/**
 * Move a finished recording into place as `<idx>-<ms>.m4a` and drop older
 * takes of that line.
 */
export async function saveTake(islandId: string, idx: number, fromUri: string): Promise<Take> {
  const dir = takeDir(islandId);
  if (!dir.exists) dir.create({ intermediates: true, idempotent: true });
  const recordedAt = Date.now();
  const name = `${idx}-${recordedAt}.m4a`;
  const dest = new File(dir, name);
  const source = new File(fromUri);
  await source.move(dest);
  const prefix = `${idx}-`;
  for (const entry of dir.list()) {
    if (entry.name === name) continue;
    if (!entry.name.startsWith(prefix) || !entry.name.endsWith('.m4a')) continue;
    try {
      entry.delete();
    } catch {
      // Leftover file, not fatal: the newest take is what matters.
    }
  }
  return { uri: dest.uri, recordedAt };
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
