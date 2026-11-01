import AsyncStorage from '@react-native-async-storage/async-storage';
import { useSyncExternalStore } from 'react';

import { getBeta } from '@/lib/api';

/**
 * launch-basics: which hidden features this person may see. The server decides
 * (GET /shadow/beta); the last answer is cached so a hidden tab does not flash
 * at launch. Fail closed: no cache and no network means everything off.
 * beta-gate: `beta` is the one master switch for everything that is not
 * shadowing (content sources, the cat and XP layer, streaks, Drive, My words);
 * youtube, podcast and import follow it. `admin` only opens the Admin screen.
 */
export type BetaFeatures = { beta: boolean; youtube: boolean; podcast: boolean; import: boolean; admin: boolean; ready: boolean };

const KEY = 'beta-features-v1';
const OFF: BetaFeatures = { beta: false, youtube: false, podcast: false, import: false, admin: false, ready: false };

let server: BetaFeatures = OFF;
/** Dev review tour only (dev-simulate.ts): forces features and/or admin. */
let override: { features?: boolean; admin?: boolean; denied?: boolean } = {};
let view: BetaFeatures = OFF;
const listeners = new Set<() => void>();

function recompute(): void {
  let next = server;
  if (__DEV__ && (override.features !== undefined || override.admin !== undefined)) {
    const f = override.features ?? server.beta;
    // beta-off forces everything false, admin included, unless admin-on asks for it.
    const admin = override.admin ?? (override.features === false ? false : server.admin);
    next = { beta: f, youtube: f, podcast: f, import: f, admin, ready: true };
  }
  view = next;
  listeners.forEach((l) => l());
}

function subscribe(l: () => void): () => void {
  listeners.add(l);
  return () => {
    listeners.delete(l);
  };
}

export function useBetaFeatures(): BetaFeatures {
  return useSyncExternalStore(subscribe, () => view);
}

export function getBetaSync(): BetaFeatures {
  return view;
}

/** One shape for the cache and the server's answer. An older cache without `beta` reads as off (fail closed), and the sources follow it. */
function fromAnswer(v: Partial<BetaFeatures>): BetaFeatures {
  const on = !!v.beta;
  return { beta: on, youtube: on && !!v.youtube, podcast: on && !!v.podcast, import: on && !!v.import, admin: !!v.admin, ready: true };
}

let loaded = false;
/** The last cached answer, so the first frame already knows what to hide. The root layout awaits it before the splash hides. */
export async function loadBetaCache(): Promise<void> {
  if (loaded) return;
  loaded = true;
  try {
    const raw = await AsyncStorage.getItem(KEY);
    if (raw && !server.ready) {
      server = fromAnswer(JSON.parse(raw) as Partial<BetaFeatures>);
      recompute();
    }
  } catch {
    // No cache: stay closed.
  }
}

/** Reads the server's answer. A failed request keeps what is shown now. */
export async function refreshBeta(): Promise<void> {
  await loadBetaCache();
  try {
    server = fromAnswer(await getBeta());
    recompute();
    void AsyncStorage.setItem(KEY, JSON.stringify(server)).catch(() => undefined);
  } catch {
    if (!server.ready) {
      server = { ...OFF, ready: true };
      recompute();
    }
  }
}

/** On sign-out: forget the last person's features, then ask the server again. */
export async function resetBeta(): Promise<void> {
  server = OFF;
  recompute();
  await AsyncStorage.removeItem(KEY).catch(() => undefined);
  await refreshBeta();
}

/** Dev review tour: a no-op outside __DEV__. */
export function setBetaOverride(next: { features?: boolean; admin?: boolean; denied?: boolean }): void {
  if (!__DEV__) return;
  override = next;
  recompute();
}

/** Dev review tour: true while a simulate key forces the features switch, so the Admin screen shows the simulated value. */
export function betaSimulated(): boolean {
  return __DEV__ && override.features !== undefined;
}

/** Dev review tour: the admin screen shows its refusal without a request. */
export function betaDenied(): boolean {
  return __DEV__ && !!override.denied;
}
