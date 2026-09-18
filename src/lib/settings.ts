/**
 * The few settings the app keeps on the device, as one JSON file in the app's
 * document directory. Small enough that a storage library would be overkill.
 * Keeps the voice, blind mode, the reading display, pitch marks, the player's
 * default repeat count and pause, the speech register for new islands, and the Auto Echo toggles.
 */

import { documentDirectory, getInfoAsync, readAsStringAsync, writeAsStringAsync } from 'expo-file-system/legacy';

import { SPEED_MAX, SPEED_MIN } from '@/constants/theme';
import { getLanguage } from '@/lib/languages';

export const DEFAULT_VOICE = 3;
// languages: VOICEVOX style id for Japanese, Kokoro voice ids for Spanish and
// English. Kept in sync with `backend/voices.py`'s `default_speaker`.
export const DEFAULT_VOICE_BY_LANGUAGE: Record<LearningLanguage, number> = {
  ja: DEFAULT_VOICE,
  en: 10001,
  es: 10011,
};
const DEFAULT_BLIND = false;
const DEFAULT_HIDE_ENGLISH = false;

/** How many times the player plays each line before moving to the next. */
export const TIMES_MIN = 1;
export const TIMES_MAX = 5;
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

// The three languages the backend can generate islands and pick a voice for
// today (kept in sync with `backend/voices.py`'s `default_speaker`). Not the
// full set a learner can choose: see `src/lib/languages.ts` for the catalogue,
// which is the single source of truth for what `learningLanguage` can hold.
export const LEARNING_LANGUAGE_OPTIONS = ['ja', 'es', 'en'] as const;
// A plain string, not a union of `LEARNING_LANGUAGE_OPTIONS`: a "coming soon"
// pick from the catalogue is stored here as-is, so it can hold any catalogue
// id. Use `getLearningLanguageForIslands()` wherever the value has to be one
// the backend can actually generate.
export type LearningLanguage = string;
const DEFAULT_LEARNING_LANGUAGE: LearningLanguage = 'ja';

export const UNDERSTOOD_LANGUAGE_OPTIONS = ['he', 'en'] as const;
// Also widened to the catalogue: any id with `understandable: true`.
export type UnderstoodLanguage = string;
const DEFAULT_UNDERSTOOD_LANGUAGE: UnderstoodLanguage = 'en';

export type Settings = {
  /** Voice remembered per learning language, so switching languages does not
   * lose Japanese's pick. Missing entries fall back to `DEFAULT_VOICE_BY_LANGUAGE`. */
  voices: Partial<Record<LearningLanguage, number>>;
  blind: boolean;
  hideEnglish: boolean;
  reading: ReadingMode;
  pitch: boolean;
  /** Speech register for newly generated islands: です/ます polite, or plain
   * casual form. Remembered so the next recording and Regenerate match. */
  register: Register;
  autoEcho: boolean;
  autoRecord: boolean;
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
  /** Language new islands are generated in. Fills the backend's `language` field. */
  learningLanguage: LearningLanguage;
  /** Language the learner already understands. Fills the backend's `native` field. */
  understoodLanguage: UnderstoodLanguage;
  /** Whether the first-run onboarding flow has been shown. False only for a
   * truly fresh install; an existing settings file from before this key
   * existed is treated as already onboarded. */
  onboarded: boolean;
  /** Home shows every island mixed together with a language pill, instead of
   * only the ones matching `learningLanguage`. Off by default. */
  showAllLanguages: boolean;
};

const FILE = `${documentDirectory ?? ''}settings.json`;
const DEFAULT_SHOW_ALL_LANGUAGES = false;
const DEFAULTS: Settings = {
  voices: {},
  blind: DEFAULT_BLIND,
  hideEnglish: DEFAULT_HIDE_ENGLISH,
  reading: DEFAULT_READING,
  pitch: DEFAULT_PITCH,
  register: DEFAULT_REGISTER,
  autoEcho: true,
  autoRecord: true,
  defaultSpeed: DEFAULT_DEFAULT_SPEED,
  defaultTimes: DEFAULT_DEFAULT_TIMES,
  defaultPauseMs: DEFAULT_DEFAULT_PAUSE,
  hapticsEnabled: DEFAULT_HAPTICS,
  skyAlwaysNight: DEFAULT_SKY_ALWAYS_NIGHT,
  keepAwake: DEFAULT_KEEP_AWAKE,
  homeWaveDate: '',
  learningLanguage: DEFAULT_LEARNING_LANGUAGE,
  understoodLanguage: DEFAULT_UNDERSTOOD_LANGUAGE,
  // Only a missing settings file (a truly fresh install) defaults to false:
  // see the `onboarded: true` overrides below for a file that exists but
  // predates this key.
  onboarded: false,
  showAllLanguages: DEFAULT_SHOW_ALL_LANGUAGES,
};
// A file exists but is corrupt or not an object: it was written by some
// earlier version of the app, so this is not a fresh install. Same defaults
// as a missing file, except onboarded is already true.
const EXISTING_FILE_DEFAULTS: Settings = { ...DEFAULTS, onboarded: true };

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

