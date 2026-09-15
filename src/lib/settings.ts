/**
 * The few settings the app keeps on the device, as one JSON file in the app's
 * document directory. Small enough that a storage library would be overkill.
 * Keeps the voice, blind mode, the reading display, pitch marks, the player's
 * default repeat count and pause, the speech register for new islands, and the Auto Echo toggles
 * (including whether the line plays under the Speak step).
 */

import { documentDirectory, getInfoAsync, readAsStringAsync, writeAsStringAsync } from 'expo-file-system/legacy';

import { SPEED_MAX, SPEED_MIN } from '@/constants/theme';

export const DEFAULT_VOICE = 3;
const DEFAULT_BLIND = false;
const DEFAULT_HIDE_ENGLISH = false;

/** How many times the player plays each line before moving to the next. */
export const TIMES_MIN = 1;
export const TIMES_MAX = 9;
/** Silence after every play, in ms: between the repeats of a line and before
 * the next line. It is also Auto Echo's Echo step (it replaced the old Lag
 * setting). The backend's line audio pad allows up to the same maximum. */
export const PAUSE_STEP_MS = 500;
export const PAUSE_MAX_MS = 10000;
const DEFAULT_DEFAULT_TIMES = 1;
const DEFAULT_DEFAULT_PAUSE = 0;

function isTimes(v: unknown): v is number {
  return typeof v === 'number' && Number.isInteger(v) && v >= TIMES_MIN && v <= TIMES_MAX;
}

function isPause(v: unknown): v is number {
  return typeof v === 'number' && v >= 0 && v <= PAUSE_MAX_MS && v % PAUSE_STEP_MS === 0;
}

export const READING_OPTIONS = ['off', 'furigana', 'kana', 'romaji'] as const;
export type ReadingMode = (typeof READING_OPTIONS)[number];
const DEFAULT_READING: ReadingMode = 'furigana';
const DEFAULT_PITCH = true;

export const REGISTER_OPTIONS = ['polite', 'casual'] as const;
export type Register = (typeof REGISTER_OPTIONS)[number];
export const DEFAULT_REGISTER: Register = 'polite';

const DEFAULT_DEFAULT_SPEED = 1;
const DEFAULT_HAPTICS = true;
const DEFAULT_SKY_ALWAYS_NIGHT = false;
const DEFAULT_KEEP_AWAKE = true;

export type Settings = {
  voice: number;
  blind: boolean;
  hideEnglish: boolean;
  reading: ReadingMode;
  pitch: boolean;
  /** Speech register for newly generated islands: です/ます polite, or plain
   * casual form. Remembered so the next recording and Regenerate match. */
  register: Register;
  autoEcho: boolean;
  autoRecord: boolean;
  /** Auto Echo's Speak step plays the line under the voice. Off by default:
   * without headphones the phone speaker bleeds into the take. */
  playLineWhileSpeaking: boolean;
  /** Playback speed a new island's player opens at, `SPEED_MIN`-`SPEED_MAX`. */
  defaultSpeed: number;
  /** Plays per line a new island's player opens with. */
  defaultTimes: number;
  /** Pause after each play a new island's player opens with. */
  defaultPauseMs: number;
  /** Haptic feedback on presses, across the whole app. */
  hapticsEnabled: boolean;
  /** Sky always shows the night palette instead of following the clock. */
  skyAlwaysNight: boolean;
  /** Keeps the screen from locking while the island player is open. */
  keepAwake: boolean;
  /** Local date (YYYY-MM-DD) Home last ran its opening wave-in animation, so
   * it only plays once per day. */
  homeWaveDate: string;
};

