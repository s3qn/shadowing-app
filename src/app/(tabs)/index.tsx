import { Tabs, useFocusEffect, useRouter } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import {
  Alert,
  Dimensions,
  Pressable,
  FlatList,
  type ListRenderItemInfo,
  RefreshControl,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import * as Haptics from 'expo-haptics';
import Animated, {
  cancelAnimation,
  Easing,
  Extrapolation,
  FadeOut,
  LinearTransition,
  interpolate,
  interpolateColor,
  runOnJS,
  useAnimatedReaction,
  useAnimatedScrollHandler,
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
  withDelay,
  withRepeat,
  withSequence,
  withSpring,
  withTiming,
  type SharedValue,
} from 'react-native-reanimated';
import { SafeAreaView } from 'react-native-safe-area-context';
import { SymbolView } from 'expo-symbols'; // icon-buttons: record FAB and rename sheet

import { BottomSheet } from '@/components/sheet/bottom-sheet';
import { CatConstellation } from '@/components/cat-constellation';
import { LANTERN_FADE_MS, LANTERN_RISE_MS, LANTERN_STEP_MS, LanternRow } from '@/components/lantern-row';
import { PracticeCard } from '@/components/practice-card';
import { IslandSearch, startSearchOpen } from '@/components/island-search';
import { PressScale } from '@/components/press-scale';
// prism-home: prism kit imports for the search button, record FAB and rename sheet
import { GlassPanel } from '@/components/prism/glass-panel';
import { PrismButton } from '@/components/prism/prism-button';
import { SearchIcon } from '@/components/tide/toolbar-icons';
import { fonts } from '@/constants/fonts';
import { prism, Radius, Spacing, tide, verb, withAlpha } from '@/constants/theme';
import { LitPillCover, LitPillRim, PILL_H, PILL_ICON_OFF, PILL_LABEL_SIZE, PILL_PAD_X, PillTrayShell } from '@/components/prism/pill-tray';
import { useSkyStyle, isNight } from '@/lib/sky';
import { useT, useDir } from '@/lib/i18n';
import * as api from '@/lib/api';
import { registerCard, startOpen, unregisterCard, useMorphHidesTitle, type CardRect } from '@/lib/card-morph';
import { hapticImpact, hapticSelection } from '@/lib/haptics';
import { invalidateCachedIsland, prewarmIsland } from '@/lib/island-cache';
import { LONG_ISLAND } from '@/components/tide/transcript-window';
import { PILL_TAB_BAR_REACH } from '@/components/pill-tab-bar';
import { invalidateLineAudio } from '@/lib/line-audio-cache';
import { forgetLastLine, getLastLine, peekLastLine } from '@/lib/last-line';
import { forgetRung, getRung, loadLadder, peekRung } from '@/lib/speed-ladder';
import { speedLabel } from '@/components/tide/speed-popover';
import { forgetIsland, getPracticeLog, minutesOn, type PracticeLog } from '@/lib/practice';
import { getSettingsSync, subscribeSettings, toIslandLanguage } from '@/lib/settings';
import { getSettings, setHomeWaveDate } from '@/lib/settings';
import { deleteTakes, keptUpTotal, lineTiers, weakestLine, type LineTier } from '@/lib/takes';

/** Small code shown on a card whose language differs from the learning
 * language, once Show all languages is on. */
const LANG_CODE: Record<api.Language, string> = { ja: 'JP', es: 'ES', en: 'EN' };

const AnimatedPressable = Animated.createAnimatedComponent(Pressable);
// A long press holds this long before it counts, so it reads as deliberate
// next to the plain tap that opens the island.
const LONG_PRESS_MS = 400;
// Cards past this position in the list appear instantly instead of joining
// the wave: staggering a whole long list would take too long to settle.
const WAVE_MAX_CARDS = 10;
const WAVE_STAGGER_MS = 40;
// The wheel: one fixed card height, a gap between cards, and the step a
// scroll of one card takes. Centring math and snapping both key off STEP.
const CARD_H = 128;
const GAP = 8;
const STEP = CARD_H + GAP;
/** How long the wheel has to stay at rest before the centred card lights. */
const SETTLE_MS = 120;
// The plain search list's space above the first card and below the last.
const LIST_TOP = Spacing.sm;
const LIST_BOTTOM = Spacing.xxl * 3;
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

/** A card's entrance for the once-a-day Home wave: rises from 18px below
 * while fading in, delayed by its position in the stagger. */
function waveEntering(delayMs: number) {
  return () => {
    'worklet';
    return {
      initialValues: { opacity: 0, transform: [{ translateY: 18 }] },
      animations: {
        opacity: withDelay(delayMs, withTiming(1, { duration: 220 })),
        transform: [{ translateY: withDelay(delayMs, withSpring(0, { damping: 22, stiffness: 200 })) }],
      },
    };
  };
}

const SORTS = ['newest', 'least'] as const;
type Sort = (typeof SORTS)[number];

// pill-tray-tab-bar: sort row start
const SORT_PILL_BORDER = 1;
/** The box inside a sort pill's border, which the lit fill and rim fill. */
const SORT_PILL_INNER_H = PILL_H - 2 * SORT_PILL_BORDER;
/**
 * One sort option in the Home sort row: a pill that hugs its label and
 * crossfades its own lit fill. The fill and rim take the pill's real size
 * from their own absolute fill, not from a measurement kept in state, so a
 * label that changes width (the app language switching between "Newest" and
 * "החדשים ביותר") takes them with it.
 */
function SortPill({ on, label, onPress }: { on: boolean; label: string; onPress: () => void }) {
  const litOpacity = useSharedValue(on ? 1 : 0);
  const scale = useSharedValue(1);
  useEffect(() => {
    litOpacity.value = withTiming(on ? 1 : 0, { duration: 200 });
  }, [on, litOpacity]);
  const scaleStyle = useAnimatedStyle(() => ({ transform: [{ scale: scale.value }] }));
  return (
    <Pressable
      onPress={onPress}
      onPressIn={() => {
        scale.value = withTiming(0.96, { duration: 80 });
      }}
      onPressOut={() => {
        scale.value = withSpring(1, prism.press.spring);
      }}>
      <Animated.View style={[styles.pill, scaleStyle]}>
        <LitPillCover height={SORT_PILL_INNER_H} opacity={litOpacity} />
        <LitPillRim radius={SORT_PILL_INNER_H / 2} opacity={litOpacity} />
        <Text style={[styles.pillText, { color: on ? prism.tray.lit.label : PILL_ICON_OFF }]}>{label}</Text>
      </Animated.View>
    </Pressable>
  );
}
// pill-tray-tab-bar: sort row end

const EMPTY_LOG: PracticeLog = { days: {}, islands: {}, passes: {}, ladders: {} };
// 20 minutes of shadowing fills an island's ownership band.
const TIDE_TARGET_SECONDS = 20 * 60;

export default function IslandsScreen() {
  const router = useRouter();
  const { t } = useT();
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
  // Raw due set from the backend schedule: islands practiced before and now
  // due again. `dueIds` below adds islands never practiced at all, which the
  // backend never lists (schedule.py only tracks islands it has seen).
  const [fetchedDueIds, setFetchedDueIds] = useState<Set<string>>(new Set());
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
    // The overlay pushes once it covers Home. The flying header shows the
    // line the player opens on: a long island resumes where it was left,
    // like the player itself.
    const lineCount = item.status === 'ready' ? item.line_count : 0;
    const saved = lineCount >= LONG_ISLAND ? (peekLastLine(item.id) ?? 0) : 0;
    const lineIndex = Math.max(0, Math.min(saved, lineCount - 1));
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
      setLoading(false);
    } catch (e) {
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
      Alert.alert(t('home.deleteFailedTitle'), e instanceof Error ? e.message : t('home.serverNoAnswer'));
    }
  }

  async function rename(id: string, title: string) {
    const finalTitle = title.trim() || t('home.untitledIsland');
    try {
      await api.renameIsland(id, finalTitle);
      invalidateCachedIsland(id);
      setIslands((prev) => prev.map((i) => (i.id === id ? { ...i, title: finalTitle } : i)));
    } catch (e) {
      Alert.alert(t('home.renameFailedTitle'), e instanceof Error ? e.message : t('home.serverNoAnswer'));
    }
  }

  // Home's visible pool: every island once Show all languages is on,
  // otherwise only the ones matching the learning language. Sorting, search,
  // due counts and the practice card all read from this, not from `islands`.
  const visibleIslands = useMemo(
    () => (showAllLanguages ? islands : islands.filter((i) => i.language === toIslandLanguage(learningLanguage))),
    [islands, showAllLanguages, learningLanguage],
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
      if (fetchedDueIds.has(island.id) || (island.status === 'ready' && !(island.id in log.islands))) {
        ids.add(island.id);
      }
    }
    return ids;
  }, [visibleIslands, log, fetchedDueIds]);

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

  function confirmDelete(item: api.IslandSummary) {
    Alert.alert(
      t('home.deleteConfirmTitle', { title: item.title || t('home.untitledIsland') }),
      t('home.deleteConfirmBody'),
      [
        { text: t('common.cancel'), style: 'cancel' },
        { text: t('common.delete'), style: 'destructive', onPress: () => void remove(item.id) },
      ],
    );
  }

  // Re-poll whenever the screen comes back into focus, and keep polling while
  // anything is still building so the row flips to ready on its own. The
  // practice log only reloads once per focus: it changes on a shadowing
  // screen, never while sitting on this one.
  useFocusEffect(
    useCallback(() => {
      let alive = true;
      setTakesEpoch((n) => n + 1);
      const tick = async () => {
        if (!alive) return;
        await load();
      };
      tick();
      void getPracticeLog().then((next) => {
        if (alive) setLog(next);
      });
      void api.getDueToday().then((rows) => {
        if (alive) setFetchedDueIds(new Set(rows.map((r) => r.island_id)));
      }).catch(() => {});
      const timer = setInterval(tick, 3000);
      return () => {
        alive = false;
        clearInterval(timer);
      };
    }, [load]),
  );

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
  const screenOptions = useMemo(
    () => ({
      headerStyle: { backgroundColor: sky.top },
      headerTintColor: tide.text,
      headerShadowVisible: false,
      headerLeft: () => (
        // prism-home: edited region
        <Animated.View style={searchButtonStyle} pointerEvents={searchOpen ? 'none' : 'auto'}>
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
    [sky.top, searchOpen, openSearch, searchButtonStyle, t],
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
          ? api.stageLabel(item.stage)
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
      <View style={styles.headerFixed}>
        <PracticeCard log={log} dueCount={dueIds.size} />
        {/* pill-tray-tab-bar: sort row start */}
        <PillTrayShell
          wrapStyle={[styles.sortRowWrap, dir.rtl && styles.sortRowWrapRtl]}
          style={[styles.sortRow, dir.row]}>
          {SORTS.map((s) => (
            <SortPill
              key={s}
              on={sort === s}
              label={SORT_LABEL[s]}
              onPress={() => {
                if (s !== sort) void hapticSelection();
                setSort(s);
              }}
            />
          ))}
        </PillTrayShell>
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
        refreshControl={
          <RefreshControl refreshing={loading} onRefresh={load} tintColor={tide.textDim} />
        }
        ListEmptyComponent={
          loading ? (
            <View style={{ marginTop: Spacing.xxl, alignItems: 'center' }}>
              <CatConstellation />
            </View>
          ) : (
            <View style={styles.center}>
              <Text style={[styles.empty, { color: tide.textDim }]}>
                {error
                  ? error
                  : query.trim() && visibleIslands.length > 0
                    ? t('home.noIslandMatches')
                    : t('home.noIslandsYet')}
              </Text>
            </View>
          )
        }
        renderItem={renderIsland}
      />
      {/* prism-home: edited region */}
      <PrismButton
        shape="round"
        size={prism.sizes.bigRound}
        verb="speak"
        containerStyle={styles.fab}
        onPress={() => router.push('/record')}
        accessibilityLabel={t('home.recordAccessibilityLabel')}>
        <SymbolView name={{ ios: 'mic.fill', android: 'mic' }} size={24} weight="regular" tintColor={verb.speak.c1} />
      </PrismButton>
      {/* prism-home: end */}
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
            <TextInput
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
          <GlassPanel style={styles.sheetMenuRow}>
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
        )}
        {/* prism-home: end */}
      </BottomSheet>
    </SafeAreaView>
  );
}

