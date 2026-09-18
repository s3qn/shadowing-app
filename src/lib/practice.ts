/**
 * The practice log the app keeps on the device, as one JSON file next to
 * settings.json in the app's document directory. Tracks seconds shadowed per
 * calendar day (for the streak) and per island (for "least practiced" sort
 * and the minutes shown on a card). Nothing here talks to `backend/`.
 */

import {
  deleteAsync,
  documentDirectory,
  getInfoAsync,
  moveAsync,
  readAsStringAsync,
  writeAsStringAsync,
} from 'expo-file-system/legacy';

import { postPracticeEvent } from './api';

export type PracticeLog = {
  days: Record<string, number>; // 'YYYY-MM-DD' -> seconds
  islands: Record<string, { seconds: number; lastAt: number }>; // islandId -> total seconds, Date.now() of last count
  passes: Record<string, number>; // 'YYYY-MM-DD' -> count of full plays + takes
  ladders: Record<string, number>; // 'YYYY-MM-DD' -> count of finished five-pass ladders
};

// A day with no `passes` entry (every day logged before this counter
// existed) still counts toward the streak by this old rule: at least this
// many seconds of playback. A day that does have a `passes` entry counts by
// STREAK_THRESHOLD_PASSES instead. This keeps a streak built before this
// change intact instead of resetting it to 0.
export const STREAK_THRESHOLD_SECONDS = 60;

// A day with a `passes` entry counts toward the streak once it holds at
// least this many full plays and takes.
export const STREAK_THRESHOLD_PASSES = 10;

// A day counts toward the streak once it holds this many finished five-pass
// ladders, regardless of the passes count: the onboarding's "a day counts
// once you finish one full sentence ladder".
export const STREAK_THRESHOLD_LADDERS = 1;

// A stretch of playback under 15s of buffered seconds waits for the next
// natural flush point (a pause); past that it flushes on its own, so a
// line repeating on a locked phone still lands on disk without a timer.
const FLUSH_THRESHOLD_SECONDS = 15;

const FILE = `${documentDirectory ?? ''}practice.json`;
const TMP_FILE = `${FILE}.tmp`;

function emptyLog(): PracticeLog {
  return { days: {}, islands: {}, passes: {}, ladders: {} };
}

// Returns undefined for anything that isn't a parseable PracticeLog shell
// (JSON.parse throwing, or the result not being an object), so the caller can
// tell "no data here" apart from "this file is broken".
function tryParse(raw: string): Partial<PracticeLog> | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return undefined;
  }
  return typeof parsed === 'object' && parsed !== null ? (parsed as Partial<PracticeLog>) : undefined;
}

function normalize(parsed: Partial<PracticeLog>): PracticeLog {
  const days: Record<string, number> = {};
  if (parsed.days && typeof parsed.days === 'object') {
    for (const [key, value] of Object.entries(parsed.days)) {
      if (typeof value === 'number') days[key] = value;
    }
  }
  const islands: Record<string, { seconds: number; lastAt: number }> = {};
  if (parsed.islands && typeof parsed.islands === 'object') {
    for (const [id, entry] of Object.entries(parsed.islands)) {
      if (entry && typeof entry === 'object' && typeof entry.seconds === 'number' && typeof entry.lastAt === 'number') {
        islands[id] = { seconds: entry.seconds, lastAt: entry.lastAt };
      }
    }
  }
  const passes: Record<string, number> = {};
  if (parsed.passes && typeof parsed.passes === 'object') {
    for (const [key, value] of Object.entries(parsed.passes)) {
      if (typeof value === 'number') passes[key] = value;
    }
  }
  const ladders: Record<string, number> = {};
  if (parsed.ladders && typeof parsed.ladders === 'object') {
    for (const [key, value] of Object.entries(parsed.ladders)) {
      if (typeof value === 'number') ladders[key] = value;
    }
  }
  return { days, islands, passes, ladders };
}