const FILE = `${documentDirectory ?? ''}settings.json`;
const DEFAULTS: Settings = {
  voice: DEFAULT_VOICE,
  blind: DEFAULT_BLIND,
  hideEnglish: DEFAULT_HIDE_ENGLISH,
  reading: DEFAULT_READING,
  pitch: DEFAULT_PITCH,
  register: DEFAULT_REGISTER,
  autoEcho: true,
  autoRecord: true,
  playLineWhileSpeaking: false,
  defaultSpeed: DEFAULT_DEFAULT_SPEED,
  defaultTimes: DEFAULT_DEFAULT_TIMES,
  defaultPauseMs: DEFAULT_DEFAULT_PAUSE,
  hapticsEnabled: DEFAULT_HAPTICS,
  skyAlwaysNight: DEFAULT_SKY_ALWAYS_NIGHT,
  keepAwake: DEFAULT_KEEP_AWAKE,
  homeWaveDate: '',
};

// Last settings read from disk, kept for callers that need a value
// synchronously (a `useState` initializer can't await). Starts at the
// defaults and is refreshed by every `read()`, so it is accurate as soon as
// anything in the app has called `getSettings()` once.
let cache: Settings = { ...DEFAULTS };

// Callers that need to react the moment a setting changes, rather than the
// next time they happen to re-render or re-focus: the sky palette is the
// one so far ("Always night sky" used to only take effect on its next
// 5-minute poll).
const listeners = new Set<() => void>();