type IslandRowProps = {
  item: api.IslandSummary;
  /** This card's slot in the wheel, for the distance-from-centre maths. 0 in
   * the plain search list, where the wheel is off and nothing reads it: a
   * live position there would re-render every card below a filtered-out one
   * on every keystroke. */
  slotIndex: number;
  /** The list's live scroll offset, shared with every card on the UI
   * thread. */
  scrollY: SharedValue<number>;
  /** The wheel's viewport height, shared with every card on the UI thread. */
  viewportH: SharedValue<number>;
  /** False in the plain search list: no wheel scale or dim. */
  wheelOn: SharedValue<boolean>;
  /** Whether this card currently sits in the centre slot. */
  centred: boolean;
  /** Whether this card's lanterns are on: the centred card, once the wheel
   * has come to rest. */
  lit: boolean;
  /** Tier per line, only ever set for the lit, ready card. `null`
   * elsewhere, when it has not loaded yet, or when there is nothing to
   * light (busy or failed). */
  tiers: LineTier[] | null;
  busy: boolean;
  /** Whether this island is due for practice today, per `getDueToday`. */
  due: boolean;
  fraction: number;
  meta: string;
  /** `JP`/`ES`/`EN` shown next to the meta line once Show all languages is
   * on, so a mixed list still reads at a glance. `null` when the toggle is
   * off, since every card then shares the learning language. */
  langPill: string | null;
  /** This card's place in the once-a-day Home wave, or `null` to appear
   * instantly: past the first `WAVE_MAX_CARDS` cards, outside the first
   * visit of the day, or with reduced motion on. */
  waveIndex: number | null;
  /** Whether a row leaving the list fades out. Off while search is open: a
   * row a keystroke filters away just goes. */
  exitFade: boolean;
  /** A plain tap: always opens the island, with the card's on-screen rect for
   * the morph into the player. */
  onOpen: (item: api.IslandSummary, rect: CardRect) => void;
  /** A held tap: opens the Rename/Delete sheet for the given island. */
  onMenu: (item: api.IslandSummary) => void;
};

