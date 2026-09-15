/**
 * Line audio kept as local files for this app session. On iOS, replace() with
 * a remote URL builds the AVPlayerItem on the main thread and waits on the
 * tunnel, which froze the screen for about 300ms at every line change. A
 * file:// source loads at once.
 *
 * Each entry is keyed by the line audio URL without its token, so a new speed,
 * pause, phrase or voice version is a new file. `tag` (the line's text) is
 * part of the key too: `generation` starts at 0 on every visit, so the URL
 * alone would match a file from before a regenerate.
 *
 * Nothing here ever blocks playback. `localLineAudio` answers from memory, and
 * a line that is not ready yet plays from the network as before.
 */
import { Directory, File, Paths } from 'expo-file-system';

/** Files kept for the session; the oldest used are deleted past this. */
const MAX_FILES = 40;
const MAX_CONCURRENT = 2;
/** A download that failed is not tried again for this long. */
const RETRY_AFTER_MS = 15_000;

type Entry = { file: File; islandId: string; used: number };
type Job = { url: string; tag: string; key: string; islandId: string };

const ready = new Map<string, Entry>();
/** Keys downloading now; queued ones are only in `queue`. */
const inflight = new Set<string>();
const failedAt = new Map<string, number>();
/** Bumped per island on invalidate, so a download started before it is dropped. */
const epochs = new Map<string, number>();
let queue: Job[] = [];
let running = 0;
let useCounter = 0;
let dir: Directory | null = null;

function cacheDir(): Directory {
  if (dir) return dir;
  const d = new Directory(Paths.cache, 'line-audio');
  // Files from an earlier session may predate a regenerate, so each session
  // starts empty.
  try {
    if (d.exists) d.delete();
  } catch {
    // A leftover file only costs space.
  }
  d.create({ intermediates: true, idempotent: true });
  dir = d;
  return d;
}

function keyOf(url: string, tag: string): string {
  return `${url.replace(/([?&])token=[^&]*&?/, '$1')}\n${tag}`;
}

// Two FNV-1a passes with different seeds: 16 hex characters for a file name.
function hash(s: string): string {
  let a = 0x811c9dc5;
  let b = 0x01000193 ^ 0x5bd1e995;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    a = Math.imul(a ^ c, 0x01000193);
    b = Math.imul(b ^ c, 0x01000193 + 0x100);
  }
  return (a >>> 0).toString(16).padStart(8, '0') + (b >>> 0).toString(16).padStart(8, '0');
}

function islandOf(url: string): string {
  return /\/islands\/([^/]+)\//.exec(url)?.[1] ?? '';
}

function remove(key: string) {
  const e = ready.get(key);
  ready.delete(key);
  try {
    if (e?.file.exists) e.file.delete();
  } catch {
    // Already gone.
  }
}

function evict() {
  if (ready.size <= MAX_FILES) return;
  const oldest = [...ready.entries()].sort((x, y) => x[1].used - y[1].used);
  for (const [key] of oldest.slice(0, ready.size - MAX_FILES)) remove(key);
}

/**
 * The local file uri for this exact line audio URL, or null when it is not
 * downloaded yet (play the remote URL then).
 */
export function localLineAudio(url: string, tag: string): string | null {
  const key = keyOf(url, tag);
  const e = ready.get(key);
  if (!e) return null;
  // The OS may clear the cache folder while the app runs.
  if (!e.file.exists) {
    ready.delete(key);
    return null;
  }
  e.used = ++useCounter;
  return e.file.uri;
}

function pump() {
  while (running < MAX_CONCURRENT && queue.length > 0) {
    const job = queue.shift()!;
    inflight.add(job.key);
    running++;
    void download(job).finally(() => {
      running--;
      pump();
    });
  }
}

async function download(job: Job) {
  const epoch = epochs.get(job.islandId) ?? 0;
  const file = new File(cacheDir(), `${hash(job.key)}.wav`);
  try {
    await File.downloadFileAsync(job.url, file, { idempotent: true });
    if ((epochs.get(job.islandId) ?? 0) !== epoch) {
      try {
        file.delete();
      } catch {
        // Already gone.
      }
      return;
    }
    ready.set(job.key, { file, islandId: job.islandId, used: ++useCounter });
    failedAt.delete(job.key);
    evict();
  } catch {
    failedAt.set(job.key, Date.now());
  } finally {
    inflight.delete(job.key);
  }
}

/**
 * Downloads these line audio URLs in the background, in order, two at a time.
 * Each call replaces what is still waiting in the queue, so only the lines
 * around the current one are fetched. Already cached or in flight ones are
 * skipped.
 */
export function prefetchLineAudio(items: { url: string; tag: string }[]) {
  const now = Date.now();
  const jobs: Job[] = [];
  for (const { url, tag } of items) {
    const key = keyOf(url, tag);
    if (inflight.has(key) || jobs.some((j) => j.key === key)) continue;
    const e = ready.get(key);
    if (e) {
      e.used = ++useCounter;
      continue;
    }
    const failed = failedAt.get(key);
    if (failed !== undefined && now - failed < RETRY_AFTER_MS) continue;
    jobs.push({ url, tag, key, islandId: islandOf(url) });
  }
  queue = jobs;
  pump();
}

/**
 * Drops every cached file for an island, after a regenerate, a re-voice or a
 * delete. Downloads already running for it are discarded when they land.
 */
export function invalidateLineAudio(islandId: string) {
  epochs.set(islandId, (epochs.get(islandId) ?? 0) + 1);
  queue = queue.filter((j) => j.islandId !== islandId);
  for (const [key, e] of [...ready.entries()]) {
    if (e.islandId === islandId) remove(key);
  }
}
