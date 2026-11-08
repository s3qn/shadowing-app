// Api domain: islands.
import { Directory, File, Paths } from 'expo-file-system';

import { BASE, TOKEN, expoFetch, fetch } from '@/lib/api-http';
import { headers, json, userParam } from '@/lib/api-core';
import type {
  Complexity,
  Island,
  IslandSummary,
  Language,
  NativeLanguage,
  Register,
  Speaker,
} from '@/lib/api-types';
import { withEnergy } from '@/lib/energy';
import { deviceIdSync } from '@/lib/device';

export async function listIslands(): Promise<IslandSummary[]> {
  return json<IslandSummary[]>(await fetch(`${BASE}/islands`, { headers: headers() }));
}

export async function getIsland(id: string): Promise<Island> {
  return (await getIslandWithText(id)).island;
}

/** The island and the raw body it was parsed from, which the local copy in
 * island-cache.ts stores and compares against. */
export async function getIslandWithText(id: string): Promise<{ island: Island; text: string }> {
  const text = await getIslandText(id);
  const island = JSON.parse(text) as Island;
  return { island, text };
}

/** The island's raw JSON body, unparsed, so a caller holding a local copy
 * can compare the two and skip the parse when nothing changed. Throws like
 * the other calls on a failed response. */
export async function getIslandText(id: string): Promise<string> {
  const res = await fetch(`${BASE}/islands/${id}`, { headers: headers() });
  if (!res.ok) await json<Island>(res); // throws on a failed response
  return res.text();
}

/** Remove an island, its lines and its audio. There is no undo. */
export async function deleteIsland(id: string): Promise<void> {
  await json<unknown>(await fetch(`${BASE}/islands/${id}`, { method: 'DELETE', headers: headers() }));
}

/**
 * Upload a recording and start the pipeline. Returns as soon as the file is
 * accepted; the island builds in the background, so poll getIsland after this.
 */
async function createIslandRaw(
  uri: string,
  complexity: Complexity,
  speaker: number,
  // Register only applies to Japanese: undefined for any other learning
  // language, so the form omits it and the backend falls back to its own
  // default rather than being sent a value nothing on screen offered.
  register: Register | undefined = 'polite',
  count = 8,
  language: Language = 'ja',
  native: NativeLanguage = 'en',
  // A spoken topic: the backend builds a phrase island from corpus sentences.
  topic = false,
): Promise<{ id: string }> {
  const form = new FormData();
  form.append('audio', new File(uri), 'recording.m4a');
  form.append('complexity', complexity);
  if (register) form.append('register', register);
  form.append('speaker', String(speaker));
  form.append('count', String(count));
  form.append('language', language);
  form.append('native', native);
  if (topic) form.append('topic', '1');

  return json<{ id: string }>(
    await expoFetch(`${BASE}/islands`, { method: 'POST', headers: headers(), body: form }),
  );
}

/**
 * Say mode: one sentence spoken in the native language comes back as one
 * voiced line in the learning language (or the phrases or story beats the
 * speaker asked for). Returns as soon as the file is accepted; poll getIsland
 * after this. `devTranscript` replaces whisper on a dev backend only.
 */
async function createSayRaw(
  uri: string,
  speaker: number,
  register: Register | undefined,
  language: Language,
  native: NativeLanguage,
  devTranscript = '',
): Promise<{ id: string }> {
  const form = new FormData();
  form.append('audio', new File(uri), 'recording.m4a');
  form.append('speaker', String(speaker));
  if (register) form.append('register', register);
  form.append('language', language);
  form.append('native', native);
  if (devTranscript) form.append('dev_transcript', devTranscript);

  return json<{ id: string }>(
    await expoFetch(`${BASE}/say`, { method: 'POST', headers: headers(), body: form }),
  );
}

/** Rewrite and re-voice an island at the given complexity from its stored recording. Poll getIsland until ready. */
async function regenerateRaw(id: string, complexity: Complexity): Promise<void> {
  const form = new FormData();
  form.append('complexity', complexity);
  const res = await expoFetch(`${BASE}/islands/${id}/regenerate`, {
    method: 'POST',
    headers: headers(),
    body: form,
  });
  await json<unknown>(res);
}

export async function renameIsland(id: string, title: string): Promise<void> {
  const form = new FormData();
  form.append('title', title);
  const res = await expoFetch(`${BASE}/islands/${id}/title`, {
    method: 'PATCH',
    headers: headers(),
    body: form,
  });
  await json<unknown>(res);
}

export async function listSpeakers(language: Language = 'ja'): Promise<Speaker[]> {
  return json<Speaker[]>(
    await fetch(`${BASE}/speakers?language=${encodeURIComponent(language)}`, { headers: headers() }),
  );
}

/** Re-render an island's lines in another voice. Poll getIsland until ready. */
export async function revoice(id: string, speaker: number): Promise<void> {
  const form = new FormData();
  form.append('speaker', String(speaker));
  const res = await expoFetch(`${BASE}/islands/${id}/revoice`, {
    method: 'POST',
    headers: headers(),
    body: form,
  });
  await json<unknown>(res);
}

/**
 * Download the island as one m4a into the app's cache folder and return the
 * file. Blocking on the server while it renders any missing speed and runs
 * ffmpeg, so the first call at a new speed takes a few seconds.
 */
export async function exportIsland(
  islandId: string,
  speed: number,
  gapMs: number,
  repeats: number,
  fileName: string,
): Promise<File> {
  const dir = new Directory(Paths.cache, 'exports');
  if (!dir.exists) dir.create({ intermediates: true, idempotent: true });
  const url = `${BASE}/islands/${islandId}/export?speed=${speed.toFixed(2)}&repeats=${repeats}&gap=${Math.round(gapMs)}`;
  return File.downloadFileAsync(url, new File(dir, fileName), { headers: headers(), idempotent: true });
}

/**
 * URL of the whole podcast episode as one m4a, built like lineAudioUrl: the
 * token and device ride as query parameters, no access token (pass it
 * through withUser where it leaves the app).
 */
export function episodeAudioUrl(islandId: string): string {
  return `${BASE}/islands/${islandId}/episode?token=${encodeURIComponent(TOKEN)}&device=${encodeURIComponent(deviceIdSync())}`;
}

/**
 * URL for the cleaned version of a take. The token rides as a query
 * parameter for the same reason it does on lineAudioUrl, and `version` (the
 * take's recordedAt) keeps the player from ever loading a stale cached file.
 */
export function cleanTakeUrl(islandId: string, idx: number, version: number): string {
  return `${BASE}/islands/${islandId}/lines/${idx}/take/clean?token=${encodeURIComponent(TOKEN)}&device=${encodeURIComponent(deviceIdSync())}${userParam()}&v=${version}`;
}

/** Spends create energy on the tap and refreshes the meter afterwards. */
export const createIsland = (...args: Parameters<typeof createIslandRaw>): ReturnType<typeof createIslandRaw> => withEnergy('create', () => createIslandRaw(...args));
/** Say is free: no energy spend, only the server's hidden daily cap. */
export const createSay = createSayRaw;

/** Spends regenerate energy on the tap and refreshes the meter afterwards. */
export const regenerate = (...args: Parameters<typeof regenerateRaw>): ReturnType<typeof regenerateRaw> => withEnergy('regenerate', () => regenerateRaw(...args));
