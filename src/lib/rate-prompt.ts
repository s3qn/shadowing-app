/**
 * Asks for an App Store rating with the system sheet after a finished island,
 * once per app version. No reward, no wording of our own: Apple draws the
 * sheet and decides whether to show it. `openWriteReview` backs the Settings
 * row. State is one entry in rate-prompt.json: how many islands were
 * finished and the app version we last asked on.
 */

import Constants from 'expo-constants';
import { AppState, Linking, Platform } from 'react-native';

import { persistedMap } from '@/lib/persisted-map';
import { getPracticeLog, streakDays } from '@/lib/practice';

type RateState = { finished: number; askedVersion: string | null };

const KEY = 'rate_prompt';
const ASK_DELAY_MS = 1500;
const IOS_APP_ID = '6822075334';

const store = persistedMap<RateState>('rate-prompt.json', (v) => {
  if (typeof v !== 'object' || v === null) return undefined;
  const { finished, askedVersion } = v as Partial<RateState>;
  return {
    finished: typeof finished === 'number' && finished >= 0 ? finished : 0,
    askedVersion: typeof askedVersion === 'string' ? askedVersion : null,
  };
});

type StoreReviewModule = typeof import('expo-store-review');

function version(): string {
  return Constants.expoConfig?.version ?? '';
}

function log(reason: string, data: Record<string, unknown>): void {
  if (__DEV__) console.log('[rate-prompt]', reason, { ...data, version: version() });
}

/** The native module, or null in Expo Go, on an old binary and on web. */
function loadStoreReview(): StoreReviewModule | null {
  if (Platform.OS === 'web') return null;
  try {
    // Lazy on purpose: a binary built before this library has no native module.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    return require('expo-store-review') as StoreReviewModule;
  } catch {
    return null;
  }
}

async function ask(reason: string, state: RateState, streak: number): Promise<void> {
  const StoreReview = loadStoreReview();
  if (!StoreReview || !(await StoreReview.isAvailableAsync().catch(() => false))) {
    log('unavailable', { reason, ...state, streak, action: 'skipped' });
    return;
  }
  // Saved before the call: once per version even if Apple shows nothing.
  const all = await store.load();
  all[KEY] = { ...state, askedVersion: version() };
  store.save(all);
  log(reason, { ...state, streak, action: 'asked' });
  await StoreReview.requestReview().catch(() => {});
}

async function check(bump: boolean, streakOverride?: number): Promise<void> {
  const all = await store.load();
  const state = all[KEY] ?? { finished: 0, askedVersion: null };
  if (bump) {
    state.finished += 1;
    all[KEY] = state;
    store.save(all);
  }
  const streak = streakOverride ?? streakDays(await getPracticeLog(), new Date());
  const reason = state.finished >= 3 ? 'island3' : streak >= 3 ? 'streak3' : null;
  if (!reason) return log('not-yet', { ...state, streak, action: 'none' });
  if (state.askedVersion === version()) return log('already-asked', { ...state, streak, action: 'skipped' });
  setTimeout(() => {
    if (AppState.currentState !== 'active') return log('inactive', { ...state, streak, action: 'skipped' });
    void ask(reason, state, streak).catch(() => {});
  }, ASK_DELAY_MS);
}

/** Call when a person reaches the end of an island. Fire and forget, never throws. */
export function noteIslandFinished(): void {
  if (Platform.OS === 'web') return;
  void check(true).catch(() => {});
}

/** Opens the store page where a review is written. Errors are ignored. */
export async function openWriteReview(): Promise<void> {
  try {
    if (Platform.OS === 'ios') {
      await Linking.openURL(`itms-apps://apps.apple.com/app/id${IOS_APP_ID}?action=write-review`);
    } else if (Platform.OS === 'android') {
      const url = await loadStoreReview()?.storeUrl();
      await Linking.openURL(url ?? `market://details?id=${Constants.expoConfig?.android?.package ?? ''}`);
    }
  } catch {
    // A missing store app is not worth telling the person about.
  }
}

/** Dev review tour: asks now, ignoring the counter and the saved version. */
export async function devRateAsk(): Promise<void> {
  if (!__DEV__) return;
  const state = (await store.load())[KEY] ?? { finished: 0, askedVersion: null };
  await ask('island3', state, 0);
}

/** Dev review tour: forgets the counter and the saved version. */
export async function devRateReset(): Promise<void> {
  if (!__DEV__) return;
  const all = await store.load();
  delete all[KEY];
  store.save(all);
  log('reset', { action: 'none' });
}

/** Dev review tour: runs the finish check as if the streak were 3, without counting an island. */
export async function devRateStreak3(): Promise<void> {
  if (!__DEV__) return;
  await check(false, 3);
}
