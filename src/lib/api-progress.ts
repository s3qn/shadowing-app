// Api domain: progress (progression, cosmetics, energy, username, leaderboards, profile).
import type { ArtSpec, Slot } from '@/constants/cosmetics';
import { BASE, expoFetch, fetch } from '@/lib/api-http';
import { headers, json } from '@/lib/api-core';

// ---- Progression and cosmetics ----

export type Progress = {
  xp: number;
  /** Fast-band XP earned today (UTC day), 0..xp_today_cap. */
  xp_today: number;
  xp_today_cap: number;
  /** XP paid today after the fast band filled (the slow tail). */
  xp_today_slow?: number;
  /** Consecutive practice days (paid `day:` awards). */
  streak_days: number;
  /** Consecutive local days with a paid daily review. */
  review_streak_days: number;
  level: number;
  coins: number;
  xp_into_level: number;
  /** 0 at the top level. */
  xp_to_next: number;
  owned: string[];
  equipped: Record<Slot, string | null>;
  catalog_version: number;
  /** bl58-easy-for-me: lines marked Easy for me across every island. */
  known_lines?: number;
  /** Lifetime listening seconds (immersion lane 1). */
  listened_seconds?: number;
  /** Achievement ids earned, sorted. Gates `achievement` unlocks. */
  earned?: string[];
  /** Streak freezes held (bought, not yet used). Missing on an old server. */
  freezes_held?: number;
  freeze_price?: number;
  freeze_cap?: number;
  /** 'YYYY-MM-DD' days a freeze was used on, ascending. Missing on an old server. */
  frozen_days?: string[];
  /** 'YYYY-MM-DD' each held freeze was bought on, ascending. Missing on an old server. */
  freezes_bought?: string[];
  /** The server's (UTC) day this snapshot settled freezes on. */
  server_day?: string;
  longest_streak?: number;
  /** Highest streak rung ever paid (7, 14, 30, ... 1000), 0 when none. Missing on an old server. */
  streak_rung_best?: number;
};

/** How an item unlocks. The server writes every string in the catalog's `ui` language, so a new source needs no client copy. */
export type ItemUnlock = {
  /** `level`, `hours`, `achievement`, `grant`, or a source this build does not know (treated as locked). */
  source: string;
  /** The level, the hours, or the achievement id. */
  need: number | string;
  /** Band and caption text: `Lv 6`, `50 h`. */
  short: string;
  /** The sheet's first row: `Reach level 6`. */
  text: string;
  /** The profile's Rewards card title: `By level`. */
  group: string;
};

export type CosmeticItem = {
  id: string;
  slot: Slot;
  name: string;
  level_req: number;
  price: number;
  art: ArtSpec;
  /** Granted by the server only (beta hat). Never for sale. */
  grant_only?: boolean;
  /** Listening hours that grant this item. Hours items cannot be bought. */
  hours_req?: number;
  /** Share of cats that own it, 0 to 100. Null under ~200 users. */
  owned_pct?: number | null;
  /** Missing on an old server: the client falls back to `hours_req` and `level_req`. */
  unlock?: ItemUnlock;
};

export type CosmeticsCatalog = {
  version: number;
  slots: Slot[];
  shapes: Record<string, string[]>;
  items: CosmeticItem[];
  /** The user's lifetime listening hours. */
  listened_hours?: number;
};

/** GET /energy: the daily AI meter. `on` false means metering is off and the UI shows nothing. */
export type Energy = {
  on: boolean;
  daily_max: number;
  daily_left: number;
  granted_left: number;
  /** ISO time of the next 00:00 UTC. */
  refill_at: string;
  /** Today's spend, net of refunds; `by_kind` carries units per paid kind and drops zero kinds. */
  spent_today: { units: number; by_kind: Record<string, number> };
  prices: Record<string, number>;
  owner: boolean;
  last_grant: unknown;
  builds_max: number;
  builds_left: number;
};

export async function getEnergy(): Promise<Energy> {
  return json<Energy>(await fetch(`${BASE}/energy`, { headers: headers() }));
}

// --- support-packs ---
/** POST /iap/verify: `granted` is 0 for a transaction already granted (`duplicate`) or a test purchase over
 * the daily allowance (`code: "sandbox_limit"`); `energy` is the meter after it. */
export type IapVerify = { granted: number; duplicate: boolean; energy: Energy; code?: string | null };

/** Sends StoreKit's signed transaction (the JWS); the server checks Apple's signature, grants once and returns the meter. */
export async function verifyIapPurchase(jws: string): Promise<IapVerify> {
  return json<IapVerify>(
    await fetch(`${BASE}/iap/verify`, {
      method: 'POST',
      headers: { ...headers(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ jws }),
    }),
  );
}

export async function getProgress(): Promise<Progress> {
  return json<Progress>(await fetch(`${BASE}/progress`, { headers: headers() }));
}

export async function getCosmeticsCatalog(ui: string): Promise<CosmeticsCatalog> {
  return json<CosmeticsCatalog>(await fetch(`${BASE}/cosmetics/catalog?ui=${ui}`, { headers: headers() }));
}

/** Grants the starter gift (face.blush_pink) and returns the fresh progress. */
export async function finishStarter(): Promise<{ progress: Progress; item: string }> {
  return json<{ progress: Progress; item: string }>(
    await fetch(`${BASE}/starter/finish`, { method: 'POST', headers: headers() }),
  );
}

