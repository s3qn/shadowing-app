import { useFocusEffect } from 'expo-router';
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';

import type { ArtSpec, Slot } from '@/constants/cosmetics';
import { SLOTS } from '@/constants/cosmetics';
import { ITEM_IMAGES } from '@/constants/cosmetic-images';
import { getCosmeticsCatalog, getProgress, type CosmeticItem, type Progress, type ReviewFinished } from '@/lib/api';
import { useT } from '@/lib/i18n';
import { hasInlineXp, isSessionActive, pushCelebration, pushInlineXp, pushLevelUp, pushXpToast, type Celebration } from '@/lib/level-up-store';

export type { CosmeticItem, Progress };

export type ItemState = 'equipped' | 'owned' | 'buyable' | 'locked' | 'unaffordable';

export function itemState(item: CosmeticItem, progress: Progress): ItemState {
  if (progress.equipped[item.slot] === item.id) return 'equipped';
  if (progress.owned.includes(item.id)) return 'owned';
  if (progress.level < item.level_req) return 'locked';
  if (progress.coins < item.price) return 'unaffordable';
  return 'buyable';
}

/** An item's art, plus its Rive image when one is registered in ITEM_IMAGES. */
export function itemArt(item: CosmeticItem): ArtSpec {
  const image = ITEM_IMAGES[item.id];
  return image === undefined ? item.art : { ...item.art, image };
}

/** The CatAvatar `equipped` map for a progress and catalog. */
export function equippedArt(progress: Progress, catalog: CosmeticItem[]): Partial<Record<Slot, ArtSpec | null>> {
  return equippedArtFromIds(progress.equipped, catalog);
}

/** The CatAvatar `equipped` map for slot ids (a leaderboard or profile row) and a catalog. */
export function equippedArtFromIds(equipped: Partial<Record<Slot, string | null>>, catalog: CosmeticItem[]): Partial<Record<Slot, ArtSpec | null>> {
  const out: Partial<Record<Slot, ArtSpec | null>> = {};
  for (const slot of SLOTS) {
    const id = equipped[slot];
    const item = id ? catalog.find((i) => i.id === id) : undefined;
    out[slot] = item ? itemArt(item) : null;
  }
  return out;
}

// Memory cache shared by the wardrobe and Home's badge, so an equip shows on
// Home on the way back without a refetch.
let progressCache: Progress | null = null;
let catalogCache: { ui: string; items: CosmeticItem[] } | null = null;
let lastLevel: number | null = null;
// The progress before a session's first toasted award, so its summary's bar
// still starts where the session did.
let sessionBase: Progress | null = null;
const listeners = new Set<() => void>();

// Level milestones pay coins (see progression.py MILESTONES), every other
// level pays none. A jump over several levels sums the milestones crossed.
const LEVEL_COINS: Record<number, number> = { 5: 30, 10: 60, 20: 100 };

/** Stores a fresh response and queues a level-up if the level rose. */
function setProgress(p: Progress) {
  if (lastLevel !== null && p.level > lastLevel) {
    let coins = 0;
    for (let l = lastLevel + 1; l <= p.level; l++) coins += LEVEL_COINS[l] ?? 0;
    pushLevelUp({ level: p.level, prevLevel: lastLevel, coins });
  }
  if (lastLevel === null || p.level > lastLevel) lastLevel = p.level;
  if (progressCache && p.xp > progressCache.xp) pushXpToast(p.xp - progressCache.xp);
  progressCache = p;
}

/**
 * An award the backend paid with a take or a practice event: pops "+N XP"
 * at once (on the ladder's stage view when one is up, else as the toast),
 * then refetches the progress. The cache takes the XP first, so the refetch
 * (or a later screen focus) does not pop the same XP again. A take the daily
 * cap paid nothing for pops the cap note instead, once a day (`cap_note`).
 */
