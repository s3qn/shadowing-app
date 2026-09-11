/**
 * The few settings the app keeps on the device, as one JSON file in the app's
 * document directory. Small enough that a storage library would be overkill.
 */

import { documentDirectory, readAsStringAsync, writeAsStringAsync } from 'expo-file-system/legacy';

export const DEFAULT_VOICE = 3;

type Settings = { voice: number };

const FILE = `${documentDirectory ?? ''}settings.json`;

async function read(): Promise<Settings> {
  try {
    const parsed = JSON.parse(await readAsStringAsync(FILE)) as Partial<Settings>;
    return { voice: typeof parsed.voice === 'number' ? parsed.voice : DEFAULT_VOICE };
  } catch {
    return { voice: DEFAULT_VOICE };
  }
}

async function write(next: Settings): Promise<void> {
  await writeAsStringAsync(FILE, JSON.stringify(next));
}

/** VOICEVOX style id used for new islands. */
export async function getVoice(): Promise<number> {
  return (await read()).voice;
}

export async function setVoice(voice: number): Promise<void> {
  await write({ ...(await read()), voice });
}
