/**
 * The last island JSON the server sent, one file per island id, so the player
 * can show an island at once on open and refresh it from the network behind
 * that. Only ready islands are kept: one still building changes every poll.
 *
 * A regenerate, re-voice, rename or delete drops the island's file (like
 * line-audio-cache.ts drops its audio), and the refresh on every open replaces
 * a file the server has moved past, so a stale copy is shown for one fetch at
 * most. A memory copy of the newest islands sits in front of the files.
 */
import { Directory, File, Paths } from 'expo-file-system';

import * as api from '@/lib/api';
import type { Island } from '@/lib/api';
import { readOfflineIsland, refreshOfflineIsland } from '@/lib/offline-islands'; // offline-islands

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
 * is no usable copy. Shares a read `prewarmIsland` already started and leaves
 * it in place, so a cube preview and the hop after it read the same copy.
 * Never throws. */
export function readCachedIsland(id: string): Promise<CachedIsland | null> {
  const mem = memory.get(id);
  if (mem) return Promise.resolve(mem);
  const warm = prewarmed.get(id);
  if (warm && Date.now() - warm.at < PREWARM_TTL_MS) return warm.read;
  return readFromDisk(id);
}

type CachedIsland = { island: Island; text: string };

// The islands this session has fetched or written, newest last: every server response the player
// keeps and every `prefetchIsland`. Read first and never consumed, so the cube's face, the hop cover
// and the hopped island all draw the same copy, on web (no file cache) and for an island never opened.
const MAX_MEMORY = 8;
/** A copy older than this is fetched again by the next `prefetchIsland`, while still being read. */
const REFETCH_MS = 60 * 1000;
type MemoryCopy = CachedIsland & { at: number };
const memory = new Map<string, MemoryCopy>();
const fetching = new Map<string, Promise<CachedIsland | null>>();

function remember(island: Island, text: string) {
  memory.delete(island.id);
  memory.set(island.id, { island, text, at: Date.now() });
  while (memory.size > MAX_MEMORY) {
    const oldest = memory.keys().next().value;
    if (oldest === undefined) break;
    memory.delete(oldest);
  }
}

/** The island's copy as soon as one is at hand: the memory copy, else the first of the local
 * copy and a network fetch that has one. The fetch lands in memory (and on disk) for every
 * `peekCachedIsland` and `readCachedIsland` after it. Shares a fetch already running; null when
 * neither source has a ready island. Never throws. */
export function prefetchIsland(id: string): Promise<CachedIsland | null> {
  const mem = memory.get(id);
  if (mem && Date.now() - mem.at < REFETCH_MS) return Promise.resolve(mem);
  const running = fetching.get(id);
  if (running) return mem ? Promise.resolve(mem) : running;
  prewarmIsland(id);
  const disk = mem ? Promise.resolve<CachedIsland | null>(mem) : readCachedIsland(id);
  const net: Promise<CachedIsland | null> = api
    .getIslandText(id)
    .then((text) => {
      // Dropped (a regenerate, a delete) while in flight: this copy is already stale.
      if (fetching.get(id) !== whole) return null;
      const island = JSON.parse(text) as Island;
      if (!island || island.id !== id || island.status !== 'ready' || !Array.isArray(island.lines)) return null;
      const cur = memory.get(id);
      if (cur && cur.text === text) cur.at = Date.now();
      else writeCachedIsland(island, text);
      return memory.get(id) ?? null;
    })
    .catch(() => null);
  const whole: Promise<CachedIsland | null> = new Promise((resolve) => {
    let left = 2;
    const take = (c: CachedIsland | null) => {
      left -= 1;
      if (c || left === 0) resolve(c);
    };
    void disk.then(take, () => take(null));
    void net.then(take);
  });
  fetching.set(id, whole);
  void net.then(() => {
    if (fetching.get(id) === whole) fetching.delete(id);
  });
  return mem ? Promise.resolve(mem) : whole;
}

// Reads started ahead of an open (Home's press-in on a card, the cube's
// neighbours), shared with the player's own read so the island is often parsed
// before the player mounts. A read is never consumed: it lives until a newer
// copy is written, the island is dropped, it goes stale, or MAX_PREWARMS newer
// reads push it out.
const PREWARM_TTL_MS = 10 * 60 * 1000;
const MAX_PREWARMS = 6;
type Prewarm = { at: number; read: Promise<CachedIsland | null>; result?: CachedIsland | null };
const prewarmed = new Map<string, Prewarm>();

/** Starts reading the island's local copy now, for a `readCachedIsland` or a
 * `peekCachedIsland` that follows. Never throws. */
export function prewarmIsland(id: string) {
  const warm = prewarmed.get(id);
  if (warm && Date.now() - warm.at < PREWARM_TTL_MS) return;
  const entry: Prewarm = { at: Date.now(), read: readFromDisk(id) };
  void entry.read.then((result) => {
    entry.result = result;
    // A read that found no copy is not kept: the next look tries the disk again.
    if (result === null && prewarmed.get(id) === entry) prewarmed.delete(id);
  });
  prewarmed.delete(id);
  prewarmed.set(id, entry);
  // Map order is insertion order: the oldest reads go first.
  while (prewarmed.size > MAX_PREWARMS) {
    const oldest = prewarmed.keys().next().value;
    if (oldest === undefined) break;
    prewarmed.delete(oldest);
  }
}

/** The island a prewarm has already read and parsed, without waiting, or
 * undefined when that read is missing, stale, still running or found no copy.
 * Leaves the prewarm in place for `readCachedIsland`. */
export function peekCachedIsland(id: string): CachedIsland | undefined {
  const mem = memory.get(id);
  if (mem) return mem;
  const warm = prewarmed.get(id);
  if (!warm || Date.now() - warm.at >= PREWARM_TTL_MS) return undefined;
  return warm.result ?? undefined;
}

async function readFromDisk(id: string): Promise<CachedIsland | null> {
  try {
    const file = fileOf(id);
    if (!file.exists) return readOfflineIsland(id); // offline-islands
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
  remember(island, text);
  refreshOfflineIsland(island, text); // offline-islands
  try {
    fileOf(island.id).write(text);
  } catch {
    // Without a copy the next open waits for the network, as before.
  }
}

/** Drops the island's local copy. Never throws. */
export function invalidateCachedIsland(id: string) {
  prewarmed.delete(id);
  memory.delete(id);
  fetching.delete(id);
  try {
    const file = fileOf(id);
    if (file.exists) file.delete();
  } catch {
    // Already gone.
  }
}
