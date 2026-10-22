/**
 * The practice log the app keeps on the device, as one JSON file next to
 * settings.json in the app's document directory. Tracks seconds shadowed per
 * calendar day (for the streak) and per island (for "least practiced" sort
 * and the minutes shown on a card). Each flush also posts the new seconds to
 * the server; seconds a post could not deliver wait in `unsent` and go with
 * the next flush, so offline listening is never dropped.
 */

import { pushStreakMoment, milestoneOf } from '@/lib/level-up-store';
import {
  deleteAsync,
  documentDirectory,
  getInfoAsync,
  moveAsync,
  readAsStringAsync,
  writeAsStringAsync,
} from 'expo-file-system/legacy';
import { AppState } from 'react-native';

import { PracticeRefused, postPracticeEvent } from './api';
import { noteAward } from './progression';

export type PracticeLog = {
  days: Record<string, number>; // 'YYYY-MM-DD' -> seconds
  islands: Record<string, { seconds: number; lastAt: number }>; // islandId -> total seconds, Date.now() of last count
  passes: Record<string, number>; // 'YYYY-MM-DD' -> count of full plays + takes
  ladders: Record<string, number>; // 'YYYY-MM-DD' -> count of finished five-pass ladders
  // islandId -> seconds not yet accepted by the server; read() always fills it.
  unsent?: Record<string, number>;
  // Streak freezes, owned by the server and copied here on every progress
  // snapshot: how many are held, and the 'YYYY-MM-DD' days one was used on.
  freezes: number;
  frozen: string[];
  // When each held freeze was bought, ascending, and the server's day on the
  // snapshot they came from ('' before the first one). A log or a server
  // without them never gets the offline cover in streakDays().
  freezesBought?: string[];
  serverDay?: string;
  // The streak last shown to the person; -1 until seeded. streak-moments
  // judges a broken streak against it.
  seenStreak: number;
};

// The most one practice post may carry (the server refuses more).
const POST_CHUNK_SECONDS = 3600;

// A day with no `passes` entry (every day logged before this counter
// existed) still counts toward the streak by this old rule: at least this
// many seconds of playback. A day that does have a `passes` entry counts by
// STREAK_THRESHOLD_PASSES instead. This keeps a streak built before this
// change intact instead of resetting it to 0.
const STREAK_THRESHOLD_SECONDS = 60;

// A day with a `passes` entry counts toward the streak once it holds at
// least this many full plays and takes.
const STREAK_THRESHOLD_PASSES = 10;

// A day counts toward the streak once it holds this many finished five-pass
// ladders, regardless of the passes count: the onboarding's "a day counts
// once you finish one full sentence ladder".
const STREAK_THRESHOLD_LADDERS = 1;

// A stretch of playback under 15s of buffered seconds waits for the next
// natural flush point (a pause); past that it flushes on its own, so a
// line repeating on a locked phone still lands on disk without a timer.
const FLUSH_THRESHOLD_SECONDS = 15;

const FILE = `${documentDirectory ?? ''}practice.json`;
const TMP_FILE = `${FILE}.tmp`;

function emptyLog(): PracticeLog {
  return { days: {}, islands: {}, passes: {}, ladders: {}, unsent: {}, freezes: 0, frozen: [], seenStreak: -1 };
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
  // A log written before the outbox existed has no `unsent`: nothing waits.
  const unsent: Record<string, number> = {};
  if (parsed.unsent && typeof parsed.unsent === 'object') {
    for (const [id, value] of Object.entries(parsed.unsent)) {
      if (typeof value === 'number' && Number.isFinite(value) && value > 0) unsent[id] = value;
    }
  }
  // A log from before streak freezes has none of these: nothing held, no
  // frozen day, and a streak not yet shown (streak-moments seeds it quietly).
  const freezes =
    typeof parsed.freezes === 'number' && Number.isFinite(parsed.freezes) && parsed.freezes > 0 ? Math.floor(parsed.freezes) : 0;
  const frozen = Array.isArray(parsed.frozen) ? cleanDays(parsed.frozen) : [];
  const seenStreak =
    typeof parsed.seenStreak === 'number' && Number.isInteger(parsed.seenStreak) && parsed.seenStreak >= 0 ? parsed.seenStreak : -1;
  const freezesBought = Array.isArray(parsed.freezesBought) ? cleanBought(parsed.freezesBought) : [];
  const serverDay = typeof parsed.serverDay === 'string' && DAY_KEY.test(parsed.serverDay) ? parsed.serverDay : '';
  return { days, islands, passes, ladders, unsent, freezes, frozen, seenStreak, freezesBought, serverDay };
}

const DAY_KEY = /^\d{4}-\d{2}-\d{2}$/;

/** Unique 'YYYY-MM-DD' strings, ascending; anything else is dropped. */
function cleanDays(raw: unknown[]): string[] {
  const keys = new Set<string>();
  for (const value of raw) if (typeof value === 'string' && DAY_KEY.test(value)) keys.add(value);
  return [...keys].sort();
}