/**
 * One island card. A tap always opens the island; a roughly 400ms hold eases
 * the card to a slightly smaller scale with a brighter border while the
 * finger is down. Releasing early eases it back with no menu. Holding past
 * the threshold gives a medium haptic, eases the card back to its resting
 * size, then hands off to the Rename/Delete sheet. Reduced motion drops the
 * scale change and keeps only the border. Deleting a row is handled by the
 * exit animation below, not by anything here.
 *
 * While the island is still building, a light sweep loops across the card
 * and the status gets a pulsing dot; reduced motion holds the dot still and
 * drops the sweep. The moment the card turns ready, it flashes the accent
 * once and gives a haptic.
 */
const IslandRow = memo(function IslandRow({
  item,
  slotIndex,
  scrollY,
  viewportH,
  wheelOn,
  centred,
  lit,
  tiers,
  busy,
  due,
  fraction,
  meta,
  langPill,
  waveIndex,
  exitFade,
  onOpen,
  onMenu,
}: IslandRowProps) {
  const { t } = useT();
  const dir = useDir();
  const pressed = useSharedValue(0);
  const reducedMotion = useReducedMotion();
  const cardRef = useRef<View>(null);
  const showLanterns = !busy && item.status !== 'failed';
  const weakest = tiers ? weakestLine(tiers) : -1;

  // The centred tint: background and border ease toward the coral wash over
  // 250ms as the card enters or leaves the centre slot.
  const mid = useSharedValue(0);
  useEffect(() => {
    mid.value = withTiming(centred ? 1 : 0, { duration: 250 });
  }, [centred, mid]);

  // The lantern light sequence while this card is lit, and a plain fade to
  // dark once it is not. litMs is elapsed ms since lighting started; power
  // is 1 lit, 0 dark. The weakest lantern's flicker is the focus effect
  // below.
  const totalMs = item.line_count * LANTERN_STEP_MS + LANTERN_RISE_MS;
  const litMs = useSharedValue(reducedMotion && lit ? totalMs : 0);
  const flick = useSharedValue(1);
  const power = useSharedValue(lit ? 1 : 0);
  // When the light sequence started, on the JS clock, so a flicker started
  // on refocus waits only for what is left of the weakest lantern's rise.
  const litSince = useRef(0);
  // True once the card is dark and its fade has finished, so the lantern row
  // drops its remembered colours and goes back to neutral.
  const [settled, setSettled] = useState(!lit);
  if (lit && settled) setSettled(false);
  // Reduced motion has no fade: an unlit card is dark at once.
  if (!lit && reducedMotion && !settled) setSettled(true);
  useEffect(() => {
    // Whatever was running (a light sequence, a flicker, a fade) stops
    // before the next state starts.
    cancelAnimation(litMs);
    cancelAnimation(flick);
    cancelAnimation(power);
    if (lit) {
      power.value = 1;
      flick.value = 1;
      litSince.current = Date.now();
      if (reducedMotion) {
        litMs.value = totalMs;
        return;
      }
      // Always from the first lantern, never resuming half-way. A change of
      // the weakest line (new takes) restarts it too, through the deps.
      litMs.value = 0;
      litMs.value = withTiming(totalMs, { duration: totalMs, easing: Easing.linear });
      return;
    }
    if (reducedMotion) {
      power.value = 0;
      litMs.value = 0;
      flick.value = 1;
      return;
    }
    // Every lantern fades together: power scales them all at once.
    power.value = withTiming(0, { duration: LANTERN_FADE_MS, easing: Easing.out(Easing.quad) }, (finished) => {
      'worklet';
      // A fade cut short by the card lighting again leaves the new
      // sequence alone.
      if (!finished) return;
      litMs.value = 0;
      flick.value = 1;
      runOnJS(setSettled)(true);
    });
  }, [lit, reducedMotion, weakest, totalMs, litMs, flick, power]);

  // The weakest lantern's flicker, only while Home is on screen. It stops
  // when an island opens (Home blurs) instead of running under the player,
  // and starts again on the way back if this card is still lit, waiting
  // only for what is left of that lantern's rise. Declared after the light
  // sequence effect so a fresh `litSince` is what it reads.
  useFocusEffect(
    useCallback(() => {
      if (!lit || reducedMotion || weakest === -1) return;
      const riseEnd = weakest * LANTERN_STEP_MS + LANTERN_RISE_MS;
      const wait = Math.max(0, riseEnd - (Date.now() - litSince.current));
      flick.set(
        withDelay(
          wait,
          withRepeat(
            withSequence(
              withTiming(0.35, { duration: 600, easing: Easing.inOut(Easing.quad) }),
              withTiming(0.9, { duration: 90 }),
              withTiming(0.5, { duration: 240 }),
              withTiming(1, { duration: 570 }),
            ),
            -1,
          ),
        ),
      );
      return () => {
        // Eases to rest on a blur. A card losing the light cancels this at
        // once and fades from wherever the flicker was.
        flick.set(withTiming(1, { duration: LANTERN_FADE_MS }));
      };
    }, [lit, reducedMotion, weakest, flick]),
  );

  // No light sequence, flicker loop or fade may outlive the card.
  useEffect(
    () => () => {
      cancelAnimation(litMs);
      cancelAnimation(flick);
      cancelAnimation(power);
    },
    [litMs, flick, power],
  );

  const itemId = item.id;
  useEffect(() => {
    registerCard(itemId, cardRef);
    return () => unregisterCard(itemId);
  }, [itemId]);
  // onLongPress and onPressOut can both fire once a hold registers (the
  // finger is usually still down when the hold threshold is hit). This
  // keeps the later onPressOut from cancelling the hold's own return-to-rest
  // animation and swallowing the sheet it opens.
  const longPressFired = useRef(false);
  // The morph's flying title stands in for this one while it runs.
  const titleHidden = useMorphHidesTitle(itemId, 'card');

  // The building sweep, its width against the card's own measured width. The
  // status line itself carries the busy state now, with the compact
  // constellation next to the stage text.
  const rowWidth = useSharedValue(0);
  const sweep = useSharedValue(0);
  useEffect(() => {
    if (busy && !reducedMotion) {
      sweep.value = withRepeat(withTiming(1, { duration: 2400, easing: Easing.linear }), -1, false);
    } else {
      cancelAnimation(sweep);
      sweep.value = 0;
    }
  }, [busy, reducedMotion, sweep]);

  // One flash of the accent the moment a busy card turns ready.
  const flash = useSharedValue(0);
  const prevBusy = useRef(busy);
  useEffect(() => {
    if (prevBusy.current && !busy && item.status === 'ready') {
      void hapticImpact();
      flash.value = 1;
      flash.value = withTiming(0, { duration: 500 });
    }
    prevBusy.current = busy;
  }, [busy, item.status, flash]);

  // The quick coral mark a press-in puts on a card that is not centred, so
  // the press is visible even off the centre slot.
  const tapFlash = useSharedValue(0);

  function handlePressIn() {
    longPressFired.current = false;
    void hapticSelection();
    if (!centred) {
      tapFlash.value = withSequence(
        withTiming(1, { duration: 60 }),
        withTiming(0, { duration: 180, easing: Easing.out(Easing.quad) }),
      );
    }
    // Most presses become an open: start reading the island now, so it is
    // parsed by the time the morph has covered the screen.
    if (!busy) {
      prewarmIsland(itemId);
      // Reads the saved lines file, so the open can show the resume line.
      void getLastLine(itemId);
      void getRung(itemId, getSettingsSync().defaultSpeed);
    }
    pressed.value = withTiming(1, { duration: 120 });
  }

  function handlePressOut() {
    if (longPressFired.current) return;
    pressed.value = withTiming(0, { duration: 120 });
  }

  function handlePress() {
    cardRef.current?.measureInWindow((x, y, width, height) => {
      if (width === 0) {
        const { width: winW, height: winH } = Dimensions.get('window');
        onOpen(item, { x: winW / 2, y: winH / 2, width: 0, height: 0 });
        return;
      }
      onOpen(item, { x, y, width, height });
    });
  }

  function openOwnMenu() {
    onMenu(item);
  }

  function handleLongPress() {
    longPressFired.current = true;
    void hapticImpact(Haptics.ImpactFeedbackStyle.Medium);
    pressed.value = withTiming(0, { duration: 180 }, (finished) => {
      'worklet';
      if (finished) runOnJS(openOwnMenu)();
    });
  }

  const cardStyle = useAnimatedStyle(() => {
    const restBorder = interpolateColor(mid.value, [0, 1], ['rgba(236,232,244,0.12)', tide.waterline]);
    const restFill = interpolateColor(mid.value, [0, 1], ['rgba(255,255,255,0.06)', 'rgba(255,158,128,0.10)']);
    const pressBorder = interpolateColor(pressed.value, [0, 1], [restBorder, tide.lang.ja]);
    const t = Number.isFinite(tapFlash.value) ? Math.min(1, Math.max(0, tapFlash.value)) : 0;
    return {
      transform: [{ scale: reducedMotion ? 1 : 1 - pressed.value * 0.03 }],
      backgroundColor: interpolateColor(t, [0, 1], [restFill, 'rgba(255,158,128,0.16)']),
      borderColor: interpolateColor(t, [0, 1], [pressBorder, 'rgba(255,158,128,0.55)']),
    };
  });

  // The wheel scale and dim: how far this card's centre sits from the
  // viewport's own centre, at most one half-viewport away. Lives on the
  // outer slot so it never fights the card's own press scale or its
  // entering/exiting transform.
  const slotStyle = useAnimatedStyle(() => {
    if (!wheelOn.value) return { transform: [{ scale: 1 }], opacity: 1 };
    const half = Math.max(1, Number.isFinite(viewportH.value) ? viewportH.value / 2 : 1);
    const raw = Math.min(1, Math.abs(scrollY.value - slotIndex * STEP) / half);
    const d = Number.isFinite(raw) ? raw : 1;
    return {
      transform: [{ scale: reducedMotion ? 1 : 1 - d * 0.05 }],
      opacity: 1 - d * 0.35,
    };
  });

  const sweepStyle = useAnimatedStyle(() => {
    const width = rowWidth.value;
    const band = width * 0.5;
    return {
      opacity: busy && !reducedMotion ? 1 : 0,
      width: band,
      transform: [{ translateX: interpolate(sweep.value, [0, 1], [-band, width + band]) }, { rotate: '20deg' }],
    };
  });

  const flashFillStyle = useAnimatedStyle(() => ({ opacity: flash.value * 0.14 }));
  const flashBorderStyle = useAnimatedStyle(() => ({ opacity: flash.value }));

  return (
    <Animated.View style={[styles.slot, slotStyle]}>
      <AnimatedPressable
        ref={cardRef}
        disabled={busy}
        onPress={handlePress}
        onPressIn={handlePressIn}
        onPressOut={handlePressOut}
        onLongPress={handleLongPress}
        delayLongPress={LONG_PRESS_MS}
        entering={waveIndex !== null ? waveEntering(waveIndex * WAVE_STAGGER_MS) : undefined}
        exiting={exitFade ? FadeOut.duration(220) : undefined}
        onLayout={(e) => {
          rowWidth.value = e.nativeEvent.layout.width;
        }}
        style={[styles.row, cardStyle]}>
        <View
          pointerEvents="none"
          style={[
            styles.rowFill,
            dir.rtl && styles.rowFillRtl,
            { width: `${fraction * 100}%`, backgroundColor: tide.lang.ja },
          ]}
        />
        {busy ? (
          <Animated.View pointerEvents="none" style={[styles.sweepBand, sweepStyle]} />
        ) : null}
        <Animated.View pointerEvents="none" style={[styles.flashFill, { backgroundColor: tide.lang.ja }, flashFillStyle]} />
        <Animated.View pointerEvents="none" style={[styles.flashBorder, { borderColor: tide.lang.ja }, flashBorderStyle]} />
        <View style={styles.cardTop}>
          {/* `dir.content`, not `dir.text`: a title is content, ordered by
              its own script whatever the interface language is. */}
          <Text numberOfLines={2} style={[styles.cardTitle, dir.content, { color: tide.text, opacity: titleHidden ? 0 : 1 }]}>
            {item.title || t('home.untitledIsland')}
          </Text>
        </View>
        <View style={[styles.metaRow, dir.row]}>
          {busy ? <CatConstellation compact /> : null}
          {/* The dot is its own cell, not part of the label: kept inside it,
              the dot would follow "Due today" in Hebrew as well and end up on
              the wrong side of the row once `dir.row` reverses the order. */}
          {due ? (
            <>
              <Text style={[styles.cardMeta, dir.text, { color: tide.turn }]}>{t('home.dueToday')}</Text>
              <Text style={[styles.cardMeta, { color: tide.turn }]}>·</Text>
            </>
          ) : null}
          <Text style={[styles.cardMeta, dir.text, { color: tide.textDim }]}>{meta}</Text>
          {langPill ? (
            <View style={styles.langPill}>
              <Text style={styles.langPillText}>{langPill}</Text>
            </View>
          ) : null}
        </View>
        {showLanterns ? (
          <LanternRow count={item.line_count} tiers={tiers} holdColours={!settled} weakest={weakest} litMs={litMs} flick={flick} power={power} />
        ) : (
          <View style={styles.lanternSpacer} />
        )}
      </AnimatedPressable>
    </Animated.View>
  );
});