/** Runs `listener` once now and again after every settings write. Returns an unsubscribe function. */
export function subscribeSettings(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function notifySettingsChanged(): void {
  for (const listener of listeners) listener();
}

// Files written before Times and Pause replaced the Repeat mode and Lag:
// Repeat Line (loop this line) opens at 2x, anything else at 1x.
function migrateTimes(old: unknown): number {
  return old === 'line' ? 2 : DEFAULT_DEFAULT_TIMES;
}

// The old Lag (0 to 1000 ms) becomes the nearest pause step, ties going up.
function migratePause(oldLag: unknown): number {
  if (typeof oldLag !== 'number' || !Number.isFinite(oldLag)) return DEFAULT_DEFAULT_PAUSE;
  const ms = Math.round(oldLag / PAUSE_STEP_MS) * PAUSE_STEP_MS;
  return Math.min(PAUSE_MAX_MS, Math.max(0, ms));
}

// Defaults when there is no file yet, or when its JSON is corrupt (nothing in
// it can be recovered then). An I/O error reading an existing file throws, so
// a write never replaces a saved voice with defaults over a passing failure.
async function read(): Promise<Settings> {
  if (!(await getInfoAsync(FILE)).exists) return (cache = { ...DEFAULTS });
  const raw = await readAsStringAsync(FILE);
  // `lagMs` and `defaultRepeat` are only read to migrate an older file.
  let parsed: (Partial<Settings> & { lagMs?: unknown; defaultRepeat?: unknown }) | null;
  try {
    parsed = JSON.parse(raw) as typeof parsed;
  } catch {
    return (cache = { ...DEFAULTS });
  }
  if (typeof parsed !== 'object' || parsed === null) return (cache = { ...DEFAULTS });
  return (cache = {
    voice: typeof parsed.voice === 'number' ? parsed.voice : DEFAULT_VOICE,
    blind: parsed.blind === true,
    hideEnglish: parsed.hideEnglish === true,
    reading: READING_OPTIONS.includes(parsed.reading as ReadingMode) ? (parsed.reading as ReadingMode) : DEFAULT_READING,
    pitch: parsed.pitch !== false,
    register: REGISTER_OPTIONS.includes(parsed.register as Register) ? (parsed.register as Register) : DEFAULT_REGISTER,
    autoEcho: parsed.autoEcho !== false,
    autoRecord: parsed.autoRecord !== false,
    playLineWhileSpeaking: parsed.playLineWhileSpeaking === true,
    defaultSpeed:
      typeof parsed.defaultSpeed === 'number' && parsed.defaultSpeed >= SPEED_MIN && parsed.defaultSpeed <= SPEED_MAX
        ? parsed.defaultSpeed
        : DEFAULT_DEFAULT_SPEED,
    defaultTimes: isTimes(parsed.defaultTimes) ? parsed.defaultTimes : migrateTimes(parsed.defaultRepeat),
    defaultPauseMs: isPause(parsed.defaultPauseMs) ? parsed.defaultPauseMs : migratePause(parsed.lagMs),
    hapticsEnabled: parsed.hapticsEnabled !== false,
    skyAlwaysNight: parsed.skyAlwaysNight === true,
    keepAwake: parsed.keepAwake !== false,
    homeWaveDate: typeof parsed.homeWaveDate === 'string' ? parsed.homeWaveDate : '',
  });
}

// For display: a broken file shows the defaults instead of failing the screen.
async function readOrDefaults(): Promise<Settings> {
  try {
    return await read();
  } catch {
    return { ...DEFAULTS };
  }
}

async function write(next: Settings): Promise<void> {
  await writeAsStringAsync(FILE, JSON.stringify(next));
}

// Serializes writes so two quick setter calls (Blind then a Reading pick) merge
// onto the latest state instead of racing and dropping one of them. The chain
// itself never rejects, so one failed write does not block every later one.
let pending: Promise<void> = Promise.resolve();

function update(patch: Partial<Settings>): Promise<void> {
  const run = pending.then(async () => {
    let current: Settings;
    try {
      current = await read();
    } catch {
      // The file is there but reading it failed: skip the write rather than
      // overwrite what it holds with defaults.
      return;
    }
    const next = { ...current, ...patch };
    await write(next);
    // read() above already refreshed the cache from disk, but that predates
    // this patch: apply it too, so a sync reader (getSettingsSync, used on
    // the haptics hot path) sees the change right after the setter returns
    // instead of waiting for the next getSettings() call.
    cache = next;
    notifySettingsChanged();
  });
  pending = run.catch(() => {});
  return run;
}

/** Everything remembered on the phone: voice, blind mode, the reading display, pitch marks and the player defaults. */
export async function getSettings(): Promise<Settings> {
  return pending.then(readOrDefaults);
}

/**
 * The last settings read from disk, without waiting on the file. For a
 * `useState` initializer, which must run synchronously: it is accurate once
 * anything in the app has called `getSettings()` (or this) at least once,
 * and falls back to the defaults before that.
 */
export function getSettingsSync(): Settings {
  return cache;
}

/** VOICEVOX style id used for new islands. */
export async function getVoice(): Promise<number> {
  return (await pending.then(readOrDefaults)).voice;
}

/** Speech register used for new islands. */
export async function getRegister(): Promise<Register> {
  return (await pending.then(readOrDefaults)).register;
}

export async function setVoice(voice: number): Promise<void> {
  await update({ voice });
}

export async function setBlind(blind: boolean): Promise<void> {
  await update({ blind });
}

export async function setHideEnglish(hideEnglish: boolean): Promise<void> {
  await update({ hideEnglish });
}

export async function setReading(reading: ReadingMode): Promise<void> {
  await update({ reading });
}

export async function setPitch(pitch: boolean): Promise<void> {
  await update({ pitch });
}

export async function setRegister(register: Register): Promise<void> {
  await update({ register });
}

export async function setAutoEcho(autoEcho: boolean): Promise<void> {
  await update({ autoEcho });
}

export async function setAutoRecord(autoRecord: boolean): Promise<void> {
  await update({ autoRecord });
}

export async function setPlayLineWhileSpeaking(playLineWhileSpeaking: boolean): Promise<void> {
  await update({ playLineWhileSpeaking });
}

export async function setDefaultSpeed(defaultSpeed: number): Promise<void> {
  await update({ defaultSpeed });
}

export async function setDefaultTimes(defaultTimes: number): Promise<void> {
  await update({ defaultTimes });
}

export async function setDefaultPauseMs(defaultPauseMs: number): Promise<void> {
  await update({ defaultPauseMs });
}

export async function setHaptics(hapticsEnabled: boolean): Promise<void> {
  await update({ hapticsEnabled });
}

export async function setSkyAlwaysNight(skyAlwaysNight: boolean): Promise<void> {
  await update({ skyAlwaysNight });
}

export async function setKeepAwake(keepAwake: boolean): Promise<void> {
  await update({ keepAwake });
}

export async function setHomeWaveDate(homeWaveDate: string): Promise<void> {
  await update({ homeWaveDate });
}