// Defaults when there is no file yet, or when it is genuinely empty. A file
// that has content but won't parse falls back to `.tmp` (a write that got
// killed after the temp file landed but before the rename over FILE leaves a
// good copy there) and, failing that, throws instead of returning an empty
// log: flushPractice() skips the write on a throw, so a broken FILE is never
// silently replaced by an empty one plus whatever was in the buffer. An I/O
// error reading an existing file throws for the same reason.
async function read(): Promise<PracticeLog> {
  if (!(await getInfoAsync(FILE)).exists) return emptyLog();
  const raw = await readAsStringAsync(FILE);
  const parsed = tryParse(raw);
  if (parsed !== undefined) return normalize(parsed);
  if (raw.length === 0) return emptyLog();
  if ((await getInfoAsync(TMP_FILE)).exists) {
    const tmpParsed = tryParse(await readAsStringAsync(TMP_FILE));
    if (tmpParsed !== undefined) return normalize(tmpParsed);
  }
  throw new Error('practice.json exists but is not valid JSON');
}

// For display: a broken file shows an empty log instead of failing the screen.
async function readOrDefaults(): Promise<PracticeLog> {
  try {
    return await read();
  } catch {
    return emptyLog();
  }
}

// Writes the full log to a temp file, then renames it over FILE. The rename
// is the only step that touches FILE itself, so a kill mid-write leaves
// either the old FILE (temp write not done yet) or the new one (rename is
// atomic on both platforms' filesystems), never a half-written FILE.
async function write(next: PracticeLog): Promise<void> {
  const json = JSON.stringify(next);
  await writeAsStringAsync(TMP_FILE, json);
  if ((await getInfoAsync(FILE)).exists) await deleteAsync(FILE, { idempotent: true });
  await moveAsync({ from: TMP_FILE, to: FILE });
}

// Serializes writes so two quick flushes merge onto the latest state instead
// of racing and dropping one of them. The chain itself never rejects, so one
// failed write does not block every later one.
let pending: Promise<void> = Promise.resolve();

// Seconds counted since the last flush, keyed by day and by island. Held in
// memory only; flushPractice() is what puts it on disk. Kept at module level
// (not in the hook) so a screen can mount and unmount many players across one
// island session without losing anything between them.
let buffer: {
  days: Record<string, number>;
  islands: Record<string, number>;
  passes: Record<string, number>;
  ladders: Record<string, number>;
} = {
  days: {},
  islands: {},
  passes: {},
  ladders: {},
};
let unflushed = 0;