const styles = StyleSheet.create({
  fill: { flex: 1 },
  center: { alignItems: 'center', justifyContent: 'center', paddingTop: Spacing.xxl },
  // Horizontal padding only: the header and footer spacers centre the first
  // and last card.
  list: { paddingHorizontal: Spacing.lg },
  hidden: { opacity: 0 },
  empty: { fontSize: 15, lineHeight: 22, textAlign: 'center', paddingHorizontal: Spacing.xl, fontFamily: fonts.ui },
  // One wheel slot per card: a fixed height so snapping and the centring
  // maths both key off the same STEP, independent of the card's own size.
  slot: { height: CARD_H, marginBottom: GAP },
  row: {
    height: CARD_H,
    borderRadius: 16,
    borderWidth: 1,
    borderColor: 'rgba(236,232,244,0.12)',
    backgroundColor: 'rgba(255,255,255,0.06)',
    paddingVertical: 11,
    paddingHorizontal: 12,
    overflow: 'hidden',
    gap: 4,
  },
  rowFill: { position: 'absolute', left: 0, top: 0, bottom: 0, opacity: 0.16 },
  // The ownership band grows from the edge the card is read from.
  rowFillRtl: { left: undefined, right: 0 },
  // Clipped by the row's own overflow:hidden, so it never spills past the card.
  sweepBand: {
    position: 'absolute',
    left: 0,
    top: -20,
    bottom: -20,
    backgroundColor: 'rgba(255,255,255,0.16)',
  },
  flashFill: { ...StyleSheet.absoluteFill },
  flashBorder: { ...StyleSheet.absoluteFill, borderWidth: 2, borderRadius: 16 },
  cardTop: { flexDirection: 'row', alignItems: 'center', gap: Spacing.md },
  cardTitle: { flex: 1, fontSize: 17, fontWeight: '600', fontFamily: fonts.serifJp },
  // No minHeight: the card has a fixed CARD_H, so the compact constellation
  // leaving never changes the card's height, and a 50pt meta row would push
  // a two-line title's lanterns past the card's clip.
  metaRow: { flexDirection: 'row', alignItems: 'center', gap: Spacing.xs },
  cardMeta: { fontSize: 13, fontFamily: fonts.ui },
  langPill: {
    borderRadius: Radius.pill,
    paddingHorizontal: Spacing.sm,
    paddingVertical: 2,
    backgroundColor: 'rgba(255,255,255,0.10)',
  },
  langPillText: { fontSize: 11, color: tide.textDim, fontFamily: fonts.uiMedium, fontWeight: '500' },
  // Matches LanternRow's own height: a busy or failed card has no lanterns
  // but still needs the row's height so every card lines up.
  lanternSpacer: { height: 24 },
  sheetInput: {
    fontFamily: fonts.ui,
    fontSize: 16,
    color: tide.text,
    backgroundColor: 'rgba(255,255,255,0.06)',
    borderRadius: 12,
    paddingHorizontal: 12,
    paddingVertical: 10,
    marginBottom: 8,
  },
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
  sortRow: { flexDirection: 'row', gap: Spacing.sm },
  // pill-tray-tab-bar: sort row start
  // Hugs the two pills instead of stretching full width under headerFixed's
  // default alignItems: 'stretch', which also keeps the offset pane a small
  // corner peek instead of a full-width strip (the pane sizes off this wrap).
  sortRowWrap: { alignSelf: 'flex-start' },
  // Hebrew reads from the right, so the tray hugs the opposite edge.
  sortRowWrapRtl: { alignSelf: 'flex-end' },
  pill: {
    alignItems: 'center',
    justifyContent: 'center',
    height: PILL_H,
    // Clips the lit fill and LitPillRim's straight top highlight to the
    // rounded shape, like the tab bar's slidingPill.
    borderRadius: PILL_H / 2,
    overflow: 'hidden',
    borderWidth: SORT_PILL_BORDER,
    borderColor: 'rgba(255,255,255,0.05)',
    backgroundColor: prism.tray.pillFill,
    paddingHorizontal: PILL_PAD_X,
  },
  pillText: { fontSize: PILL_LABEL_SIZE, fontWeight: '600', fontFamily: fonts.ui },
  // pill-tray-tab-bar: sort row end
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
});
