/**
 * The few settings the app keeps on the device, as one JSON file in the app's
 * document directory. Small enough that a storage library would be overkill.
 * Keeps the voice, blind mode and the shadowing lag.
 */

import { documentDirectory, getInfoAsync, readAsStringAsync, writeAsStringAsync } from 'expo-file-system/legacy';

export const DEFAULT_VOICE = 3;
const DEFAULT_BLIND = false;
const DEFAULT_LAG_MS: LagMs = 0;

export const LAG_OPTIONS = [0, 300, 500, 1000] as const;
export type LagMs = (typeof LAG_OPTIONS)[number];
export type Settings = { voice: number; blind: boolean; lagMs: LagMs };

const FILE = `${documentDirectory ?? ''}settings.json`;
const DEFAULTS: Settings = { voice: DEFAULT_VOICE, blind: DEFAULT_BLIND, lagMs: DEFAULT_LAG_MS };

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
    lagMs: LAG_OPTIONS.includes(parsed.lagMs as LagMs) ? (parsed.lagMs as LagMs) : DEFAULT_LAG_MS,
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

/** Everything remembered on the phone: voice, blind mode and lag. */
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

export async function setLagMs(lagMs: LagMs): Promise<void> {
  await update({ lagMs });
}
