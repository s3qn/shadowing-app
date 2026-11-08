import AsyncStorage from '@react-native-async-storage/async-storage';
import { useSyncExternalStore } from 'react';

import { getBeta } from '@/lib/api';
import { type EnabledLanguage, isLanguageCode, LAUNCH_LANGUAGES, setEnabledLanguages } from '@/lib/languages';

/**
 * launch-basics: which hidden features this person may see. The server decides
 * (GET /shadow/beta); the last answer is cached so a hidden tab does not flash
 * at launch. Fail closed: no cache and no network means everything off.
 * beta-gate: `beta` is the one master switch for everything that is not
 * shadowing (content sources, the cat and XP layer, streaks, Drive, My words);
 * youtube, podcast and import follow it. `admin` only opens the Admin screen.
 */
/** lang-core: `languages` is the learning languages this device may pick,
 * with the server's default speaker for each (`enabledLanguages()` and
 * `defaultSpeaker()` in `src/lib/languages.ts` read the same list). */
export type BetaFeatures = {
  beta: boolean;
  youtube: boolean;
  podcast: boolean;
  import: boolean;
  admin: boolean;
  ready: boolean;
  languages: EnabledLanguage[];
};

const KEY = 'beta-features-v1';
const OFF: BetaFeatures = { beta: false, youtube: false, podcast: false, import: false, admin: false, ready: false, languages: [...LAUNCH_LANGUAGES] };

let server: BetaFeatures = OFF;
/** admin-device-bound: the Admin screen's phone-key states a simulate key can show without a request. */
export type AdminDeviceSim = 'pending' | 'revoked' | 'rejected' | 'unsupported';
type Override = {
  features?: boolean;
  admin?: boolean;
  denied?: boolean;
  device?: AdminDeviceSim;
  languages?: EnabledLanguage[];
};

/** Dev review tour only (dev-simulate.ts): forces features, admin, the phone-key state and/or the language list. */
let override: Override = {};
let view: BetaFeatures = OFF;
const listeners = new Set<() => void>();

function recompute(): void {
  let next = server;
  if (__DEV__ && (override.features !== undefined || override.admin !== undefined)) {
    const f = override.features ?? server.beta;
    // beta-off forces everything false, admin included, unless admin-on asks for it.
    const admin = override.admin ?? (override.features === false ? false : server.admin);
    next = { beta: f, youtube: f, podcast: f, import: f, admin, ready: true, languages: server.languages };
  }
  if (__DEV__ && override.languages) next = { ...next, languages: override.languages };
  view = next;
  setEnabledLanguages(view.languages);
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
function fromAnswer(v: Partial<Omit<BetaFeatures, 'languages'>> & { languages?: unknown }): BetaFeatures {
  const on = !!v.beta;
  return { beta: on, youtube: on && !!v.youtube, podcast: on && !!v.podcast, import: on && !!v.import, admin: !!v.admin, ready: true, languages: languagesOf(v.languages) };
}

/** The server's language list, kept to codes the catalogue knows. Missing
 * (an older prod or cache) or empty means the launch three, so a device is
 * never left with nothing to pick. */
function languagesOf(raw: unknown): EnabledLanguage[] {
  const list: EnabledLanguage[] = [];
  if (Array.isArray(raw)) {
    for (const item of raw as { id?: unknown; speaker?: unknown }[]) {
      if (typeof item?.id === 'string' && isLanguageCode(item.id) && typeof item.speaker === 'number') list.push({ id: item.id, speaker: item.speaker });
    }
  }
  return list.length ? list : [...LAUNCH_LANGUAGES];
}

export { defaultSpeaker, enabledLanguages } from '@/lib/languages';

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
export function setBetaOverride(next: Override): void {
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

/** Dev review tour: the admin screen shows one phone-key state without a request. */
export function betaDeviceSim(): AdminDeviceSim | undefined {
  return __DEV__ ? override.device : undefined;
}
