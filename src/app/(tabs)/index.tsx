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
  LinearTransition,
  runOnJS,
  useAnimatedReaction,
  useReducedMotion,
  useSharedValue,
} from 'react-native-reanimated';
import { SafeAreaView } from 'react-native-safe-area-context';

import { AddIslandSheet } from '@/components/add-island-sheet';
import { IslandMenuSheet, type IslandMenuHandle } from '@/components/home/island-menu-sheet';
import { IslandPeek, type IslandPeekContext, type IslandPeekHandle } from '@/components/home/island-peek';
import { useHomeSearch } from '@/hooks/home/use-home-search';
import { CatConstellation } from '@/components/cat-constellation';
import { StatsChips } from '@/components/home/stats-chips';
import { PracticeDock, DOCK_H } from '@/components/home/practice-dock';
import { LangFlagButton } from '@/components/home/lang-flag-button';
import { devHomeSim } from '@/lib/dev-simulate';
import { IslandSearch } from '@/components/island-search';
// prism-home: prism kit imports for the search button, record FAB and rename sheet
import { PrismButton } from '@/components/prism/prism-button';
import { SearchIcon } from '@/components/tide/toolbar-icons';
import { IslandRow, STEP, WAVE_MAX_CARDS } from '@/components/home/island-row';
import { SortRow, type Sort } from '@/components/home/sort-row';
import { fonts } from '@/constants/fonts';
import { Spacing, tide, verb } from '@/constants/theme';
import { alertSheet, confirmSheet } from '@/lib/confirm-sheet';
import { useSkyStyle, isNight } from '@/lib/sky';
import { getGuideStep, setGuideStep, useGuideAnchor, useGuideStep } from '@/lib/guide';
import { etaShort } from '@/lib/eta';
import { useT, useDir } from '@/lib/i18n';
import * as api from '@/lib/api';
import { startOpen, type CardRect } from '@/lib/card-morph';
import { invalidateCachedIsland } from '@/lib/island-cache';
import { prefetchSessionPlan } from '@/lib/plan-cache';
import { useWheelScroll, type Shape } from '@/hooks/home/use-wheel-scroll';
import { invalidateLineAudio } from '@/lib/line-audio-cache';
import { forgetLastLine, peekLastLine, resumeLine } from '@/lib/last-line';
import { forgetRung, loadLadder, peekRung } from '@/lib/speed-ladder';
import { formatSpeed } from '@/lib/format';
import { isDownloaded } from '@/lib/offline-islands'; // offline-islands
import { CatBadge } from '@/components/cat/cat-badge';
import { forgetIsland, getPracticeLog, minutesOn, streakDays, type PracticeLog } from '@/lib/practice';
import { getBetaSync, useBetaFeatures } from '@/lib/beta';
import { maybeOfferStreakReminder } from '@/lib/streak-reminder';
import { checkStreakMoments } from '@/lib/streak-moments';
import { progressNow, useProgressCache } from '@/lib/progression';
import { StreakSheet } from '@/components/streak-sheet';
import { getSettingsSync, subscribeSettings, toIslandLanguage } from '@/lib/settings';
import { getSettings, setHomeWaveDate } from '@/lib/settings';
import { deleteTakes } from '@/lib/takes';
import { useHomeIslands } from '@/hooks/home/use-home-islands';

/** Small code shown on a card whose language differs from the learning
 * language, once Show all languages is on. */
const LANG_CODE: Record<api.Language, string> = { ja: 'JP', es: 'ES', en: 'EN', fr: 'FR', pt: 'PT', zh: 'ZH', ko: 'KO', de: 'DE', he: 'HE', ar: 'AR' };