/** Runs `listener` after every settings write, and after a read that changes
 * the cached values (the first read after launch). Returns an unsubscribe function. */
export function subscribeSettings(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function notifySettingsChanged(): void {
  for (const listener of listeners) listener();
}

// Stores what a read found and tells subscribers when it differs from the
// cache, so a screen that read `getSettingsSync()` before the first read
// finished (Home's language filter at cold start) picks up the saved values.
function fill(next: Settings): Settings {
  const changed = JSON.stringify(next) !== JSON.stringify(cache);
  cache = next;
  if (changed) notifySettingsChanged();
  return next;
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

// Files written before the voice picker split by learning language: the one
// VOICEVOX id becomes `voices.ja`, since VOICEVOX only ever spoke Japanese.
function parseVoices(raw: unknown, legacyVoice: unknown): Partial<Record<LearningLanguage, number>> {
  const voices: Partial<Record<LearningLanguage, number>> = {};
  if (raw && typeof raw === 'object') {
    for (const lang of LEARNING_LANGUAGE_OPTIONS) {
      const v = (raw as Record<string, unknown>)[lang];
      if (typeof v === 'number') voices[lang] = v;
    }
  }
  if (voices.ja === undefined && typeof legacyVoice === 'number') voices.ja = legacyVoice;
  return voices;
}

// Defaults when there is no file yet, or when its JSON is corrupt (nothing in
// it can be recovered then). An I/O error reading an existing file throws, so
// a write never replaces a saved voice with defaults over a passing failure.
async function read(): Promise<Settings> {
  if (!(await getInfoAsync(FILE)).exists) return fill({ ...DEFAULTS });
  const raw = await readAsStringAsync(FILE);
  // `lagMs`, `defaultRepeat` and `voice` are only read to migrate an older file.
  let parsed: (Partial<Settings> & { lagMs?: unknown; defaultRepeat?: unknown; voice?: unknown }) | null;
  try {
    parsed = JSON.parse(raw) as typeof parsed;
  } catch {
    return fill({ ...EXISTING_FILE_DEFAULTS });
  }
  if (typeof parsed !== 'object' || parsed === null) return fill({ ...EXISTING_FILE_DEFAULTS });
  return fill({
    voices: parseVoices(parsed.voices, parsed.voice),
    blind: parsed.blind === true,
    hideEnglish: parsed.hideEnglish === true,
    reading: READING_OPTIONS.includes(parsed.reading as ReadingMode) ? (parsed.reading as ReadingMode) : DEFAULT_READING,
    pitch: parsed.pitch !== false,
    register: REGISTER_OPTIONS.includes(parsed.register as Register) ? (parsed.register as Register) : DEFAULT_REGISTER,
    autoEcho: parsed.autoEcho !== false,
    autoRecord: parsed.autoRecord !== false,
    defaultSpeed:
      typeof parsed.defaultSpeed === 'number' && parsed.defaultSpeed >= SPEED_MIN && parsed.defaultSpeed <= SPEED_MAX
        ? parsed.defaultSpeed
        : DEFAULT_DEFAULT_SPEED,
    defaultTimes: isTimes(parsed.defaultTimes)
      ? parsed.defaultTimes
      : typeof parsed.defaultTimes === 'number' && parsed.defaultTimes > TIMES_MAX
        ? TIMES_MAX
        : migrateTimes(parsed.defaultRepeat),
    defaultPauseMs: isPause(parsed.defaultPauseMs) ? parsed.defaultPauseMs : migratePause(parsed.lagMs),
    hapticsEnabled: parsed.hapticsEnabled !== false,
    skyAlwaysNight: parsed.skyAlwaysNight === true,
    keepAwake: parsed.keepAwake !== false,
    homeWaveDate: typeof parsed.homeWaveDate === 'string' ? parsed.homeWaveDate : '',
    // Validated against the catalogue, not the old 3/2-value unions: any
    // language `src/lib/languages.ts` knows about is a valid pick. Islands
    // already stored with `language: 'ja'` need no migration, since 'ja'
    // stays a valid catalogue id forever.
    learningLanguage:
      typeof parsed.learningLanguage === 'string' && getLanguage(parsed.learningLanguage)
        ? parsed.learningLanguage
        : DEFAULT_LEARNING_LANGUAGE,
    understoodLanguage:
      typeof parsed.understoodLanguage === 'string' && getLanguage(parsed.understoodLanguage)?.understandable
        ? parsed.understoodLanguage
        : DEFAULT_UNDERSTOOD_LANGUAGE,
    // A file from before this key existed has no `onboarded` field at all:
    // that is Sean's phone and every install so far, so it counts as already
    // onboarded. Only a missing file (handled above) defaults to false.
    onboarded: typeof parsed.onboarded === 'boolean' ? parsed.onboarded : true,
    showAllLanguages: parsed.showAllLanguages === true,
  });
}

// For display: a broken file shows the defaults instead of failing the screen.
// A read that throws means the file is there, so this is not a fresh install:
// onboarded stays true rather than sending the learner back to onboarding.
async function readOrDefaults(): Promise<Settings> {
  try {
    return await read();
  } catch {
    return { ...EXISTING_FILE_DEFAULTS };
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
    // read() above already refreshed the cache from disk (notifying only if
    // disk differed from it), but that predates this patch: apply it too, so a sync reader (getSettingsSync, used on
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

/** Voice used for new islands in `language` (the current learning language by
 * default): a VOICEVOX style id for `ja`, a Kokoro voice id for `es`/`en`. A
 * "coming soon" language (see `src/lib/languages.ts`) narrows to `'ja'` here
 * too, the same fallback `getLearningLanguageForIslands` uses, so a learner
 * who picked one still gets a voice list instead of `undefined`. */
export async function getVoice(language?: LearningLanguage): Promise<number> {
  const settings = await pending.then(readOrDefaults);
  const lang = toIslandLanguage(language ?? settings.learningLanguage);
  return settings.voices[lang] ?? DEFAULT_VOICE_BY_LANGUAGE[lang];
}

/** Speech register used for new islands. */
export async function getRegister(): Promise<Register> {
  return (await pending.then(readOrDefaults)).register;
}

/** Remembers `styleId` as the voice for `language` (the current learning
 * language by default), leaving every other language's pick alone. Narrows a
 * "coming soon" language to `'ja'` first, same as `getVoice`, so the pick
 * lands on a language islands are actually built in. */
export async function setVoice(styleId: number, language?: LearningLanguage): Promise<void> {
  const current = await pending.then(readOrDefaults);
  const lang = toIslandLanguage(language ?? current.learningLanguage);
  await update({ voices: { ...current.voices, [lang]: styleId } });
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

export async function setLearningLanguage(learningLanguage: LearningLanguage): Promise<void> {
  await update({ learningLanguage });
}

/** The learning language to actually send a new island's generation request
 * in: the stored pick if the backend can generate it, `'ja'` otherwise. A
 * "coming soon" pick (see `src/lib/languages.ts`) stays in `learningLanguage`
 * as-is, so it still counts as demand, but `backend/main.py` only accepts
 * `ja`/`es`/`en` for `language` (see its check near line 481). */
export async function getLearningLanguageForIslands(): Promise<'ja' | 'es' | 'en'> {
  const { learningLanguage } = await pending.then(readOrDefaults);
  return toIslandLanguage(learningLanguage);
}

/** The synchronous half of `getLearningLanguageForIslands`, for a caller that
 * already has a `LearningLanguage` value in hand (from a hook's state, or a
 * `Settings` object already read) instead of needing to read settings itself.
 * Also narrows the type back to what the backend's request functions expect,
 * since a widened catalogue id otherwise only typechecks as `string`. */
export function toIslandLanguage(id: LearningLanguage): 'ja' | 'es' | 'en' {
  return (LEARNING_LANGUAGE_OPTIONS as readonly string[]).includes(id) ? (id as 'ja' | 'es' | 'en') : 'ja';
}

/** Same idea as `toIslandLanguage`, for the language the learner understands.
 * Every catalogue entry marked `understandable: true` is already `he` or
 * `en` (see `read()`'s validation), so this only matters if that ever
 * changes without every backend call site widening in step. */
export function toNativeLanguage(id: UnderstoodLanguage): 'he' | 'en' {
  return (UNDERSTOOD_LANGUAGE_OPTIONS as readonly string[]).includes(id) ? (id as 'he' | 'en') : 'en';
}

export async function setUnderstoodLanguage(understoodLanguage: UnderstoodLanguage): Promise<void> {
  await update({ understoodLanguage });
}

export async function setOnboarded(onboarded: boolean): Promise<void> {
  await update({ onboarded });
}

export async function setShowAllLanguages(showAllLanguages: boolean): Promise<void> {
  await update({ showAllLanguages });
}