export function noteAward(award: { xp?: number; cap_note?: boolean } | null | undefined) {
  const xp = award?.xp;
  if (typeof xp !== 'number' || !Number.isFinite(xp) || xp < 0) return;
  if (xp === 0) {
    if (award?.cap_note === true) {
      if (hasInlineXp()) pushInlineXp(0, true);
      else pushXpToast(0, true);
    }
    return;
  }
  if (!isSessionActive()) sessionBase = null;
  else if (!sessionBase) sessionBase = progressCache;
  if (hasInlineXp()) pushInlineXp(xp);
  else pushXpToast(xp);
  if (progressCache) progressCache = { ...progressCache, xp: progressCache.xp + xp };
  getProgress()
    .then((p) => {
      setProgress(p);
      emit();
    })
    .catch(() => {});
}

function emit() {
  listeners.forEach((l) => l());
}
function subscribe(l: () => void) {
  listeners.add(l);
  return () => {
    listeners.delete(l);
  };
}

/** The cached progress right now, read outside React. */
export function progressNow(): Progress | null {
  return progressCache;
}

/** Shows the session summary and XP moment for a finished review, then stores its progress. */
export function celebrateReview(res: ReviewFinished, sentences: number, avgScore: number | null, recap: Celebration['recap']) {
  const p = res.progress;
  const prev = sessionBase ?? progressCache;
  sessionBase = null;
  // Without a cached progress the bar starts where the XP alone would put it.
  const before = prev
    ? { level: prev.level, into: prev.xp_into_level, toNext: prev.xp_to_next }
    : { level: p.level, into: Math.max(0, p.xp_into_level - res.xp), toNext: p.xp_to_next + Math.min(res.xp, p.xp_into_level) };
  pushCelebration({
    xp: res.xp,
    coins: res.coins,
    streak: res.streak,
    sentences,
    avgScore,
    breakdown: res.breakdown ?? null,
    before,
    after: { level: p.level, into: p.xp_into_level, toNext: p.xp_to_next },
    recap,
  });
  applyProgress(p);
}

/** The session-finished request failed: the summary from local data, no XP frame. */
export function celebrateOffline(sentences: number, avgScore: number | null, recap: NonNullable<Celebration['recap']>) {
  sessionBase = null;
  const at = progressCache
    ? { level: progressCache.level, into: progressCache.xp_into_level, toNext: progressCache.xp_to_next }
    : { level: 1, into: 0, toNext: 0 };
  pushCelebration({ xp: 0, coins: 0, streak: 0, sentences, avgScore, breakdown: null, before: at, after: at, recap, offline: true });
}

/** Replaces the cached progress, e.g. with a buy or equip response. */
export function applyProgress(next: Progress) {
  setProgress(next);
  emit();
}

export type UseProgress = {
  progress: Progress | null;
  catalog: CosmeticItem[] | null;
  error: boolean;
  /** Fetches again; resolves when done. */
  reload: () => Promise<void>;
  apply: (next: Progress) => void;
};

/** The cached progress and catalog without fetching, for code outside a screen. */
export function useProgressCache(): { progress: Progress | null; catalog: CosmeticItem[] | null } {
  const { lang } = useT();
  const progress = useSyncExternalStore(subscribe, () => progressCache);
  const catalog = useSyncExternalStore(subscribe, () => (catalogCache && catalogCache.ui === lang ? catalogCache.items : null));
  return { progress, catalog };
}

/** Cached progress and catalog, refreshed on every focus. */
export function useProgress(): UseProgress {
  const { lang } = useT();
  const progress = useSyncExternalStore(subscribe, () => progressCache);
  const catalog = useSyncExternalStore(subscribe, () => (catalogCache && catalogCache.ui === lang ? catalogCache.items : null));
  const [error, setError] = useState(false);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const reload = useCallback(async () => {
    try {
      const needCatalog = !(catalogCache && catalogCache.ui === lang);
      const [p, c] = await Promise.all([getProgress(), needCatalog ? getCosmeticsCatalog(lang) : Promise.resolve(null)]);
      setProgress(p);
      if (c) catalogCache = { ui: lang, items: c.items };
      emit();
      if (alive.current) setError(false);
    } catch {
      if (alive.current) setError(true);
    }
  }, [lang]);

  useFocusEffect(
    useCallback(() => {
      void reload();
    }, [reload]),
  );

  return { progress, catalog, error, reload, apply: applyProgress };
}
