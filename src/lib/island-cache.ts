/**
 * The last island JSON the server sent, one file per island id, so the player
 * can show an island at once on open and refresh it from the network behind
 * that. Only ready islands are kept: one still building changes every poll.
 *
 * A regenerate, re-voice, rename or delete drops the island's file (like
 * line-audio-cache.ts drops its audio), and the refresh on every open replaces
 * a file the server has moved past, so a stale copy is shown for one fetch at
 * most.
 */
import { Directory, File, Paths } from 'expo-file-system';

import type { Island } from '@/lib/api';

let dir: Directory | null = null;

function cacheDir(): Directory {
  if (dir) return dir;
  const d = new Directory(Paths.cache, 'islands');
  d.create({ intermediates: true, idempotent: true });
  dir = d;
  return d;
}

function fileOf(id: string): File {
  return new File(cacheDir(), `${id.replace(/[^A-Za-z0-9_-]/g, '_')}.json`);
}

/** The cached island and the raw text it was parsed from, or null when there
 * is no usable copy. Takes over a read `prewarmIsland` already started.
 * Never throws. */
export function readCachedIsland(id: string): Promise<CachedIsland | null> {
  const warm = prewarmed.get(id);
  prewarmed.delete(id);
  if (warm && Date.now() - warm.at < PREWARM_TTL_MS) return warm.read;
  return readFromDisk(id);
}

type CachedIsland = { island: Island; text: string };

// Reads started ahead of an open (Home's press-in on a card), handed to the
// player's own read so the island is often parsed before the player mounts.
// A read nobody takes goes stale and is dropped at the next look.
const PREWARM_TTL_MS = 5000;
type Prewarm = { at: number; read: Promise<CachedIsland | null>; result?: CachedIsland | null };
const prewarmed = new Map<string, Prewarm>();

/** Starts reading the island's local copy now, for a `readCachedIsland` that
 * is about to follow. Never throws. */
export function prewarmIsland(id: string) {
  const warm = prewarmed.get(id);
  if (warm && Date.now() - warm.at < PREWARM_TTL_MS) return;
  const entry: Prewarm = { at: Date.now(), read: readFromDisk(id) };
  void entry.read.then((result) => {
    entry.result = result;
  });
  prewarmed.set(id, entry);
}

/** The island a prewarm has already read and parsed, without waiting, or
 * undefined when that read is missing, stale, still running or found no copy.
 * Leaves the prewarm in place for `readCachedIsland`. */
export function peekCachedIsland(id: string): CachedIsland | undefined {
  const warm = prewarmed.get(id);
  if (!warm || Date.now() - warm.at >= PREWARM_TTL_MS) return undefined;
  return warm.result ?? undefined;
}

async function readFromDisk(id: string): Promise<CachedIsland | null> {
  try {
    const file = fileOf(id);
    if (!file.exists) return null;
    const text = await file.text();
    const island = JSON.parse(text) as Island;
    if (!island || island.id !== id || island.status !== 'ready' || !Array.isArray(island.lines)) {
      return null;
    }
    return { island, text };
  } catch {
    return null;
  }
}

/** Keeps this response as the island's local copy. `text` is the raw body the
 * island was parsed from. Never throws. */
export function writeCachedIsland(island: Island, text: string) {
  if (island.status !== 'ready' || !text) return;
  prewarmed.delete(island.id);
  try {
    fileOf(island.id).write(text);
  } catch {
    // Without a copy the next open waits for the network, as before.
  }
}

/** Drops the island's local copy. Never throws. */
export function invalidateCachedIsland(id: string) {
  prewarmed.delete(id);
  try {
    const file = fileOf(id);
    if (file.exists) file.delete();
  } catch {
    // Already gone.
  }
}
