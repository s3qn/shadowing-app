/**
 * The few settings the app keeps on the device, as one JSON file in the app's
 * document directory. Small enough that a storage library would be overkill.
 * Keeps the voice, blind mode, the shadowing lag, the reading display, pitch
 * marks, and the Auto Echo toggles.
 */

import { documentDirectory, getInfoAsync, readAsStringAsync, writeAsStringAsync } from 'expo-file-system/legacy';

export const DEFAULT_VOICE = 3;
const DEFAULT_BLIND = false;
const DEFAULT_HIDE_ENGLISH = false;
const DEFAULT_LAG_MS: LagMs = 0;

export const LAG_OPTIONS = [0, 300, 500, 1000] as const;
export type LagMs = (typeof LAG_OPTIONS)[number];

export const READING_OPTIONS = ['furigana', 'kana', 'romaji'] as const;
export type ReadingMode = (typeof READING_OPTIONS)[number];
const DEFAULT_READING: ReadingMode = 'furigana';
const DEFAULT_PITCH = true;

export type Settings = {
  voice: number;
  blind: boolean;
  hideEnglish: boolean;
  lagMs: LagMs;
  reading: ReadingMode;
  pitch: boolean;
  autoEcho: boolean;
  autoRecord: boolean;
};

const FILE = `${documentDirectory ?? ''}settings.json`;
const DEFAULTS: Settings = {
  voice: DEFAULT_VOICE,
  blind: DEFAULT_BLIND,
  hideEnglish: DEFAULT_HIDE_ENGLISH,
  lagMs: DEFAULT_LAG_MS,
  reading: DEFAULT_READING,
  pitch: DEFAULT_PITCH,
  autoEcho: true,
  autoRecord: true,
};

// Defaults when there is no file yet, or when its JSON is corrupt (nothing in
// it can be recovered then). An I/O error reading an existing file throws, so
// a write never replaces a saved voice with defaults over a passing failure.
async function read(): Promise<Settings> {
  if (!(await getInfoAsync(FILE)).exists) return { ...DEFAULTS };
  const raw = await readAsStringAsync(FILE);
  let parsed: Partial<Settings> | null;
  try {
    parsed = JSON.parse(raw) as Partial<Settings> | null;
  } catch {
    return { ...DEFAULTS };
  }
  if (typeof parsed !== 'object' || parsed === null) return { ...DEFAULTS };
  return {
    voice: typeof parsed.voice === 'number' ? parsed.voice : DEFAULT_VOICE,
    blind: parsed.blind === true,
    hideEnglish: parsed.hideEnglish === true,
    lagMs: LAG_OPTIONS.includes(parsed.lagMs as LagMs) ? (parsed.lagMs as LagMs) : DEFAULT_LAG_MS,
    reading: READING_OPTIONS.includes(parsed.reading as ReadingMode) ? (parsed.reading as ReadingMode) : DEFAULT_READING,
    pitch: parsed.pitch !== false,
    autoEcho: parsed.autoEcho !== false,
    autoRecord: parsed.autoRecord !== false,
  };
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

// Serializes writes so two quick setter calls (Blind then a Lag pill) merge
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
    await write({ ...current, ...patch });
  });
  pending = run.catch(() => {});
  return run;
}

/** Everything remembered on the phone: voice, blind mode, lag, the reading display and pitch marks. */
export async function getSettings(): Promise<Settings> {
  return pending.then(readOrDefaults);
}

/** VOICEVOX style id used for new islands. */
export async function getVoice(): Promise<number> {
  return (await pending.then(readOrDefaults)).voice;
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

export async function setLagMs(lagMs: LagMs): Promise<void> {
  await update({ lagMs });
}

export async function setReading(reading: ReadingMode): Promise<void> {
  await update({ reading });
}

export async function setPitch(pitch: boolean): Promise<void> {
  await update({ pitch });
}

export async function setAutoEcho(autoEcho: boolean): Promise<void> {
  await update({ autoEcho });
}

export async function setAutoRecord(autoRecord: boolean): Promise<void> {
  await update({ autoRecord });
}