/** Local calendar date, zero padded ('YYYY-MM-DD'). */
export function dayKey(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/**
 * Adds shadowed seconds to the in-memory buffer for today and for the given
 * island. No disk write; flushPractice() merges it. A missing islandId
 * (island not loaded yet) or a non-positive delta is a no-op. Past
 * FLUSH_THRESHOLD_SECONDS of buffered seconds this triggers its own flush.
 */
export function addPractice(islandId: string, seconds: number): void {
  if (!islandId || seconds <= 0) return;
  const key = dayKey(new Date());
  buffer.days[key] = (buffer.days[key] ?? 0) + seconds;
  buffer.islands[islandId] = (buffer.islands[islandId] ?? 0) + seconds;
  unflushed += seconds;
  if (unflushed >= FLUSH_THRESHOLD_SECONDS) void flushPractice();
}

/**
 * Adds one pass (a full line play or a saved take) to the in-memory buffer
 * for today. No disk write; flushPractice() merges it. A missing islandId is
 * a no-op, the same truthiness gate addPractice() uses; islandId is not
 * stored per-island for passes.
 */
export function addPass(islandId: string): void {
  if (!islandId) return;
  const key = dayKey(new Date());
  buffer.passes[key] = (buffer.passes[key] ?? 0) + 1;
}

/**
 * Adds one finished five-pass ladder to the in-memory buffer for today. No
 * disk write; flushPractice() merges it. A missing islandId is a no-op, the
 * same truthiness gate addPass() uses; islandId is not stored per-island for
 * ladders.
 */
export function addLadder(islandId: string): void {
  if (!islandId) return;
  const key = dayKey(new Date());
  buffer.ladders[key] = (buffer.ladders[key] ?? 0) + 1;
}

/**
 * Merges the buffer into the file (days and islands both += seconds,
 * lastAt = Date.now() for any island touched, passes += count) and clears
 * the buffer. Never rejects, so a caller never needs to catch it.
 */
export function flushPractice(): Promise<void> {
  const toMerge = buffer;
  buffer = { days: {}, islands: {}, passes: {}, ladders: {} };
  unflushed = 0;
  const hasWork =
    Object.keys(toMerge.days).length > 0 ||
    Object.keys(toMerge.islands).length > 0 ||
    Object.keys(toMerge.passes).length > 0 ||
    Object.keys(toMerge.ladders).length > 0;
  const run = pending
    .then(async () => {
      if (!hasWork) return;
      let current: PracticeLog;
      try {
        current = await read();
      } catch {
        // The file is there but reading it failed: skip the write rather
        // than overwrite what it holds with a log missing this chunk.
        return;
      }
      const days = { ...current.days };
      for (const [key, seconds] of Object.entries(toMerge.days)) {
        days[key] = (days[key] ?? 0) + seconds;
      }
      const islands = { ...current.islands };
      const now = Date.now();
      for (const [id, seconds] of Object.entries(toMerge.islands)) {
        islands[id] = { seconds: (islands[id]?.seconds ?? 0) + seconds, lastAt: now };
      }
      const passes = { ...current.passes };
      for (const [key, count] of Object.entries(toMerge.passes)) {
        passes[key] = (passes[key] ?? 0) + count;
      }
      const ladders = { ...current.ladders };
      for (const [key, count] of Object.entries(toMerge.ladders)) {
        ladders[key] = (ladders[key] ?? 0) + count;
      }
      await write({ days, islands, passes, ladders });
      for (const [id, seconds] of Object.entries(toMerge.islands)) {
        void postPracticeEvent(id, seconds).catch(() => {});
      }
    })
    .catch(() => {});
  pending = run;
  return run;
}

/**
 * Flushes the buffer, then reads, so the caller never sees a stale buffer.
 * The read rides the same `pending` chain flushPractice() writes through
 * (rather than reading FILE directly right after), so it can't land between
 * this flush finishing and some other queued write still landing on disk.
 */
export async function getPracticeLog(): Promise<PracticeLog> {
  await flushPractice();
  return pending.then(readOrDefaults);
}

/** Drops an island's per-island total. Day totals it produced stay: the minutes were real. */
export function forgetIsland(islandId: string): Promise<void> {
  const run = pending
    .then(async () => {
      let current: PracticeLog;
      try {
        current = await read();
      } catch {
        return;
      }
      if (!(islandId in current.islands)) return;
      const islands = { ...current.islands };
      delete islands[islandId];
      await write({ ...current, islands });
    })
    .catch(() => {});
  pending = run;
  return run;
}

/** Rounded minutes for a day key ('YYYY-MM-DD') or an island id, whichever the log holds under that key. */
export function minutesOn(log: PracticeLog, key: string): number {
  const seconds = log.days[key] ?? log.islands[key]?.seconds ?? 0;
  return Math.round(seconds / 60);
}

// A day qualifies once it holds STREAK_THRESHOLD_PASSES passes or at least
// one finished ladder (STREAK_THRESHOLD_LADDERS), whichever comes first: a
// single five-pass ladder is a full session even if it falls short of the
// passes threshold. A day with neither a `passes` nor a `ladders` entry
// (every day logged before either counter existed) falls back to the old
// seconds rule, so a streak built before this change stays intact instead of
// resetting to 0.
function dayQualifies(log: PracticeLog, key: string): boolean {
  if (key in log.passes || key in log.ladders) {
    return (log.passes[key] ?? 0) >= STREAK_THRESHOLD_PASSES || (log.ladders[key] ?? 0) >= STREAK_THRESHOLD_LADDERS;
  }
  return (log.days[key] ?? 0) >= STREAK_THRESHOLD_SECONDS;
}

/**
 * Run of qualifying days (see dayQualifies()) ending today, or ending
 * yesterday if today has not reached the threshold yet (today still in
 * progress does not break it).
 */
export function streakDays(log: PracticeLog, today: Date): number {
  const cursor = new Date(today);
  if (!dayQualifies(log, dayKey(cursor))) {
    cursor.setDate(cursor.getDate() - 1);
  }
  let streak = 0;
  while (dayQualifies(log, dayKey(cursor))) {
    streak += 1;
    cursor.setDate(cursor.getDate() - 1);
  }
  return streak;
}

/** The 7 day keys ending on today, oldest to newest. */
export function lastSevenDays(today: Date): string[] {
  const keys: string[] = [];
  for (let i = 6; i >= 0; i--) {
    const d = new Date(today);
    d.setDate(d.getDate() - i);
    keys.push(dayKey(d));
  }
  return keys;
}
