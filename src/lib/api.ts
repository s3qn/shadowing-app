/**
 * Client for the shadowing backend.
 *
 * The service lives on the dev box behind a cloudflared route and is guarded by
 * a bearer token, so both the base URL and the token come from EXPO_PUBLIC_ env
 * vars that Expo inlines at bundle time. Set them in .env at the project root.
 *
 * Uploads go through expo/fetch with an expo-file-system File. React Native
 * 0.86 dropped the old {uri, name, type} object hack for FormData parts, and
 * throws "Unsupported FormDataPart implementation" if you try it.
 */

import { fetch as expoFetch } from 'expo/fetch';
import { File } from 'expo-file-system';

const BASE = process.env.EXPO_PUBLIC_SHADOW_API_URL ?? '';
const TOKEN = process.env.EXPO_PUBLIC_SHADOW_TOKEN ?? '';

export type Complexity = 'simple' | 'complex';

/** One syllable of the synthesized line, with the timing VOICEVOX reported. */
export type Mora = {
  text: string;
  kana: string;
  start: number;
  end: number;
  phrase: number;
};

export type Line = {
  idx: number;
  ja: string;
  kana: string;
  romaji: string;
  en: string;
  duration: number;
  timeline: Mora[];
};

export type IslandSummary = {
  id: string;
  title: string;
  status: 'pending' | 'working' | 'ready' | 'failed';
  stage: string;
  complexity: Complexity;
  created_at: string;
  line_count: number;
};

export type Island = IslandSummary & {
  error: string;
  speaker: number;
  transcript: string;
  lines: Line[];
};

function headers(): Record<string, string> {
  return { Authorization: `Bearer ${TOKEN}` };
}

async function json<T>(res: Response): Promise<T> {
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`${res.status} ${body.slice(0, 200)}`);
  }
  return (await res.json()) as T;
}

export function configured(): boolean {
  return BASE.length > 0 && TOKEN.length > 0;
}

export async function health(): Promise<boolean> {
  try {
    const res = await fetch(`${BASE}/health`, { headers: headers() });
    return res.ok;
  } catch {
    return false;
  }
}

export async function listIslands(): Promise<IslandSummary[]> {
  return json<IslandSummary[]>(await fetch(`${BASE}/islands`, { headers: headers() }));
}

export async function getIsland(id: string): Promise<Island> {
  return json<Island>(await fetch(`${BASE}/islands/${id}`, { headers: headers() }));
}

export async function deleteIsland(id: string): Promise<void> {
  await fetch(`${BASE}/islands/${id}`, { method: 'DELETE', headers: headers() });
}

/**
 * Upload a recording and start the pipeline. Returns as soon as the file is
 * accepted; the island builds in the background, so poll getIsland after this.
 */
export async function createIsland(
  uri: string,
  complexity: Complexity,
  count = 8,
): Promise<{ id: string }> {
  const form = new FormData();
  form.append('audio', new File(uri), 'recording.m4a');
  form.append('complexity', complexity);
  form.append('count', String(count));

  return json<{ id: string }>(
    await expoFetch(`${BASE}/islands`, { method: 'POST', headers: headers(), body: form }),
  );
}

export async function regenerate(id: string, complexity: Complexity): Promise<void> {
  const form = new FormData();
  form.append('complexity', complexity);
  await expoFetch(`${BASE}/islands/${id}/regenerate`, {
    method: 'POST',
    headers: headers(),
    body: form,
  });
}

/**
 * Audio URL for one line. The token rides as a query parameter because the
 * audio player fetches this itself and cannot attach the auth header.
 */
export function lineAudioUrl(islandId: string, idx: number): string {
  return `${BASE}/islands/${islandId}/lines/${idx}/audio?token=${encodeURIComponent(TOKEN)}`;
}