// Like cleanDays but keeps repeats: two freezes bought on one day are two.
function cleanBought(raw: unknown[]): string[] {
  return raw.filter((value): value is string => typeof value === 'string' && DAY_KEY.test(value)).sort();
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
// Seconds per island that were counted while the app was not active, so a late
// send still tags them 'background'. Memory only, like the buffer.
const backgroundSecs: Record<string, number> = {};
// One send pass at a time; a flush during a pass asks for another one after.
let sending = false;
let sendAgain = false;
// Unknown at launch: the file may hold seconds a killed app never sent.
let mayHaveUnsent = true;

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
  if (AppState.currentState !== 'active') backgroundSecs[islandId] = (backgroundSecs[islandId] ?? 0) + seconds;
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
 * Posts every island's `unsent` seconds in chunks of at most
 * POST_CHUNK_SECONDS, then takes what the server accepted out of the file.
 * A network failure keeps the rest for the next flush; a refusal (unknown
 * island, bad seconds) drops that island's seconds. Never rejects.
 */
async function sendUnsent(): Promise<void> {
  if (sending) {
    sendAgain = true;
    return;
  }
  sending = true;
  try {
    do {
      sendAgain = false;
      let snapshot: Record<string, number> = {};
      await (pending = pending.then(async () => {
        try {
          snapshot = { ...(await read()).unsent };
        } catch {
          snapshot = {};
        }
      }).catch(() => {}));
      const done: Record<string, number> = {};
      let offline = false;
      for (const [id, total] of Object.entries(snapshot)) {
        let left = total;
        while (left > 0.0001 && !offline) {
          const bgLeft = backgroundSecs[id] ?? 0;
          const chunk = Math.min(POST_CHUNK_SECONDS, left, bgLeft > 0.0001 ? bgLeft : left);
          const appState = bgLeft > 0.0001 ? 'background' : 'active';
          try {
            const r = await postPracticeEvent(id, chunk, appState);
            noteAward(r.award);
          } catch (e) {
            if (e instanceof PracticeRefused) {
              delete backgroundSecs[id];
              done[id] = total;
              break;
            }
            offline = true;
            break;
          }
          if (bgLeft > 0) backgroundSecs[id] = Math.max(0, bgLeft - chunk);
          left -= chunk;
          done[id] = (done[id] ?? 0) + chunk;
        }
        if (offline) break;
      }
      if (Object.keys(done).length === 0) {
        mayHaveUnsent = Object.keys(snapshot).length > 0;
        continue;
      }
      await (pending = pending.then(async () => {
        let current: PracticeLog;
        try {
          current = await read();
        } catch {
          return;
        }
        const unsent = { ...(current.unsent ?? {}) };
        for (const [id, seconds] of Object.entries(done)) {
          const rest = (unsent[id] ?? 0) - seconds;
          if (rest > 0.0001) unsent[id] = rest;
          else delete unsent[id];
        }
        mayHaveUnsent = Object.keys(unsent).length > 0;
        await write({ ...current, unsent });
      }).catch(() => {}));
    } while (sendAgain);
  } finally {
    sending = false;
  }
}

// Callers that need the log the moment a flush lands on disk rather than on
// the next Home focus: the streak reminder cancels today's notification as
// soon as the 10th pass or the finished ladder counts.
const logListeners = new Set<(log: PracticeLog) => void>();

/** Runs `listener` with the written log after every flushPractice() write. Returns an unsubscribe function. */
export function subscribePracticeLog(listener: (log: PracticeLog) => void): () => void {
  logListeners.add(listener);
  return () => logListeners.delete(listener);
}

function notifyPracticeLog(log: PracticeLog): void {
  for (const listener of logListeners) {
    try {
      listener(log);
    } catch {
      // A listener's failure must not break the write chain.
    }
  }
}

/**
 * Merges the buffer into the file (days and islands both += seconds,
 * lastAt = Date.now() for any island touched, passes += count, and the new
 * island seconds into `unsent`), clears the buffer, then posts `unsent`.
 * Never rejects, so a caller never needs to catch it.
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
      if (!hasWork) {
        if (mayHaveUnsent) void sendUnsent();
        return;
      }
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
      // On disk before any post, so seconds survive a kill mid-send.
      const unsent = { ...(current.unsent ?? {}) };
      for (const [id, seconds] of Object.entries(toMerge.islands)) {
        unsent[id] = (unsent[id] ?? 0) + seconds;
      }
      let next: PracticeLog = { ...current, days, islands, passes, ladders, unsent };
      // The day just crossed into counting: the streak went up. Recorded as
      // seen in the same write, so a kill never replays it.
      const today = new Date();
      const todayKey = dayKey(today);
      let up: number | null = null;
      if (!dayQualifies(current, todayKey) && dayQualifies(next, todayKey)) {
        up = streakDays(next, today);
        next = { ...next, seenStreak: up };
      }
      await write(next);
      if (up !== null) pushStreakMoment({ kind: 'up', streak: up, milestone: milestoneOf(up) });
      notifyPracticeLog(next);
      mayHaveUnsent = true;
      void sendUnsent();
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
      if (!(islandId in current.islands) && !(islandId in (current.unsent ?? {}))) return;
      const islands = { ...current.islands };
      delete islands[islandId];
      // A deleted island's seconds can no longer be posted.
      const unsent = { ...(current.unsent ?? {}) };
      delete unsent[islandId];
      await write({ ...current, islands, unsent });
    })
    .catch(() => {});
  pending = run;
  return run;
}

/**
 * Copies the server's freeze state (held count, days a freeze was used on,
 * when each held one was bought, the server's day) into the log so the
 * streak bridges offline too. Writes only on a change.
 */
export function setStreakSync(held: number, frozen: string[], bought: string[], serverDay: string): Promise<void> {
  const freezes = Number.isFinite(held) && held > 0 ? Math.floor(held) : 0;
  const days = cleanDays(frozen);
  const freezesBought = cleanBought(bought);
  const day = DAY_KEY.test(serverDay) ? serverDay : '';
  return updateLog((current) =>
    current.freezes === freezes &&
    current.frozen.join() === days.join() &&
    (current.freezesBought ?? []).join() === freezesBought.join() &&
    current.serverDay === day
      ? null
      : { ...current, freezes, frozen: days, freezesBought, serverDay: day },
  );
}

// Dev review tour only: an in-memory streak that streakDays() returns first.
// Never stored, never sent, gone on reload.
let devStreak: number | null = null;
export function setDevStreak(n: number | null): void {
  if (__DEV__) devStreak = n;
}

/** True while the dev review tour fakes the streak, so simulations skip storage writes. */
export function devStreakActive(): boolean {
  return __DEV__ && devStreak !== null;
}

/** Records the streak last shown to the person (streak-moments). */
export function setSeenStreak(n: number): Promise<void> {
  if (__DEV__ && devStreak !== null) return Promise.resolve();
  const seenStreak = Number.isInteger(n) && n >= 0 ? n : -1;
  return updateLog((current) => (current.seenStreak === seenStreak ? null : { ...current, seenStreak }));
}

// Read-modify-write on the `pending` chain; `change` returns null for "no
// write". A file that cannot be read is left alone, like forgetIsland().
function updateLog(change: (current: PracticeLog) => PracticeLog | null): Promise<void> {
  const run = pending
    .then(async () => {
      let current: PracticeLog;
      try {
        current = await read();
      } catch {
        return;
      }
      const next = change(current);
      if (next) await write(next);
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
export function dayQualifies(log: PracticeLog, key: string): boolean {
  if (key in log.passes || key in log.ladders) {
    return (log.passes[key] ?? 0) >= STREAK_THRESHOLD_PASSES || (log.ladders[key] ?? 0) >= STREAK_THRESHOLD_LADDERS;
  }
  return (log.days[key] ?? 0) >= STREAK_THRESHOLD_SECONDS;
}

/**
 * Run of qualifying days (see dayQualifies()) ending today, or ending
 * yesterday if today has not reached the threshold yet (today still in
 * progress does not break it). A day in `log.frozen` (a freeze the server
 * used) continues the run without adding to it. Offline, a missed yesterday
 * is bridged the same way by offlineCover(); the next snapshot turns that
 * into a real `frozen` entry, so the number does not change.
 */
export function streakDays(log: PracticeLog, today: Date): number {
  if (__DEV__ && devStreak !== null) return devStreak;
  const frozen = new Set([...log.frozen, ...offlineCover(log, today)]);
  const cursor = new Date(today);
  if (!dayQualifies(log, dayKey(cursor))) cursor.setDate(cursor.getDate() - 1);
  let streak = 0;
  for (;;) {
    const key = dayKey(cursor);
    if (dayQualifies(log, key)) streak += 1;
    else if (!frozen.has(key)) break;
    cursor.setDate(cursor.getDate() - 1);
  }
  return streak;
}

// The days the server will freeze at its next settle, mirroring
// _plan_freezes in backend/progression.py: the gap ending yesterday, when a
// qualifying or frozen day sits before it and each day has its own held
// freeze bought on or before it (all or nothing). Empty once a snapshot from
// after yesterday has answered (the server froze it or saw no need), and
// whenever the bought days are unknown.
function offlineCover(log: PracticeLog, today: Date): string[] {
  const bought = [...(log.freezesBought ?? [])];
  const serverDay = log.serverDay ?? '';
  const frozen = new Set(log.frozen);
  const bridges = (key: string) => dayQualifies(log, key) || frozen.has(key);
  const cursor = new Date(today);
  cursor.setDate(cursor.getDate() - 1);
  if (!bought.length || !serverDay || serverDay > dayKey(cursor)) return [];
  const gap: string[] = [];
  while (gap.length <= bought.length && !bridges(dayKey(cursor))) {
    gap.push(dayKey(cursor));
    cursor.setDate(cursor.getDate() - 1);
  }
  if (!gap.length || gap.length > bought.length) return [];
  for (const day of [...gap].reverse()) {
    const pick = bought.findIndex((on) => on <= day);
    if (pick < 0) return [];
    bought.splice(pick, 1);
  }
  return gap;
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