/** How long the wheel has to stay at rest before the centred card lights. */
const SETTLE_MS = 120;
// The plain search list's space above the first card and below the last.
const LIST_TOP = Spacing.sm;
// The wheel's space above its first (lit) slot. The fixed header's bottom
// margin already leaves the gap under the sort pills.
const WHEEL_TOP = 0;
// Mock E's header buttons: 40pt, the same as the flag.
const HEADER_BUTTON = 40;
// Tall enough that the last card scrolls clear above the floating dock (the
// dock's height over the tab bar's reach, plus a gap).
const LIST_BOTTOM = 98 + DOCK_H;

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
  const {
    query,
    setQuery,
    searchOpen,
    searchGrow,
    searchRowH,
    searchButtonStyle,
    searchOpenRef,
    openSearch,
    closeSearch,
    ctl: searchCtl,
  } = useHomeSearch();
  const [sort, setSort] = useState<Sort>('newest');
  const [log, setLog] = useState<PracticeLog>(EMPTY_LOG);
  const [streakOpen, setStreakOpen] = useState(false);
  const { progress: cachedProgress } = useProgressCache();
  const progressLoaded = cachedProgress !== null;
  useEffect(() => {
    if (progressLoaded && beta) checkStreakMoments(true);
  }, [progressLoaded, beta]);
  const reducedMotion = useReducedMotion();
  // The list has two shapes. The wheel (search closed): the lit slot is the
  // first one, right under the sort pills, behind a fixed top pad. Snapping,
  // scale and dim key off it, and the card in it is tinted and lit. Only the
  // bottom pad follows the list's height, so the last card can reach the
  // first slot. The plain list (search open): cards top aligned under the
  // sort pills, no snapping, every card a side card. `shape` is what is on
  // screen and the only source for the pads. `wheelH` is the list's height
  // with search closed, 0 until the first onLayout, and the list stays
  // invisible until it is known.
  //
  // A new shape lands in two commits: the first turns the cells' layout
  // animation off, the second changes the pad. Otherwise every cell would
  // slide to its new place while the scroll offset jumps at once.
  const [shape, setShape] = useState<Shape>({ wheel: true, wheelH: 0 });
  const wanted = useRef<Shape>({ wheel: true, wheelH: 0 });
  const [shapeReq, setShapeReq] = useState(0);
  const [animLayout, setAnimLayout] = useState(false);
  // The language filter changes which cards exist, often while Home sits
  // behind Settings where a layout animation never runs to its end and leaves
  // the cells below at their old offsets (a blank gap). A render whose filter
  // differs from the last committed one gets no layout animation.
  const filterKey = showAllLanguages ? 'all' : learningLanguage;
  const committedFilter = useRef(filterKey);
  const filterSettled = committedFilter.current === filterKey;
  useEffect(() => {
    committedFilter.current = filterKey;
  }, [filterKey]);
  const listRef = useRef<FlatList<api.IslandSummary>>(null);
  // The card to centre once the wheel is back on screen, or null.
  const pendingPlace = useRef<number | null>(null);
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
  // The Rename/Delete sheet a long press opens; it holds its own state.
  const menuRef = useRef<IslandMenuHandle>(null);
  const peekRef = useRef<IslandPeekHandle>(null);
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

  // Reload once whenever the screen comes back into focus (effect below).
  const [focused, setFocused] = useState(false);
  const {
    islands, setIslands, loading, setLoading, error, listOffline, removed, load, loadDue, dueReady, dueIds,
    visibleIslands, takesEpoch, bumpTakesEpoch, tiersFor, keptUpFor,
  } = useHomeIslands({ t, log, focused, showAllLanguages, learningLanguage, beta });

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

  // Sorted before filtering, so closing search can find where the centred
  // island sits in the full list.
  const homeSim = devHomeSim();
  const sortedAll = useMemo(
    () =>
      (homeSim === 'empty' ? [] : [...visibleIslands]).sort((a, b) => {
        if (sort === 'least') {
          const diff = (log.islands[a.id]?.seconds ?? 0) - (log.islands[b.id]?.seconds ?? 0);
          if (diff !== 0) return diff;
        }
        // Newest first: the tie break above, and the "Newest" sort itself.
        return new Date(b.created_at).getTime() - new Date(a.created_at).getTime();
      }),
    [visibleIslands, sort, log, homeSim],
  );
  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    return q ? sortedAll.filter((i) => i.title.toLowerCase().includes(q)) : sortedAll;
  }, [sortedAll, query]);

  // auto-practice: only ready islands can be practised (offline, only
  // downloaded ones), so the card counts those and its pill never opens an
  // empty queue.
  const practicable = useCallback(
    (i: api.IslandSummary) => dueIds.has(i.id) && i.status === 'ready' && (!listOffline || isDownloaded(i.id)),
    [dueIds, listOffline],
  );
  const realDueCount = useMemo(
    () => visibleIslands.reduce((n, i) => (practicable(i) ? n + 1 : n), 0),
    [visibleIslands, practicable],
  );
  const readyDueCount = homeSim === 'empty' || homeSim === 'due0' ? 0 : homeSim === 'due99' ? 99 : realDueCount;

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

  // What open and close search read, set each render so both stay stable.
  searchCtl.current = { sortedAll, centreRef, wanted, pendingPlace, cancelSettle, requestShape };

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
  // sitting on this one. Polling lives in `useHomeIslands`, and runs only
  // while something is still building.
  useFocusEffect(
    useCallback(() => {
      let alive = true;
      setFocused(true);
      bumpTakesEpoch();
      void load();
      void prefetchSessionPlan(); // review.tsx opens on it instead of its loader
      void getPracticeLog().then((next) => {
        if (!alive) return;
        setLog(next);
        // Once per install, after the first day that counts: offers the evening streak reminder.
        if (getBetaSync().beta) {
          maybeOfferStreakReminder(next);
          checkStreakMoments(progressNow() !== null);
        }
      });
      loadDue(() => alive);
      return () => {
        alive = false;
        setFocused(false);
      };
    }, [load, loadDue, bumpTakesEpoch]),
  );
  // Only while Home is on top: Record, Import or YouTube from the add sheet sends the guide back to 'home' under them.
  const fab = useGuideAnchor('addFab', focused && (guideStep === 'home' || guideStep === 'tour'));
  // bl58-easy-for-me: where "No islands yet" sits, so the guide's bubble keeps clear of it.
  const headAnchor = useGuideAnchor('homeHead', focused && guideStep === 'home');
  const emptyAnchor = useGuideAnchor('homeEmpty', focused && guideStep === 'home');

  const { scrollY, wheelOn, viewportH, scrollHandler, rowIdle, applyWheelH } = useWheelScroll({
    shape,
    shownLength: shown.length,
    query,
    searchRowH,
    wanted,
    pendingPlace,
    centreRef,
    moving,
    searchOpenRef,
    listRef,
    requestShape,
    cancelSettle,
    updateCentre,
    scheduleSettle,
  });

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

  useEffect(() => {
    // The wanted shape is on screen and measured: cells may animate their
    // layout again.
    setAnimLayout(wanted.current.wheelH > 0);
  }, [shape]);

  // Stable across renders, like openIsland, so memo(IslandRow) can skip every
  // row whose own props did not change: a centre change re-renders only the
  // row leaving and the row arriving.
  const openRowMenu = useCallback((item: api.IslandSummary, ctx: IslandPeekContext) => {
    peekRef.current?.open(item, ctx);
  }, []);
  const openRename = useCallback((item: api.IslandSummary) => {
    menuRef.current?.openRename(item);
  }, []);

  // Built once per change of what it shows, not per Home render: the header
  // re-renders whenever it gets new options.
  // The search button sits at the reading start: left in English, right in Hebrew.
  // Both sides are set, in every language, so the Tabs header never draws its
  // own default on the side left open: exactly one search and one flag. The
  // flag takes the opposite side.
  const searchSide = dir.rtl ? 'headerRight' : 'headerLeft';
  const flagSide = dir.rtl ? 'headerLeft' : 'headerRight';
  const screenOptions = useMemo(
    () => ({
      headerStyle: { backgroundColor: sky.top },
      headerTintColor: tide.text,
      headerShadowVisible: false,
      // Mock E: the title centred between two 40pt buttons, 16pt from the
      // screen edges. Centred, the title needs no RTL side swap (dir.headerSides).
      headerTitleAlign: 'center' as const,
      headerLeftContainerStyle: undefined,
      headerRightContainerStyle: undefined,
      [flagSide]: () => (
        <View style={styles.headerSide}>
          <LangFlagButton />
        </View>
      ),
      [searchSide]: () => (
        // prism-home: edited region
        <Animated.View style={[searchButtonStyle, styles.headerSide]} pointerEvents={searchOpen ? 'none' : 'auto'}>
          <PrismButton
            shape="round"
            size={HEADER_BUTTON}
            verb="tools"
            onPress={openSearch}
            accessibilityLabel={t('home.searchAccessibilityLabel')}>
            <SearchIcon color={verb.tools.c1} size={22} />
          </PrismButton>
        </Animated.View>
        // prism-home: end
      ),
    }),
    [sky.top, searchOpen, openSearch, searchButtonStyle, t, searchSide, flagSide],
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
          : `${t('home.lines', { count: item.line_count })} · ${complexityLabel}${minutes >= 1 ? ` · ${t('home.minutes', { count: minutes })}` : ''}${keptUp && keptUp.total > 0 ? ` · ${t('home.keptUp', { kept: keptUp.kept, total: keptUp.total })}` : ''}${rung ? ` · ${formatSpeed(rung.speed)}` : ''}`;
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

  // The top pad is fixed and never reads the measured height, so a height
  // change cannot move card 0. The bottom pad fills the rest of the list
  // under the last card, so it can scroll up into the first slot.
  const wheelPad = WHEEL_TOP;
  const wheelPadBottom = Math.max(0, shape.wheelH - WHEEL_TOP - STEP);
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
        <StatsChips
          log={log}
          dueCount={dueReady && !loading ? readyDueCount : null}
          onStreak={() => setStreakOpen(true)}
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
        itemLayoutAnimation={animLayout && !searchOpen && focused && filterSettled ? LinearTransition.duration(220) : undefined}
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
      <PracticeDock
        dueCount={dueReady && !loading ? readyDueCount : null}
        hasIslands={sortedAll.length > 0}
        onPractice={() => router.push('/review')}
        onDrive={beta ? startDrive : undefined}
        onAdd={() => {
          if (getGuideStep() === 'home') setGuideStep('add');
          setAddOpen(true);
        }}
        addAnchor={fab}
        style={searchButtonStyle}
        hidden={searchOpen}
      />
      <AddIslandSheet open={addOpen} onClose={() => setAddOpen(false)} />
      <StreakSheet log={log} open={streakOpen} onClose={() => setStreakOpen(false)} streak={streakDays(log, new Date())} longest={cachedProgress?.longest_streak ?? 0} />
      <IslandMenuSheet ref={menuRef} onRename={rename} />
      <IslandPeek ref={peekRef} onRename={openRename} onDelete={confirmDelete} />
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1 },
  center: { alignItems: 'center', justifyContent: 'center', paddingTop: Spacing.xxl },
  // Horizontal padding only: the header and footer spacers place the first
  // and last card.
  list: { paddingHorizontal: Spacing.lg },
  hidden: { opacity: 0 },
  empty: { fontSize: 15, lineHeight: 22, textAlign: 'center', paddingHorizontal: Spacing.xl, fontFamily: fonts.ui },
  // Above the wheel, not inside it: the FlatList scrolls under a fixed
  // header, same horizontal padding as the list.
  headerSide: { marginHorizontal: Spacing.lg },
  headerFixed: { paddingHorizontal: Spacing.lg, paddingTop: Spacing.lg, gap: Spacing.md, marginBottom: Spacing.md },
  star: {
    position: 'absolute',
    width: 2,
    height: 2,
    borderRadius: 1,
    backgroundColor: '#FFFFFF',
    zIndex: 0,
  },
});
