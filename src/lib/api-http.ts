/**
 * The transport under `src/lib/api.ts`: the fetch wrappers, the unreachable
 * handling, the base URL and the token. Both values come from EXPO_PUBLIC_ env
 * vars that Expo inlines at bundle time.
 */

import { fetch as expoFetchRaw } from 'expo/fetch';

import { devBlockedResponse } from '@/lib/dev-api-block';
import { t } from '@/lib/i18n';

/** A request that never reached the server (offline, DNS, TLS) rejects with
 * the platform's English "Network request failed", and screens show
 * `e.message`. Say it in the reader's language instead. An abort passes
 * through untouched for the caller that asked for it. */
export function unreachable(e: unknown): never {
  if (e instanceof Error && e.name === 'AbortError') throw e;
  throw new Error(t('api.unreachable'));
}
// --- ai-guardrails --- a simulated block answers here, before any network.
export const fetch: typeof globalThis.fetch = (input, init) => {
  const blocked = __DEV__ ? devBlockedResponse(input, init) : null;
  return blocked ? Promise.resolve(blocked) : globalThis.fetch(input, init).catch(unreachable);
};
export const expoFetch: typeof expoFetchRaw = (input, init) => {
  const blocked = __DEV__ ? devBlockedResponse(input, init) : null;
  if (blocked) return Promise.resolve(blocked as unknown as Awaited<ReturnType<typeof expoFetchRaw>>);
  return expoFetchRaw(input, init).catch(unreachable);
};

export const BASE = process.env.EXPO_PUBLIC_SHADOW_API_URL ?? '';
export const TOKEN = process.env.EXPO_PUBLIC_SHADOW_TOKEN ?? '';
// Icon paths from the backend are absolute (/shadow/...), so they hang off the
// origin rather than off BASE.
export const ORIGIN = BASE.replace(/\/shadow\/?$/, '');
