import { useFocusEffect } from 'expo-router';
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';

import type { ArtSpec, Slot } from '@/constants/cosmetics';
import { SLOTS } from '@/constants/cosmetics';
import { ITEM_IMAGES } from '@/constants/cosmetic-images';
import { getCosmeticsCatalog, getProgress, type CosmeticItem, type Progress } from '@/lib/api';
import { useT } from '@/lib/i18n';
import { pushLevelUp } from '@/lib/level-up-store';

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
  const out: Partial<Record<Slot, ArtSpec | null>> = {};
  for (const slot of SLOTS) {
    const id = progress.equipped[slot];
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
  progressCache = p;
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