export async function buyCosmetic(itemId: string): Promise<Progress> {
  const form = new FormData();
  form.append('item_id', itemId);
  return json<Progress>(await expoFetch(`${BASE}/cosmetics/buy`, { method: 'POST', headers: headers(), body: form }));
}

/** Dev only (tts-providers): forces every hosted voice render into one
 * state on the dev backend: `budget_out`, `provider_down`, `hosted_off`, or
 * `""` to clear. 404 in prod. */
export async function devTtsSim(mode: 'budget_out' | 'provider_down' | 'hosted_off' | ''): Promise<void> {
  const form = new FormData();
  form.append('mode', mode);
  await expoFetch(`${BASE}/dev/tts-sim`, { method: 'POST', headers: headers(), body: form });
}

/** Dev only: grants coins to this device and returns the new snapshot. */
export async function devGrantCoins(amount: number, clearFreezes = false): Promise<Progress> {
  return json<Progress>(await expoFetch(`${BASE}/dev/coins`, {
    method: 'POST',
    headers: { ...headers(), 'Content-Type': 'application/json' },
    body: JSON.stringify({ amount, clear_freezes: clearFreezes }),
  }));
}

/**
 * Buys one streak freeze. `purchaseId` is fresh per tap: the server answers a
 * replay of the same id with the current snapshot and no second charge.
 */
export async function buyStreakFreeze(purchaseId: string): Promise<Progress> {
  const form = new FormData();
  form.append('purchase_id', purchaseId);
  return json<Progress>(await expoFetch(`${BASE}/streak/freeze/buy`, { method: 'POST', headers: headers(), body: form }));
}

/** An empty `itemId` (null) unequips the slot. */
export async function equipCosmetic(slot: Slot, itemId: string | null): Promise<Progress> {
  const form = new FormData();
  form.append('slot', slot);
  form.append('item_id', itemId ?? '');
  return json<Progress>(await expoFetch(`${BASE}/cosmetics/equip`, { method: 'POST', headers: headers(), body: form }));
}

// --- username ---

export type UsernameCheck = { valid: boolean; available: boolean; reason: null | 'invalid' | 'taken' };

/** The signed-in account's handle, or null when none is set. Throws when the
 * request fails: a failed fetch is not "no username". */
export async function getUsername(): Promise<string | null> {
  const r = await json<{ username: string | null }>(await expoFetch(`${BASE}/username`, { headers: headers() }));
  return r.username;
}

export async function checkUsername(name: string): Promise<UsernameCheck> {
  return json<UsernameCheck>(await expoFetch(`${BASE}/username/check?name=${encodeURIComponent(name)}`, { headers: headers() }));
}

export async function setUsername(name: string): Promise<string> {
  const form = new FormData();
  form.append('username', name);
  const r = await json<{ username: string }>(await expoFetch(`${BASE}/username`, { method: 'POST', headers: headers(), body: form }));
  return r.username;
}

export type LeaderboardEntry = { username: string; level: number; equipped: Record<Slot, string | null>; streak_days: number };
export type Leaderboard = { entries: LeaderboardEntry[]; me: { rank: number | null; level: number; username: string | null } };

export async function getLeaderboard(): Promise<Leaderboard> {
  return json<Leaderboard>(await expoFetch(`${BASE}/leaderboard`, { headers: headers() }));
}

export type WeeklyEntry = LeaderboardEntry & { minutes: number; lines: number; score: number };
export type WeeklyLeaderboard = {
  /** Monday (UTC), YYYY-MM-DD. */
  week_start: string;
  language: string;
  entries: WeeklyEntry[];
  me: {
    rank: number | null;
    username: string | null;
    level: number;
    minutes: number;
    lines: number;
    score: number;
    /** Percent from the top, null when unranked. */
    top_pct: number | null;
  };
};

export async function getWeeklyLeaderboard(language: string): Promise<WeeklyLeaderboard> {
  return json<WeeklyLeaderboard>(await expoFetch(`${BASE}/leaderboard/weekly?language=${encodeURIComponent(language)}`, { headers: headers() }));
}

export type Achievement = { id: string; secret: boolean; name: string | null; earned_at: string | null };

export type Profile = {
  username: string;
  serial: number;
  member_since: string;
  level: number;
  xp: number;
  rank: number | null;
  equipped: Record<Slot, string | null>;
  streak_days: number;
  longest_streak: number;
  days_active: number;
  best_xp_day: number;
  cap_days: number;
  immersion_seconds: number;
  video_seconds: number;
  podcast_seconds: number;
  shadow_seconds: number;
  islands_started: number;
  islands_mastered: number;
  lines_practiced: number;
  lines_mastered: number;
  average_accuracy: number | null;
  milestones: string[];
  milestones_total: number;
  cosmetics_owned: number;
  cosmetics_total: number;
  /** Missing on a server from before immersion lane 1. */
  by_language?: Record<string, number>;
  hours_next?: { hours: number; item_id: string; seconds_left: number } | null;
  achievements?: Achievement[];
};

export async function getProfile(username: string, ui = 'en'): Promise<Profile> {
  return json<Profile>(await expoFetch(`${BASE}/profile/${encodeURIComponent(username)}?ui=${encodeURIComponent(ui)}`, { headers: headers() }));
}
