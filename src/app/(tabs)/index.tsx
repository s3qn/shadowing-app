import { Tabs, useFocusEffect, useRouter } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import {
  FlatList,
  type ListRenderItemInfo,
  RefreshControl,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import Animated, {
  Extrapolation,
  LinearTransition,
  interpolate,
  runOnJS,
  useAnimatedReaction,
  useAnimatedScrollHandler,
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
} from 'react-native-reanimated';
import { SafeAreaView } from 'react-native-safe-area-context';
import { SymbolView } from 'expo-symbols'; // icon-buttons: record FAB and rename sheet

import { AddIslandSheet } from '@/components/add-island-sheet';
import { BottomSheet } from '@/components/sheet/bottom-sheet';
import { CatConstellation } from '@/components/cat-constellation';
import { PracticeCard } from '@/components/practice-card';
import { IslandSearch, startSearchOpen } from '@/components/island-search';
// prism-home: prism kit imports for the search button, record FAB and rename sheet
import { GlassPanel } from '@/components/prism/glass-panel';
import { PrismButton } from '@/components/prism/prism-button';
import { SearchIcon } from '@/components/tide/toolbar-icons';
import { GlassInput } from '@/components/tide/glass-input';
import { IslandRow, CARD_H, STEP, WAVE_MAX_CARDS } from '@/components/home/island-row';
import { SortRow, type Sort } from '@/components/home/sort-row';
import { fonts } from '@/constants/fonts';
import { prism,Radius, Spacing, tide, verb, withAlpha } from '@/constants/theme';
import { alertSheet, confirmSheet } from '@/lib/confirm-sheet';
import { useSkyStyle, isNight } from '@/lib/sky';
import { getGuideStep, setGuideStep, useGuideAnchor, useGuideStep } from '@/lib/guide';
import { etaShort } from '@/lib/eta';
import { useT, useDir } from '@/lib/i18n';
import * as api from '@/lib/api';
import { startOpen, type CardRect } from '@/lib/card-morph';
import { invalidateCachedIsland } from '@/lib/island-cache';
import { PILL_TAB_BAR_REACH } from '@/components/pill-tab-bar';
import { invalidateLineAudio } from '@/lib/line-audio-cache';
import { forgetLastLine, peekLastLine, resumeLine } from '@/lib/last-line';
import { forgetRung, loadLadder, peekRung } from '@/lib/speed-ladder';
import { speedLabel } from '@/components/tide/speed-popover';
import { cancelDownload, humanBytes, isDownloaded, offlineSummaries, removeDownload, startDownload, useDownloadStatus } from '@/lib/offline-islands'; // offline-islands
import { CatBadge } from '@/components/cat/cat-badge';
import { forgetIsland, getPracticeLog, minutesOn, streakDays, type PracticeLog } from '@/lib/practice';
import { getBetaSync, useBetaFeatures } from '@/lib/beta';
import { maybeOfferStreakReminder } from '@/lib/streak-reminder';
import { checkStreakMoments } from '@/lib/streak-moments';
import { progressNow, useProgressCache } from '@/lib/progression';
import { StreakSheet } from '@/components/streak-sheet';
import { getSettingsSync, subscribeSettings, toIslandLanguage } from '@/lib/settings';
import { getSettings, setHomeWaveDate } from '@/lib/settings';
import { deleteTakes, keptUpTotal, lineTiers, type LineTier } from '@/lib/takes';

/** Small code shown on a card whose language differs from the learning
 * language, once Show all languages is on. */
const LANG_CODE: Record<api.Language, string> = { ja: 'JP', es: 'ES', en: 'EN' };

/** How long the wheel has to stay at rest before the centred card lights. */
const SETTLE_MS = 120;
// The plain search list's space above the first card and below the last.
const LIST_TOP = Spacing.sm;
// Tall enough that the last card scrolls clear above the floating add button
// (fab: bottom 96 plus its height).
const LIST_BOTTOM = 168;
// How much of the list's bottom the floating tab bar covers. The screen pads
// its bottom by the safe-area inset and the bar sits that inset plus its gap
// above the screen edge, so the inset cancels and only the bar's reach is left.
const TAB_BAR_OVERLAP = PILL_TAB_BAR_REACH;
/** The part of a list this tall that the tab bar leaves visible. */
function visibleOf(listH: number): number {
  return Math.max(1, listH - TAB_BAR_OVERLAP);
}

/** What the list shows: the wheel or the plain search list, and the wheel's
 * height with search closed (0 until measured). */
type Shape = { wheel: boolean; wheelH: number };

/** Today's date where the phone is, `YYYY-MM-DD`. Local, not UTC, so the wave
 * resets at midnight for the person holding the phone. */
function todayLocal(): string {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

const EMPTY_LOG: PracticeLog = { days: {}, islands: {}, passes: {}, ladders: {}, freezes: 0, frozen: [], seenStreak: -1 };
// 20 minutes of shadowing fills an island's ownership band.
const TIDE_TARGET_SECONDS = 20 * 60;

export default function IslandsScreen() {
  const router = useRouter();
  const { t } = useT();
  const [addOpen, setAddOpen] = useState(false);
  const guideStep = useGuideStep();
  const beta = useBetaFeatures().beta; // beta-gate: the cat, gem, Drive, streak moments and video rows are beta
  const dir = useDir();
  const SORT_LABEL: Record<Sort, string> = { newest: t('home.sortNewest'), least: t('home.sortLeastPracticed') };
  const sky = useSkyStyle();
  const night = isNight(new Date());
  const [islands, setIslands] = useState<api.IslandSummary[]>([]);
  const [loading, setLoading] = useState(true);
  // languages: which islands Home shows. Read synchronously so the first
  // render already filters, then kept fresh from Settings.
  const [learningLanguage, setLearningLanguageState] = useState(() => getSettingsSync().learningLanguage);
  const [showAllLanguages, setShowAllLanguagesState] = useState(() => getSettingsSync().showAllLanguages);
  useEffect(
    () =>
      subscribeSettings(() => {
        const s = getSettingsSync();
        setLearningLanguageState(s.learningLanguage);
        setShowAllLanguagesState(s.showAllLanguages);
      }),
    [],
  );
  const [error, setError] = useState('');
  const [query, setQuery] = useState('');
  const [searchOpen, setSearchOpen] = useState(false);
  // 0 closed, 1 open, driven by IslandSearch. The header magnifier fades out
  // as the pill's own magnifier fades in just below it.
  const searchGrow = useSharedValue(0);
  // The search row's height, which moves the header and list below it.
  const searchRowH = useSharedValue(0);
  const searchButtonStyle = useAnimatedStyle(() => ({
    opacity: interpolate(searchGrow.value, [0.1, 0.4], [1, 0], Extrapolation.CLAMP),
  }));
  const [sort, setSort] = useState<Sort>('newest');
  const [log, setLog] = useState<PracticeLog>(EMPTY_LOG);
  const [streakOpen, setStreakOpen] = useState(false);
  const { progress: cachedProgress } = useProgressCache();
  const progressLoaded = cachedProgress !== null;
  useEffect(() => {
    if (progressLoaded && beta) checkStreakMoments(true);
  }, [progressLoaded, beta]);
  // Raw due set from the backend schedule: islands practiced before and now
  // due again. `dueIds` below adds islands never practiced at all, which the
  // backend never lists (schedule.py only tracks islands it has seen).
  const [fetchedDueIds, setFetchedDueIds] = useState<Set<string>>(new Set());
  // False until the schedule answers (or fails), so the card shows a dash instead of a 0 that pops to 2.
  const [dueReady, setDueReady] = useState(false);
  const reducedMotion = useReducedMotion();
  // The list has two shapes. The wheel (search closed): a pad above the first
  // card and below the last one centres any card, snapping, scale and dim,
  // and the centred card tinted and lit. The plain list (search open):
  // cards top aligned under the sort pills, no snapping, every card a side
  // card. `shape` is what is on screen and the only source for the pad, so
  // the centring maths and the screen always agree. `wheelH` is the list's
  // height with search closed, 0 until the first onLayout, and the list
  // stays invisible until it is known. The wheel centres in the part above
  // the tab bar (`visibleOf`), not in the full height.
  //
  // A new shape lands in two commits: the first turns the cells' layout
  // animation off, the second changes the pad. Otherwise every cell would
  // slide to its new place while the scroll offset jumps at once.
  const scrollY = useSharedValue(0);
  const wheelOn = useSharedValue(true);
  const viewportH = useSharedValue(0);
  const [shape, setShape] = useState<Shape>({ wheel: true, wheelH: 0 });
  const wanted = useRef<Shape>({ wheel: true, wheelH: 0 });
  const [shapeReq, setShapeReq] = useState(0);
  const [animLayout, setAnimLayout] = useState(false);
  const listRef = useRef<FlatList<api.IslandSummary>>(null);
  const searchOpenRef = useRef(false);
  // False while the search row has any height, so onLayout ignores the
  // heights the row animation passes through.
  const rowIdle = useRef(true);
  // The card to centre once the wheel is back on screen, or null.
  const pendingPlace = useRef<number | null>(null);
  // The island centred when search opened, centred again when it closes.
  const preSearchId = useRef<string | null>(null);
  const [centreIndex, setCentreIndex] = useState(0);
  const [litIndex, setLitIndex] = useState(0);
  const centreRef = useRef(0);
  const moving = useRef(false);
  const settleTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const updateCentre = useCallback((idx: number) => {
    centreRef.current = idx;
    setCentreIndex(idx);
  }, []);
  const cancelSettle = useCallback(() => {
    if (settleTimer.current !== null) {
      clearTimeout(settleTimer.current);
      settleTimer.current = null;
    }
  }, []);
  // Lights the centred card SETTLE_MS after the last scroll event that could
  // end the motion. The centre is read when the timer fires, not when it is
  // set, so a late centre update from the UI thread still lands.
  const scheduleSettle = useCallback(() => {
    cancelSettle();
    settleTimer.current = setTimeout(() => {
      settleTimer.current = null;
      moving.current = false;
      setLitIndex(centreRef.current);
    }, SETTLE_MS);
  }, [cancelSettle]);
  // Any new motion puts every lantern out and drops a pending light.
  const onScrollStart = useCallback(() => {
    cancelSettle();
    moving.current = true;
    setLitIndex(-1);
  }, [cancelSettle]);
  // A drag that ends with momentum fires onMomentumScrollBegin within a
  // frame, which cancels this; one that ends without momentum settles here.
  const onDragEnd = scheduleSettle;
  const onMomentumEnd = scheduleSettle;
  useEffect(() => cancelSettle, [cancelSettle]);
  const scrollHandler = useAnimatedScrollHandler((e) => {
    scrollY.value = e.contentOffset.y;
  });
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
  // True only for the first Home mount of the local day: the list waves in
  // once, then settles for every later visit until the date rolls over.
  // `getSettingsSync` falls back to defaults (homeWaveDate: '') before
  // anything has read the file, which used to read as "never waved" and
  // wave on every cold start. Wait for the real, on-disk value instead, and
  // stay false (no wave) if it has not arrived by the time this decides.
  const [waveHome, setWaveHome] = useState(false);
  // Counts reads of the rung file. `peekRung` answers from its cache, which is
  // cold on the first render after a launch, so each row's speed suffix is
  // missing until something repaints the list. Feeding this to the list's
  // `extraData` repaints it once, as soon as the cache is warm.
  const [ladderTick, setLadderTick] = useState(0);
  useEffect(() => {
    let cancelled = false;
    void loadLadder().then(() => {
      if (!cancelled) setLadderTick((n) => n + 1);
    });
    void getSettings().then((settings) => {
      if (cancelled) return;
      const shouldWave = settings.homeWaveDate !== todayLocal();
      setWaveHome(shouldWave);
      if (shouldWave) void setHomeWaveDate(todayLocal());
    });
    return () => {
      cancelled = true;
    };
  }, []);
  // A list request that started before a delete can still answer with the
  // deleted row, which would put it back on screen. Ids deleted here stay out.
  const removed = useRef<Set<string>>(new Set());
  // The last list the poll put on screen, serialised, to skip an unchanged one.
  const lastListKey = useRef('');

  // The Rename/Delete sheet a long press opens: which island it is for, and
  // whether it is showing the menu or the rename field.
  const [menuItem, setMenuItem] = useState<api.IslandSummary | null>(null);
  const [renaming, setRenaming] = useState(false);
  const [draftTitle, setDraftTitle] = useState('');
  // An action a sheet row picked, run once the sheet has fully closed (an
  // Alert shown while the Modal is dismissing can vanish on iOS otherwise).
  const afterSheet = useRef<(() => void) | null>(null);
  function closeSheetThen(fn: () => void) {
    afterSheet.current = fn;
    setMenuItem(null);
  }
  function runAfterSheet() {
    const fn = afterSheet.current;
    afterSheet.current = null;
    if (fn) fn();
  }
  // Stable, like openRowMenu below, so a render of Home leaves IslandRow's memo
  // alone. Each row passes its own item back.
  const openIsland = useCallback((item: api.IslandSummary, rect: CardRect) => {
    if (item.source === 'youtube') { // youtube-shadowing
      router.push({ pathname: '/video/[id]', params: { id: item.id } }); // youtube-shadowing
      return; // youtube-shadowing
    } // youtube-shadowing
    if (item.source === 'podcast') { // podcast-listen
      router.push({ pathname: '/podcast/[id]', params: { id: item.id } });
      return;
    }
    // The overlay pushes once it covers Home. The flying header shows the
    // line the player opens on: an island resumes where it was left,
    // like the player itself.
    const lineCount = item.status === 'ready' ? item.line_count : 0;
    const lineIndex = resumeLine(peekLastLine(item.id), lineCount);
    startOpen(
      item.id,
      item.title || t('home.untitledIsland'),
      rect,
      () => {
        router.push({ pathname: '/island/[id]', params: { id: item.id, morph: '1' } });
      },
      { lineIndex, lineCount },
    );
  }, [router, t]);
  function saveRename() {
    const item = menuItem;
    if (!item) return;
    const title = draftTitle;
    closeSheetThen(() => void rename(item.id, title));
  }

  // offline-islands: the last list load failed, so only downloaded islands can open.
  const [listOffline, setListOffline] = useState(false);
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

  async function remove(id: string) {
    const restore = islands.find((i) => i.id === id) ?? null;
    // Drop it from state right away so the row's exit animation and the
    // rows below sliding up happen immediately, not after the round trip.
    removed.current.add(id);
    setIslands((prev) => prev.filter((i) => i.id !== id));
    try {
      await api.deleteIsland(id);
      invalidateLineAudio(id);
      invalidateCachedIsland(id);
      // Phone keeps the takes; the server never saw them.
      deleteTakes(id);
      void forgetIsland(id);
      forgetLastLine(id);
      forgetRung(id);
    } catch (e) {
      removed.current.delete(id);
      if (restore) {
        setIslands((prev) => (prev.some((i) => i.id === id) ? prev : [...prev, restore]));
      }
      void alertSheet(t('home.deleteFailedTitle'), e instanceof Error ? e.message : t('home.serverNoAnswer'));
    }
  }

  async function rename(id: string, title: string) {
    const finalTitle = title.trim() || t('home.untitledIsland');
    try {
      await api.renameIsland(id, finalTitle);
      invalidateCachedIsland(id);
      setIslands((prev) => prev.map((i) => (i.id === id ? { ...i, title: finalTitle } : i)));
    } catch (e) {
      void alertSheet(t('home.renameFailedTitle'), e instanceof Error ? e.message : t('home.serverNoAnswer'));
    }
  }

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

  // Sorted before filtering, so closing search can find where the centred
  // island sits in the full list.
  const sortedAll = useMemo(
    () =>
      [...visibleIslands].sort((a, b) => {
        if (sort === 'least') {
          const diff = (log.islands[a.id]?.seconds ?? 0) - (log.islands[b.id]?.seconds ?? 0);
          if (diff !== 0) return diff;
        }
        // Newest first: the tie break above, and the "Newest" sort itself.
        return new Date(b.created_at).getTime() - new Date(a.created_at).getTime();
      }),
    [visibleIslands, sort, log],
  );
  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    return q ? sortedAll.filter((i) => i.title.toLowerCase().includes(q)) : sortedAll;
  }, [sortedAll, query]);

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

  // auto-practice: only ready islands can be practised (offline, only
  // downloaded ones), so the card counts those and its pill never opens an
  // empty queue.
  const practicable = useCallback(
    (i: api.IslandSummary) => dueIds.has(i.id) && i.status === 'ready' && (!listOffline || isDownloaded(i.id)),
    [dueIds, listOffline],
  );
  const readyDueCount = useMemo(
    () => visibleIslands.reduce((n, i) => (practicable(i) ? n + 1 : n), 0),
    [visibleIslands, practicable],
  );

  // Drive: starts on the first due island with audio, else the newest ready one with audio.
  const startDrive = useCallback(() => {
    const withAudio = (i: api.IslandSummary) => i.status === 'ready' && i.has_audio !== false;
    const pick = sortedAll.find((i) => practicable(i) && withAudio(i)) ?? sortedAll.find(withAudio);
    router.push({ pathname: '/drive', params: pick ? { id: pick.id } : {} });
  }, [sortedAll, practicable, router]);

  const requestShape = useCallback((next: Shape) => {
    wanted.current = next;
    setAnimLayout(false);
    setShapeReq((n) => n + 1);
  }, []);

  // Search opens from the closed state, where `shown` is `sortedAll`. Keyed
  // on `sortedAll` (a poll, a sort or a fresh practice log) rather than on
  // `shown`, so the header options it sits in hold across keystrokes.
  const openSearch = useCallback(() => {
    const n = sortedAll.length;
    const at = n > 0 ? Math.min(n - 1, Math.max(0, centreRef.current)) : 0;
    preSearchId.current = sortedAll[at]?.id ?? null;
    startSearchOpen(searchGrow, searchRowH, reducedMotion);
    searchOpenRef.current = true;
    cancelSettle();
    setSearchOpen(true);
    requestShape({ ...wanted.current, wheel: false });
  }, [sortedAll, reducedMotion, searchGrow, searchRowH, cancelSettle, requestShape]);

  // IslandSearch has already started the close motion; the keyboard hides
  // after this returns.
  function closeSearch() {
    // Clearing the query brings the full list back: centre the island that
    // was centred before search opened, or the first one if it is gone.
    const id = preSearchId.current;
    const full = id ? sortedAll.findIndex((i) => i.id === id) : -1;
    pendingPlace.current = full >= 0 ? full : 0;
    searchOpenRef.current = false;
    setSearchOpen(false);
    setQuery('');
    requestShape({ ...wanted.current, wheel: true });
  }

  async function confirmDelete(item: api.IslandSummary) {
    const pick = await confirmSheet({
      title: t('home.deleteConfirmTitle', { title: item.title || t('home.untitledIsland') }),
      message: t('home.deleteConfirmBody'),
      actions: [
        { label: t('common.cancel'), verb: 'tools' },
        { label: t('common.delete'), verb: 'speak', destructive: true },
      ],
    });
    if (pick === 1) void remove(item.id);
  }

  // Reload once whenever the screen comes back into focus. The practice log
  // reloads only then too: it changes on a shadowing screen, never while
  // sitting on this one. Polling is a separate effect below, and runs only
  // while something is still building.
  const [focused, setFocused] = useState(false);
  useFocusEffect(
    useCallback(() => {
      let alive = true;
      setFocused(true);
      setTakesEpoch((n) => n + 1);
      void load();
      void getPracticeLog().then((next) => {
        if (!alive) return;
        setLog(next);
        // Once per install, after the first day that counts: offers the evening streak reminder.
        if (getBetaSync().beta) {
          maybeOfferStreakReminder(next);
          checkStreakMoments(progressNow() !== null);
        }
      });
      void api.getDueToday().then((rows) => {
        if (alive) setFetchedDueIds(new Set(rows.map((r) => r.island_id)));
      }).catch(() => {}).finally(() => {
        if (alive) setDueReady(true);
      });
      return () => {
        alive = false;
        setFocused(false);
      };
    }, [load]),
  );
  // Only while Home is on top: Record, Import or YouTube from the add sheet sends the guide back to 'home' under them.
  const fab = useGuideAnchor('addFab', focused && (guideStep === 'home' || guideStep === 'tour'));
  // bl58-easy-for-me: where "No islands yet" sits, so the guide's bubble keeps clear of it.
  const headAnchor = useGuideAnchor('homeHead', focused && guideStep === 'home');
  const emptyAnchor = useGuideAnchor('homeEmpty', focused && guideStep === 'home');

  // Keep polling only while some island is neither ready nor failed, so the
  // row flips to ready on its own and an idle Home makes no requests.
  const anyBuilding = islands.some((i) => i.status !== 'ready' && i.status !== 'failed');
  useEffect(() => {
    if (!focused || !anyBuilding) return;
    const timer = setInterval(() => void load(), 3000);
    return () => clearInterval(timer);
  }, [focused, anyBuilding, load]);

  // The card count on the UI thread, so the centre reaction can clamp to it
  // straight after a delete or a search that shrinks the list, without
  // waiting on a JS round trip.
  const countSV = useSharedValue(shown.length);
  useEffect(() => {
    countSV.set(shown.length);
  }, [shown.length, countSV]);

  // -1 in the plain list, so the first real index after the wheel comes
  // back always reaches JS.
  useAnimatedReaction(
    () => {
      if (!wheelOn.value) return -1;
      const n = countSV.value;
      if (n <= 0) return 0;
      const i = Math.round(scrollY.value / STEP);
      if (!Number.isFinite(i)) return 0;
      return Math.min(n - 1, Math.max(0, i));
    },
    (idx, prevIdx) => {
      if (idx >= 0 && idx !== prevIdx) runOnJS(updateCentre)(idx);
    },
  );

  // The centre can also move with no drag at all (a delete or a list that
  // gets shorter). At rest, let the light follow it after the same settle
  // delay.
  useEffect(() => {
    if (!moving.current && centreIndex !== litIndex) scheduleSettle();
  }, [centreIndex, litIndex, scheduleSettle]);

  // Second commit of a shape change: the commit that ran this effect already
  // has the layout animation off.
  useEffect(() => {
    if (shapeReq === 0) return;
    setShape(wanted.current);
  }, [shapeReq]);

  // The new pad is committed: place the offset before the frame shows, then
  // turn the layout animation back on in the next commit.
  useLayoutEffect(() => {
    wheelOn.set(shape.wheel);
    viewportH.set(shape.wheelH > 0 ? visibleOf(shape.wheelH) : 0);
    const idx = pendingPlace.current;
    if (shape.wheel && shape.wheelH > 0 && idx !== null) {
      pendingPlace.current = null;
      const n = shown.length;
      const at = n > 0 ? Math.min(n - 1, Math.max(0, idx)) : 0;
      const offset = at * STEP;
      scrollY.set(offset);
      listRef.current?.scrollToOffset({ offset, animated: false });
      cancelSettle();
      moving.current = false;
      updateCentre(at);
      scheduleSettle();
    }
  }, [shape, shown.length, wheelOn, viewportH, scrollY, cancelSettle, updateCentre, scheduleSettle]);
  useEffect(() => {
    // The wanted shape is on screen and measured: cells may animate their
    // layout again.
    setAnimLayout(wanted.current.wheelH > 0);
  }, [shape]);

  // Typing in the plain list shows the results from the top.
  useEffect(() => {
    if (!searchOpenRef.current) return;
    scrollY.set(0);
    listRef.current?.scrollToOffset({ offset: 0, animated: false });
  }, [query, scrollY]);

  // Takes the closed-search height from onLayout. Heights within 1px of the
  // current one are layout noise and change nothing.
  function applyWheelH(h: number) {
    if (!Number.isFinite(h) || h <= 0 || Math.abs(h - wanted.current.wheelH) <= 1) return;
    if (wanted.current.wheel) pendingPlace.current = centreRef.current;
    requestShape({ ...wanted.current, wheelH: h });
  }

  function onRowIdle(idle: boolean) {
    rowIdle.current = idle;
  }

  useAnimatedReaction(
    () => {
      const h = searchRowH.value;
      return Number.isFinite(h) ? h <= 0 : false;
    },
    (idle, prev) => {
      if (idle !== prev) runOnJS(onRowIdle)(idle);
    },
  );

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

  // Stable across renders, like openIsland, so memo(IslandRow) can skip every
  // row whose own props did not change: a centre change re-renders only the
  // row leaving and the row arriving.
  const openRowMenu = useCallback((item: api.IslandSummary) => {
    setRenaming(false);
    setDraftTitle(item.title);
    setMenuItem(item);
  }, []);

  // Built once per change of what it shows, not per Home render: the header
  // re-renders whenever it gets new options.
  // The search button sits at the reading start: left in English, right in Hebrew.
  const searchSide = dir.rtl ? 'headerRight' : 'headerLeft';
  const screenOptions = useMemo(
    () => ({
      headerStyle: { backgroundColor: sky.top },
      headerTintColor: tide.text,
      headerShadowVisible: false,
      [searchSide]: () => (
        // prism-home: edited region
        <Animated.View style={[searchButtonStyle, { marginHorizontal: 12 }]} pointerEvents={searchOpen ? 'none' : 'auto'}>
          <PrismButton
            shape="round"
            size={prism.sizes.roundSm}
            verb="tools"
            onPress={openSearch}
            accessibilityLabel={t('home.searchAccessibilityLabel')}>
            <SearchIcon color={verb.tools.c1} size={22} />
          </PrismButton>
        </Animated.View>
        // prism-home: end
      ),
    }),
    [sky.top, searchOpen, openSearch, searchButtonStyle, t, searchSide],
  );

  const wheel = shape.wheel;
  /**
   * One card's props, built once per change of what a card can show rather
   * than on every Home render. A stable identity here is what lets
   * `memo(IslandRow)` skip a card whose own props held: typing in the search
   * field then filters the list without re-rendering a single card or
   * lantern. `takesEpoch` rides in through `tiersFor` and `keptUpFor`, so a
   * focus that re-reads the takes still repaints the lit card.
   */
  const renderIsland = useCallback(
    ({ item, index }: ListRenderItemInfo<api.IslandSummary>) => {
      const busy = item.status === 'pending' || item.status === 'working';
      const due = dueIds.has(item.id);
      const minutes = minutesOn(log, item.id);
      const seconds = log.islands[item.id]?.seconds ?? 0;
      const fraction = Math.min(1, seconds / TIDE_TARGET_SECONDS);
      // Both of these read a card's place in the list, and both are dead
      // while search is open: the wheel's maths is off and the day's wave has
      // already played. Frozen there, so a keystroke that shifts every card
      // up a place leaves every card's props alone.
      const slotIndex = wheel ? index : 0;
      const waveIndex = waveHome && !searchOpen && !reducedMotion && index < WAVE_MAX_CARDS ? index : null;
      const centred = wheel && index === centreIndex;
      const lit = wheel && index === litIndex;
      // Only the lit, ready card reads its takes: a busy or failed
      // card never lights, so its tiers are never worth the folder read.
      const tiers = lit && !busy && item.status !== 'failed' ? tiersFor(item.id, item.line_count) : null;
      const keptUp = tiers ? keptUpFor(item.id, item.line_count) : null;
      const complexityLabel = item.complexity === 'simple' ? t('home.complexitySimple') : t('home.complexityComplex');
      const rung = !busy && item.status !== 'failed' ? peekRung(item.id) : undefined;
      const meta = item.status === 'failed'
        ? t('home.failed')
        : busy
          ? `${api.stageLabel(item.stage)}${etaShort(item.eta_s) ? ` · ${etaShort(item.eta_s)}` : ''}`
          : `${t('home.lines', { count: item.line_count })} · ${complexityLabel}${minutes >= 1 ? ` · ${t('home.minutes', { count: minutes })}` : ''}${keptUp && keptUp.total > 0 ? ` · ${t('home.keptUp', { kept: keptUp.kept, total: keptUp.total })}` : ''}${rung ? ` · ${speedLabel(rung.speed)}` : ''}`;
      return (
        <IslandRow
          item={item}
          slotIndex={slotIndex}
          scrollY={scrollY}
          viewportH={viewportH}
          wheelOn={wheelOn}
          centred={centred}
          lit={lit}
          tiers={tiers}
          busy={busy}
          stage={busy ? item.stage : ''}
          due={due}
          fraction={fraction}
          meta={meta}
          langPill={showAllLanguages ? LANG_CODE[item.language] : null}
          waveIndex={waveIndex}
          exitFade={!searchOpen}
          onOpen={openIsland}
          onMenu={openRowMenu}
        />
      );
    },
    [
      dueIds,
      log,
      wheel,
      waveHome,
      searchOpen,
      reducedMotion,
      centreIndex,
      litIndex,
      tiersFor,
      keptUpFor,
      t,
      showAllLanguages,
      ladderTick,
      scrollY,
      viewportH,
      wheelOn,
      openIsland,
      openRowMenu,
    ],
  );

  // Top pad centres card 0 in the visible part; the bottom pad adds the
  // covered part back so the last card can centre there too.
  const wheelPad = Math.max(0, (visibleOf(shape.wheelH) - CARD_H) / 2);
  const wheelPadBottom = wheelPad + TAB_BAR_OVERLAP;
  const shapeVisible = !shape.wheel || shape.wheelH > 0;

  if (!api.configured()) {
    return (
      <SafeAreaView style={StyleSheet.flatten([styles.fill, styles.center, { backgroundColor: sky.top }])}>
        <StatusBar style="light" />
        <Tabs.Screen
          options={{
            headerStyle: { backgroundColor: sky.top },
            headerTintColor: tide.text,
            headerShadowVisible: false,
          }}
        />
        <View style={[StyleSheet.absoluteFill, sky.from]} />
        <Animated.View style={[StyleSheet.absoluteFill, sky.to, sky.fadeStyle]} />
        {night && (
          <>
            <View style={[styles.star, { top: '10%', left: '15%' }]} />
            <View style={[styles.star, { top: '25%', right: '12%' }]} />
            <View style={[styles.star, { top: '40%', left: '25%' }]} />
            <View style={[styles.star, { top: '55%', right: '18%' }]} />
            <View style={[styles.star, { top: '70%', left: '20%' }]} />
          </>
        )}
        <Text style={[styles.empty, { color: tide.text }]}>{t('home.notConfigured')}</Text>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView edges={['bottom']} style={StyleSheet.flatten([styles.fill, { backgroundColor: sky.top }])}>
      <StatusBar style="light" />
      <Tabs.Screen options={screenOptions} />
      <View style={[StyleSheet.absoluteFill, sky.from]} />
      <Animated.View style={[StyleSheet.absoluteFill, sky.to, sky.fadeStyle]} />
      {night && (
        <>
          <View style={[styles.star, { top: '10%', right: '10%' }]} />
          <View style={[styles.star, { top: '25%', left: '12%' }]} />
          <View style={[styles.star, { top: '40%', right: '20%' }]} />
          <View style={[styles.star, { top: '60%', left: '15%' }]} />
          <View style={[styles.star, { top: '75%', right: '25%' }]} />
        </>
      )}
      <IslandSearch
        open={searchOpen}
        query={query}
        onChangeQuery={setQuery}
        onClose={closeSearch}
        grow={searchGrow}
        rowH={searchRowH}
      />
      <View ref={headAnchor.ref} onLayout={headAnchor.onLayout} collapsable={false} style={styles.headerFixed}>
        {beta ? <CatBadge anchorGuide={focused && guideStep === 'cat'} /> : null}
        <PracticeCard
          log={log}
          dueCount={dueReady && !loading ? readyDueCount : null}
          onPractice={() => router.push('/review')}
          onDrive={beta ? startDrive : undefined}
          onStreak={beta ? () => setStreakOpen(true) : undefined}
        />
        {/* pill-tray-tab-bar: sort row start */}
        <SortRow sort={sort} onSort={setSort} labels={SORT_LABEL} />
        {/* pill-tray-tab-bar: sort row end */}
      </View>
      <Animated.FlatList
        ref={listRef}
        data={shown}
        extraData={ladderTick}
        keyExtractor={(item) => item.id}
        style={shapeVisible ? undefined : styles.hidden}
        contentContainerStyle={styles.list}
        ListHeaderComponent={<View style={{ height: shape.wheel ? wheelPad : LIST_TOP }} />}
        ListFooterComponent={<View style={{ height: shape.wheel ? wheelPadBottom : LIST_BOTTOM }} />}
        keyboardShouldPersistTaps="handled"
        // Off while search is open: a keystroke changes most rows' places,
        // and the results should simply appear where they land.
        itemLayoutAnimation={animLayout && !searchOpen ? LinearTransition.duration(220) : undefined}
        onLayout={(e) => {
          // With search open, or its row still moving, the height is not the
          // wheel's.
          if (searchOpenRef.current || !rowIdle.current) return;
          applyWheelH(e.nativeEvent.layout.height);
        }}
        onScroll={scrollHandler}
        onScrollBeginDrag={onScrollStart}
        onMomentumScrollBegin={onScrollStart}
        onScrollEndDrag={onDragEnd}
        onMomentumScrollEnd={onMomentumEnd}
        scrollEventThrottle={16}
        snapToInterval={shape.wheel ? STEP : undefined}
        snapToAlignment={shape.wheel ? 'start' : undefined}
        decelerationRate={shape.wheel ? 'fast' : 'normal'}
        disableIntervalMomentum={shape.wheel}
        getItemLayout={(_, index) => ({ length: STEP, offset: (shape.wheel ? wheelPad : LIST_TOP) + index * STEP, index })}
        // bl58-easy-for-me: the header loading moves the empty text; the guide's bubble follows it.
        onContentSizeChange={emptyAnchor.onLayout}
        refreshControl={
          <RefreshControl refreshing={loading} onRefresh={load} tintColor={tide.textDim} />
        }
        ListEmptyComponent={
          loading ? (
            <View style={{ marginTop: Spacing.xxl, alignItems: 'center' }}>
              <CatConstellation />
            </View>
          ) : (
            <View ref={emptyAnchor.ref} onLayout={emptyAnchor.onLayout} style={styles.center}>
              <Text style={[styles.empty, { color: tide.textDim }]}>
                {error
                  ? error
                  : query.trim() && visibleIslands.length > 0
                    ? t('home.noIslandMatches')
                    : t('home.noIslandsYet')}
              </Text>
              {!error && !query.trim() && visibleIslands.length === 0 ? (
                <Text style={[styles.empty, { color: tide.textDim }]}>{t(beta ? 'home.noIslandsHint' : 'home.noIslandsHintBasic')}</Text>
              ) : null}
              {error ? (
                <PrismButton
                  shape="pill"
                  verb="tools"
                  label={t('common.retry')}
                  accessibilityLabel={t('common.retry')}
                  containerStyle={{ marginTop: Spacing.lg }}
                  onPress={() => {
                    setLoading(true);
                    void load();
                  }}
                />
              ) : null}
            </View>
          )
        }
        renderItem={renderIsland}
      />
      {/* prism-home: edited region */}
      <View ref={fab.ref} onLayout={fab.onLayout} style={[styles.fab, dir.rtl && styles.fabRtl]}>
        <PrismButton
          shape="round"
          size={prism.sizes.bigRound}
          verb="speak"
          onPress={() => {
            if (getGuideStep() === 'home') setGuideStep('add');
            setAddOpen(true);
          }}
          accessibilityLabel={t('home.addTitle')}>
          <SymbolView name={{ ios: 'plus', android: 'add' }} size={24} weight="regular" tintColor={verb.speak.c1} />
        </PrismButton>
      </View>
      {/* prism-home: end */}
      <AddIslandSheet open={addOpen} onClose={() => setAddOpen(false)} />
      <StreakSheet open={streakOpen} onClose={() => setStreakOpen(false)} streak={streakDays(log, new Date())} longest={cachedProgress?.longest_streak ?? 0} />
      <BottomSheet
        open={menuItem !== null}
        onClose={() => setMenuItem(null)}
        onDismissed={runAfterSheet}
        title={menuItem?.title || t('home.untitledIsland')}
        contentTitle
        avoidKeyboard>
        {/* prism-home: edited region */}
        {renaming ? (
          <>
            <GlassInput
              autoFocus
              value={draftTitle}
              onChangeText={setDraftTitle}
              onSubmitEditing={saveRename}
              returnKeyType="done"
              style={[styles.sheetInput, dir.content]}
            />
            <GlassPanel style={[styles.sheetActionsRow, dir.rtl && styles.sheetActionsRowRtl]}>
              <PrismButton shape="pill" verb="tools" flat label={t('home.save')} onPress={saveRename}>
                <SymbolView name={{ ios: 'checkmark', android: 'check' }} size={16} weight="regular" tintColor={verb.tools.c1} />
              </PrismButton>
            </GlassPanel>
          </>
        ) : (
          <>
          <GlassPanel style={[styles.sheetMenuRow, dir.row]}>
            <PrismButton
              shape="pill"
              verb="tools"
              flat
              containerStyle={styles.sheetActionPill}
              label={t('home.rename')}
              onPress={() => setRenaming(true)}>
              <SymbolView name={{ ios: 'pencil', android: 'edit' }} size={16} weight="regular" tintColor={verb.tools.c1} />
            </PrismButton>
            {/* Delete reads as destructive: red label, red icon, red-tinted glass
                fill. The label is a plain Text rather than the `label` prop so it
                can take the verb colour outright, with no "on" state involved. */}
            <View style={styles.sheetDeleteFill}>
              <PrismButton
                shape="pill"
                verb="speak"
                flat
                containerStyle={styles.sheetActionPill}
                accessibilityLabel={t('home.deleteIsland')}
                onPress={() => {
                  const item = menuItem;
                  if (!item) return;
                  closeSheetThen(() => confirmDelete(item));
                }}>
                <SymbolView name={{ ios: 'trash', android: 'delete' }} size={16} weight="regular" tintColor={verb.speak.c1} />
                <Text style={styles.sheetDeleteLabel}>{t('home.deleteIsland')}</Text>
              </PrismButton>
            </View>
          </GlassPanel>
          {/* offline-islands: one control, three states */}
          {menuItem?.status === 'ready' ? (
            <GlassPanel style={styles.sheetMenuRow}>
              <DownloadPill id={menuItem.id} closeThen={closeSheetThen} />
            </GlassPanel>
          ) : null}
          </>
        )}
        {/* prism-home: end */}
      </BottomSheet>
    </SafeAreaView>
  );
}

/** offline-islands: the sheet's download control. Its own component, so the
 * per-file progress re-renders this pill and not all of Home. */
function DownloadPill({ id, closeThen }: { id: string; closeThen: (fn: () => void) => void }) {
  const { t } = useT();
  const download = useDownloadStatus(id);
  const onPress = () => {
    if (download.state === 'none' || download.state === 'failed') {
      void startDownload(id);
    } else if (download.state === 'downloading') {
      closeThen(() => {
        void confirmSheet({
          title: t('home.downloadStopTitle'),
          actions: [
            { label: t('home.downloadKeepGoing'), verb: 'tools' },
            { label: t('home.downloadStop'), verb: 'speak', destructive: true },
          ],
        }).then((pick) => {
          if (pick === 1) cancelDownload(id);
        });
      });
    } else {
      closeThen(() => {
        void confirmSheet({
          title: t('home.downloadRemoveTitle'),
          message: t('home.downloadRemoveBody'),
          actions: [
            { label: t('common.cancel'), verb: 'tools' },
            { label: t('home.downloadRemove'), verb: 'speak', destructive: true },
          ],
        }).then((pick) => {
          if (pick === 1) removeDownload(id);
        });
      });
    }
  };
  const label =
    download.state === 'done'
      ? t('home.downloaded', { size: humanBytes(download.bytes) })
      : download.state === 'downloading'
        ? t('home.downloading', { done: download.done, total: download.total })
        : download.state === 'failed'
          ? t('home.downloadFailed')
          : t('home.download');
  return (
    <PrismButton
      shape="pill"
      verb="tools"
      flat
      containerStyle={styles.sheetActionPill}
      label={label}
      onPress={onPress}>
      <SymbolView
        name={
          download.state === 'done'
            ? { ios: 'arrow.down.circle.fill', android: 'download' }
            : { ios: 'arrow.down.circle', android: 'download' }
        }
        size={16}
        weight="regular"
        tintColor={verb.tools.c1}
      />
    </PrismButton>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1 },
  center: { alignItems: 'center', justifyContent: 'center', paddingTop: Spacing.xxl },
  // Horizontal padding only: the header and footer spacers centre the first
  // and last card.
  list: { paddingHorizontal: Spacing.lg },
  hidden: { opacity: 0 },
  empty: { fontSize: 15, lineHeight: 22, textAlign: 'center', paddingHorizontal: Spacing.xl, fontFamily: fonts.ui },
  sheetInput: { marginBottom: Spacing.sm },
  // prism-home: one row of pill actions sharing a single GlassPanel blur.
  sheetActionsRow: { flexDirection: 'row', gap: Spacing.sm, padding: Spacing.sm, alignSelf: 'flex-start' },
  sheetActionsRowRtl: { alignSelf: 'flex-end' },
  // The Rename/Delete row: both pills share the sheet's full width (no
  // alignSelf hug), evenly split with a 12pt gap between them.
  sheetMenuRow: { flexDirection: 'row', gap: Spacing.md, padding: Spacing.sm },
  sheetActionPill: { flex: 1 },
  // Clips the red tint to the pill's own rounded shape, matching PrismFace's
  // pill radius (999) rather than the panel's squarer one.
  sheetDeleteFill: { flex: 1, borderRadius: Radius.pill, overflow: 'hidden', backgroundColor: withAlpha(verb.speak.c1, 0.18) },
  sheetDeleteLabel: {
    fontFamily: fonts.ui,
    fontWeight: '600',
    fontSize: 13,
    color: verb.speak.c1,
    textShadowOffset: { width: 0, height: 0 },
    textShadowRadius: 6,
    textShadowColor: withAlpha(verb.speak.c1, 0.55),
  },
  // Above the wheel, not inside it: the FlatList needs its own full
  // viewport to centre the first card, same horizontal padding as the list.
  headerFixed: { paddingHorizontal: Spacing.lg, paddingTop: Spacing.lg, gap: Spacing.md, marginBottom: Spacing.md },
  star: {
    position: 'absolute',
    width: 2,
    height: 2,
    borderRadius: 1,
    backgroundColor: '#FFFFFF',
    zIndex: 0,
  },
  // prism-home: sizing and colour now come from PrismButton's face; this
  // only positions the FAB.
  fab: {
    position: 'absolute',
    right: Spacing.lg,
    bottom: 96,
  },
  // Hebrew cards read from the right, so the button moves to the left corner.
  fabRtl: { right: 'auto', left: Spacing.lg },
});
