/**
 * The anonymous id that scopes this phone's islands on the backend. Created
 * once on first launch and kept outside settings.json, so a settings reset
 * can never orphan the phone's islands.
 */

import { documentDirectory, getInfoAsync, readAsStringAsync, writeAsStringAsync } from 'expo-file-system/legacy';
import { randomUUID } from 'expo-crypto';

const FILE = `${documentDirectory ?? ''}device-id.txt`;

// Read or created once per app run, then handed out synchronously.
let cache = '';

/** Reads the stored id, or creates and stores one on first launch. Call this
 * once at startup before anything needs `deviceIdSync()`. */
export async function loadDeviceId(): Promise<string> {
  if (cache) return cache;
  if ((await getInfoAsync(FILE)).exists) {
    const raw = await readAsStringAsync(FILE);
    const id = raw.trim();
    if (id) return (cache = id);
  }
  const id = randomUUID();
  await writeAsStringAsync(FILE, id);
  return (cache = id);
}

/** The id loaded by `loadDeviceId()`, or `''` before that resolves. */
export function deviceIdSync(): string {
  return cache;
}
