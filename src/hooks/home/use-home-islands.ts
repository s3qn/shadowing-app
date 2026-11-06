import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import * as api from '@/lib/api';
import type { TFn } from '@/lib/i18n';
import { offlineSummaries } from '@/lib/offline-islands';
import type { PracticeLog } from '@/lib/practice';
import { toIslandLanguage } from '@/lib/settings';
import { keptUpTotal, lineTiers, type LineTier } from '@/lib/takes';

type Args = {
  t: TFn;
  /** The practice log Home loaded, the source of truth for "never practiced". */
  log: PracticeLog;
  /** True while Home is on top: the building poll runs only then. */
  focused: boolean;
  showAllLanguages: boolean;
  learningLanguage: Parameters<typeof toIslandLanguage>[0];
  beta: boolean;
};

/** Home's islands: the list and its load, the offline flag, the due ids, the
 * per-focus takes cache and the poll that runs while something is building. */
export function useHomeIslands({ t, log, focused, showAllLanguages, learningLanguage, beta }: Args) {
  const [islands, setIslands] = useState<api.IslandSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  // offline-islands: the last list load failed, so only downloaded islands can open.
  const [listOffline, setListOffline] = useState(false);
  // A list request that started before a delete can still answer with the
  // deleted row, which would put it back on screen. Ids deleted here stay out.
  const removed = useRef<Set<string>>(new Set());
  // The last list the poll put on screen, serialised, to skip an unchanged one.
  const lastListKey = useRef('');

  // Raw due set from the backend schedule: islands practiced before and now
  // due again. `dueIds` below adds islands never practiced at all, which the
  // backend never lists (schedule.py only tracks islands it has seen).
  const [fetchedDueIds, setFetchedDueIds] = useState<Set<string>>(new Set());
  // False until the schedule answers (or fails), so the card shows a dash instead of a 0 that pops to 2.
  const [dueReady, setDueReady] = useState(false);

  // Tier per line and kept-up total for the centred card only, keyed by
  // island id. Both hold for one focus: takes change in the player, never on
  // Home. `takesEpoch` moves on every focus and is what drops the stale
  // entries. It is also the identity that `tiersFor`, `keptUpFor` and
  // `renderIsland` carry, so a card repaints with what this focus read
  // instead of freezing on the last one.
  const takesCache = useRef({
    epoch: -1,
    tiers: new Map<string, LineTier[]>(),
    keptUp: new Map<string, { kept: number; total: number }>(),
  });
  const [takesEpoch, setTakesEpoch] = useState(0);
  const bumpTakesEpoch = useCallback(() => setTakesEpoch((n) => n + 1), []);

  const load = useCallback(async () => {
    try {
      const rows = await api.listIslands();
      const next = rows.filter((i) => !removed.current.has(i.id));
      // A poll that brings nothing new keeps the same array and row objects,
      // so no row re-renders (a poll can land mid-morph).
      const key = JSON.stringify(next);
      if (key !== lastListKey.current) {
        lastListKey.current = key;
        setIslands(next);
      }
      setError('');
      setListOffline(false);
      setLoading(false);
    } catch (e) {
      // offline-islands: with no connection, show what is downloaded.
      setListOffline(true);
      setIslands((prev) => (prev.length ? prev : offlineSummaries()));
      setError(e instanceof Error ? e.message : t('home.serverUnreachable'));
      setLoading(false);
    }
  }, [t]);

  /** Reads the backend schedule. `isAlive` lets a focus that ended drop the answer. */
  const loadDue = useCallback((isAlive: () => boolean) => {
    void api.getDueToday().then((rows) => {
      if (isAlive()) setFetchedDueIds(new Set(rows.map((r) => r.island_id)));
    }).catch(() => {}).finally(() => {
      if (isAlive()) setDueReady(true);
    });
  }, []);

  // Home's visible pool: every island once Show all languages is on,
  // otherwise only the ones matching the learning language. Sorting, search,
  // due counts and the practice card all read from this, not from `islands`.
  // beta-gate: video and podcast islands are beta content; a regular user never sees their rows.
  const visibleIslands = useMemo(
    () =>
      islands.filter(
        (i) => (showAllLanguages || i.language === toIslandLanguage(learningLanguage)) && (beta || (i.source !== 'youtube' && i.source !== 'podcast')),
      ),
    [islands, showAllLanguages, learningLanguage, beta],
  );

  // An island is due if the backend schedule says so, or if it has never
  // been practiced at all: schedule.py only tracks islands it has seen, so a
  // brand new island is never in that list even though it is the most due
  // thing on the island. The practice log Home already loads is the source
  // of truth for "never practiced" (no entry under its id). Limited to the
  // visible pool, so the due count on the practice card matches the list.
  const dueIds = useMemo(() => {
    const ids = new Set<string>();
    for (const island of visibleIslands) {
      // Long media (podcast, YouTube) is not drilled wholesale: it has the review deck.
      if (island.source === 'podcast' || island.source === 'youtube') continue;
      if (fetchedDueIds.has(island.id) || (island.status === 'ready' && !(island.id in log.islands))) {
        ids.add(island.id);
      }
    }
    return ids;
  }, [visibleIslands, log, fetchedDueIds]);

  // Keep polling only while some island is neither ready nor failed, so the
  // row flips to ready on its own and an idle Home makes no requests.
  const anyBuilding = islands.some((i) => i.status !== 'ready' && i.status !== 'failed');
  useEffect(() => {
    if (!focused || !anyBuilding) return;
    const timer = setInterval(() => void load(), 3000);
    return () => clearInterval(timer);
  }, [focused, anyBuilding, load]);

  /** Both caches, emptied the first time either is read in a new epoch.
   * Clearing here rather than in the focus effect keeps the epoch the one
   * thing the two readers below depend on. */
  const freshCache = useCallback(() => {
    const cache = takesCache.current;
    if (cache.epoch !== takesEpoch) {
      cache.epoch = takesEpoch;
      cache.tiers.clear();
      cache.keptUp.clear();
    }
    return cache;
  }, [takesEpoch]);

  /** Tier per line for one island, computed once per focus and cached: only
   * the centred card needs it, and a folder listing is cheap but not free. */
  const tiersFor = useCallback(
    (islandId: string, lineCount: number): LineTier[] => {
      const cache = freshCache();
      const cached = cache.tiers.get(islandId);
      if (cached) return cached;
      const computed = lineTiers(islandId, lineCount);
      cache.tiers.set(islandId, computed);
      return computed;
    },
    [freshCache],
  );

  /** Island kept-up total, same cache and same one-read-per-focus shape as
   * `tiersFor` above. */
  const keptUpFor = useCallback(
    (islandId: string, lineCount: number): { kept: number; total: number } => {
      const cache = freshCache();
      const cached = cache.keptUp.get(islandId);
      if (cached) return cached;
      const computed = keptUpTotal(islandId, lineCount);
      cache.keptUp.set(islandId, computed);
      return computed;
    },
    [freshCache],
  );

  return {
    islands,
    setIslands,
    loading,
    setLoading,
    error,
    listOffline,
    removed,
    load,
    loadDue,
    dueReady,
    dueIds,
    visibleIslands,
    takesEpoch,
    bumpTakesEpoch,
    tiersFor,
    keptUpFor,
  };
}
