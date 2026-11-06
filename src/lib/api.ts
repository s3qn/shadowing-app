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

import { BASE, TOKEN, fetch } from '@/lib/api-http';
import { headers, json, userParam } from '@/lib/api-core';
import { importIslandRaw, importYouTubeCaptionsRaw } from '@/lib/api-library';
import type { AudioSpan } from '@/lib/api-types';
import { withEnergy } from '@/lib/energy';
import { deviceIdSync } from '@/lib/device';


// --- bl58-easy-for-me ---
/** One word rendered on its own in the given voice. */
export function wordAudioUrl(text: string, speaker: number): string {
  return `${BASE}/word-audio?text=${encodeURIComponent(text)}&speaker=${speaker}&token=${encodeURIComponent(TOKEN)}&device=${encodeURIComponent(deviceIdSync())}${userParam()}`;
}

/**
 * Audio URL for one line. The token rides as a query parameter because the
 * audio player fetches this itself and cannot attach the auth header. It
 * carries no access token: pass it through withUser where it leaves the app.
 */
export function lineAudioUrl(
  islandId: string,
  idx: number,
  version: number | string = 0,
  speed = 1,
  padMs = 0,
  span: AudioSpan | null = null,
): string {
  // `v` changes with the voice and with every regeneration so a replaced line is never served from cache.
  // `speed` asks the backend for a natively slower or faster render.
  // `padMs`, when positive, is silence the backend appends so the player can loop natively with a breath.
  const s = speed.toFixed(2);
  const pad = padMs > 0 ? `&pad=${Math.round(padMs)}` : '';
  // `start`/`end` ask for only that stretch of the render, cut on the backend, so a phrase loops natively like a line.
  const range = span ? `&start=${Math.round(span.startMs)}&end=${Math.round(span.endMs)}` : '';
  return `${BASE}/islands/${islandId}/lines/${idx}/audio?token=${encodeURIComponent(TOKEN)}&device=${encodeURIComponent(deviceIdSync())}&v=${version}&speed=${s}${pad}${range}`;
}


/** Deletes the signed-in account and its server data. */
export async function deleteAccount(): Promise<void> {
  await json<unknown>(await fetch(`${BASE}/account`, { method: 'DELETE', headers: headers() }));
}

// --- energy meter ---

/** Spends import energy on the tap and refreshes the meter afterwards. */
export const importIsland = (...args: Parameters<typeof importIslandRaw>): ReturnType<typeof importIslandRaw> => withEnergy('import', () => importIslandRaw(...args));

/** Spends import energy on the tap and refreshes the meter afterwards. */
export const importYouTubeCaptions = (...args: Parameters<typeof importYouTubeCaptionsRaw>): ReturnType<typeof importYouTubeCaptionsRaw> => withEnergy('import', () => importYouTubeCaptionsRaw(...args));

// Transitional shim: callers still import from '@/lib/api'. New code imports the
// domain file directly. A later codemod deletes this block.
export * from './api-types';
export { withUser, configured, health } from './api-core';
export * from './api-islands';
export * from './api-podcasts';
export * from './api-words';
export * from './api-takes';
export * from './api-library';
export * from './api-progress';
export * from './api-review';
export * from './api-catch';
