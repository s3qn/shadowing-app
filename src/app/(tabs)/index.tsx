import { Tabs, useFocusEffect, useRouter } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Alert,
  Dimensions,
  Pressable,
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
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
  withDelay,
  withRepeat,
  withSpring,
  withTiming,
} from 'react-native-reanimated';
import { SafeAreaView } from 'react-native-safe-area-context';

import { BottomSheet } from '@/components/sheet/bottom-sheet';
import { CatConstellation } from '@/components/cat-constellation';
import { SheetAction } from '@/components/sheet/sheet-rows';
import { PracticeCard } from '@/components/practice-card';
import { IslandSearch } from '@/components/island-search';
import { PressScale } from '@/components/press-scale';
import { SearchIcon } from '@/components/tide/toolbar-icons';
import { fonts } from '@/constants/fonts';
import { Radius, Spacing, tide } from '@/constants/theme';
import { useSkyStyle, isNight } from '@/lib/sky';
import * as api from '@/lib/api';
import { registerCard, startOpen, unregisterCard, useMorphHidesTitle, type CardRect } from '@/lib/card-morph';
import { hapticImpact } from '@/lib/haptics';
import { invalidateCachedIsland, prewarmIsland } from '@/lib/island-cache';
import { LONG_ISLAND } from '@/components/tide/transcript-window';
import { invalidateLineAudio } from '@/lib/line-audio-cache';
import { forgetLastLine, getLastLine, peekLastLine } from '@/lib/last-line';
import { forgetIsland, getPracticeLog, minutesOn, type PracticeLog } from '@/lib/practice';
import { getSettings, setHomeWaveDate } from '@/lib/settings';
import { deleteTakes } from '@/lib/takes';

const AnimatedPressable = Animated.createAnimatedComponent(Pressable);
// A long press holds this long before it counts, so it reads as deliberate
// next to the plain tap that opens the island.
const LONG_PRESS_MS = 400;
// Cards past this position in the list appear instantly instead of joining
// the wave: staggering a whole long list would take too long to settle.
const WAVE_MAX_CARDS = 10;
const WAVE_STAGGER_MS = 40;

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
const SORT_LABEL: Record<Sort, string> = { newest: 'Newest', least: 'Least practiced' };
const EMPTY_LOG: PracticeLog = { days: {}, islands: {} };
// 20 minutes of shadowing fills an island's ownership band.
const TIDE_TARGET_SECONDS = 20 * 60;

export default function IslandsScreen() {
  const router = useRouter();
  const sky = useSkyStyle();
  const night = isNight(new Date());
  const [islands, setIslands] = useState<api.IslandSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [query, setQuery] = useState('');
  const [searchOpen, setSearchOpen] = useState(false);
  // 0 closed, 1 open, driven by IslandSearch. The header magnifier fades out
  // as the pill's own magnifier fades in just below it.
  const searchGrow = useSharedValue(0);
  const searchButtonStyle = useAnimatedStyle(() => ({
    opacity: interpolate(searchGrow.value, [0.1, 0.4], [1, 0], Extrapolation.CLAMP),
  }));
  const [sort, setSort] = useState<Sort>('newest');
  const [log, setLog] = useState<PracticeLog>(EMPTY_LOG);
  const reducedMotion = useReducedMotion();
  // True only for the first Home mount of the local day: the list waves in
  // once, then settles for every later visit until the date rolls over.
  // `getSettingsSync` falls back to defaults (homeWaveDate: '') before
  // anything has read the file, which used to read as "never waved" and
  // wave on every cold start. Wait for the real, on-disk value instead, and
  // stay false (no wave) if it has not arrived by the time this decides.
  const [waveHome, setWaveHome] = useState(false);
  useEffect(() => {
    let cancelled = false;
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
  // Stable, like openIsland below, so a render of Home leaves IslandRow's memo alone.
  const openMenu = useCallback((item: api.IslandSummary) => {
    setRenaming(false);
    setDraftTitle(item.title);
    setMenuItem(item);
  }, []);
  const openIsland = useCallback((item: api.IslandSummary, rect: CardRect) => {
    // The overlay pushes once it covers Home. The flying header shows the
    // line the player opens on: a long island resumes where it was left,
    // like the player itself.
    const lineCount = item.status === 'ready' ? item.line_count : 0;
    const saved = lineCount >= LONG_ISLAND ? (peekLastLine(item.id) ?? 0) : 0;
    const lineIndex = Math.max(0, Math.min(saved, lineCount - 1));
    startOpen(
      item.id,
      item.title || 'Untitled island',
      rect,
      () => {
        router.push({ pathname: '/island/[id]', params: { id: item.id, morph: '1' } });
      },
      { lineIndex, lineCount },
    );
  }, []);
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
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not reach the server');
    } finally {
      setLoading(false);
    }
  }, []);

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
    } catch (e) {
      removed.current.delete(id);
      if (restore) {
        setIslands((prev) => (prev.some((i) => i.id === id) ? prev : [...prev, restore]));
      }
      Alert.alert('Could not delete', e instanceof Error ? e.message : 'The server did not answer.');
    }
  }

  async function rename(id: string, title: string) {
    const finalTitle = title.trim() || 'Untitled island';
    try {
      await api.renameIsland(id, finalTitle);
      invalidateCachedIsland(id);
      setIslands((prev) => prev.map((i) => (i.id === id ? { ...i, title: finalTitle } : i)));
    } catch (e) {
      Alert.alert('Could not rename', e instanceof Error ? e.message : 'The server did not answer.');
    }
  }

  function openSearch() {
    setSearchOpen(true);
  }

  function closeSearch() {
    setSearchOpen(false);
    setQuery('');
  }

  function confirmDelete(item: api.IslandSummary) {
    Alert.alert(
      `Delete "${item.title || 'Untitled island'}"?`,
      'The recording, its lines and their audio are removed. This cannot be undone.',
      [
        { text: 'Cancel', style: 'cancel' },
        { text: 'Delete', style: 'destructive', onPress: () => void remove(item.id) },
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
      const tick = async () => {
        if (!alive) return;
        await load();
      };
      tick();
      void getPracticeLog().then((next) => {
        if (alive) setLog(next);
      });
      const timer = setInterval(tick, 3000);
      return () => {
        alive = false;
        clearInterval(timer);
      };
    }, [load]),
  );

  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    const filtered = q ? islands.filter((i) => i.title.toLowerCase().includes(q)) : islands;
    return [...filtered].sort((a, b) => {
      if (sort === 'least') {
        const diff = (log.islands[a.id]?.seconds ?? 0) - (log.islands[b.id]?.seconds ?? 0);
        if (diff !== 0) return diff;
      }
      // Newest first: the tie break above, and the "Newest" sort itself.
      return new Date(b.created_at).getTime() - new Date(a.created_at).getTime();
    });
  }, [islands, query, sort, log]);

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
        <Text style={[styles.empty, { color: tide.text }]}>
          Set EXPO_PUBLIC_SHADOW_API_URL and EXPO_PUBLIC_SHADOW_TOKEN in .env, then restart
          the dev server.
        </Text>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView edges={['bottom']} style={StyleSheet.flatten([styles.fill, { backgroundColor: sky.top }])}>
      <StatusBar style="light" />
      <Tabs.Screen
        options={{
          headerStyle: { backgroundColor: sky.top },
          headerTintColor: tide.text,
          headerShadowVisible: false,
          headerLeft: () => (
            <Animated.View style={searchButtonStyle} pointerEvents={searchOpen ? 'none' : 'auto'}>
              <PressScale onPress={openSearch} hitSlop={12} accessibilityLabel="Search islands">
                <SearchIcon color={tide.text} size={22} />
              </PressScale>
            </Animated.View>
          ),
        }}
      />
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
      <IslandSearch open={searchOpen} query={query} onChangeQuery={setQuery} onClose={closeSearch} grow={searchGrow} />
      <Animated.FlatList
        data={shown}
        keyExtractor={(item) => item.id}
        contentContainerStyle={styles.list}
        keyboardShouldPersistTaps="handled"
        itemLayoutAnimation={LinearTransition.duration(220)}
        refreshControl={
          <RefreshControl refreshing={loading} onRefresh={load} tintColor={tide.textDim} />
        }
        ListHeaderComponent={
          <View style={styles.header}>
            <PracticeCard log={log} />
            <Animated.View layout={LinearTransition.duration(200)} style={styles.sortRow}>
              {SORTS.map((s) => {
                const on = sort === s;
                return (
                  <Pressable
                    key={s}
                    onPress={() => setSort(s)}
                    style={[
                      styles.pill,
                      { backgroundColor: on ? tide.lang.ja : tide.water, borderColor: tide.waterline },
                    ]}>
                    <Text style={[styles.pillText, { color: on ? tide.sky[0] : tide.text }]}>
                      {SORT_LABEL[s]}
                    </Text>
                  </Pressable>
                );
              })}
            </Animated.View>
          </View>
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
                  : query.trim() && islands.length > 0
                    ? 'No island matches'
                    : 'No islands yet. Record a minute about your day and one gets built from it.'}
              </Text>
            </View>
          )
        }
        renderItem={({ item, index }) => {
          const busy = item.status === 'pending' || item.status === 'working';
          const minutes = minutesOn(log, item.id);
          const seconds = log.islands[item.id]?.seconds ?? 0;
          const fraction = Math.min(1, seconds / TIDE_TARGET_SECONDS);
          const meta = item.status === 'failed'
            ? 'Failed'
            : busy
              ? (api.STAGE_LABEL[item.stage] ?? 'Working…')
              : `${item.line_count} lines · ${item.complexity}${minutes >= 1 ? ` · ${minutes} min` : ''}`;
          const waveIndex = waveHome && !reducedMotion && index < WAVE_MAX_CARDS ? index : null;
          return (
            <IslandRow
              item={item}
              busy={busy}
              fraction={fraction}
              meta={meta}
              waveIndex={waveIndex}
              onOpen={openIsland}
              onMenu={openMenu}
            />
          );
        }}
      />
      <PressScale
        onPress={() => router.push('/record')}
        style={[styles.fab, { backgroundColor: tide.lang.ja }]}>
        <Text style={[styles.fabText, { color: tide.sky[0] }]}>+</Text>
      </PressScale>
      <BottomSheet
        open={menuItem !== null}
        onClose={() => setMenuItem(null)}
        onDismissed={runAfterSheet}
        title={menuItem?.title || 'Untitled island'}
        avoidKeyboard>
        {renaming ? (
          <>
            <TextInput
              autoFocus
              value={draftTitle}
              onChangeText={setDraftTitle}
              onSubmitEditing={saveRename}
              returnKeyType="done"
              style={styles.sheetInput}
            />
            <SheetAction label="Save" onPress={saveRename} />
          </>
        ) : (
          <>
            <SheetAction label="Rename" onPress={() => setRenaming(true)} />
            <SheetAction
              label="Delete island"
              destructive
              onPress={() => {
                const item = menuItem;
                if (!item) return;
                closeSheetThen(() => confirmDelete(item));
              }}
            />
          </>
        )}
      </BottomSheet>
    </SafeAreaView>
  );
}

type IslandRowProps = {
  item: api.IslandSummary;
  busy: boolean;
  fraction: number;
  meta: string;
  /** This card's place in the once-a-day Home wave, or `null` to appear
   * instantly: past the first `WAVE_MAX_CARDS` cards, outside the first
   * visit of the day, or with reduced motion on. */
  waveIndex: number | null;
  /** A plain tap: always opens the island, with the card's on-screen rect for
   * the morph into the player. */
  onOpen: (item: api.IslandSummary, rect: CardRect) => void;
  /** A held tap: opens the Rename/Delete sheet. */
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
const IslandRow = memo(function IslandRow({ item, busy, fraction, meta, waveIndex, onOpen, onMenu }: IslandRowProps) {
  const pressed = useSharedValue(0);
  const reducedMotion = useReducedMotion();
  const cardRef = useRef<View>(null);
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

  function handlePressIn() {
    longPressFired.current = false;
    // Most presses become an open: start reading the island now, so it is
    // parsed by the time the morph has covered the screen.
    if (!busy) {
      prewarmIsland(itemId);
      // Reads the saved lines file, so the open can show the resume line.
      void getLastLine(itemId);
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

  const animatedStyle = useAnimatedStyle(() => ({
    transform: [{ scale: reducedMotion ? 1 : 1 - pressed.value * 0.03 }],
    borderTopColor: interpolateColor(pressed.value, [0, 1], [tide.waterline, tide.lang.ja]),
  }));

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
    <AnimatedPressable
      ref={cardRef}
      disabled={busy}
      onPress={handlePress}
      onPressIn={handlePressIn}
      onPressOut={handlePressOut}
      onLongPress={handleLongPress}
      delayLongPress={LONG_PRESS_MS}
      entering={waveIndex !== null ? waveEntering(waveIndex * WAVE_STAGGER_MS) : undefined}
      exiting={FadeOut.duration(220)}
      onLayout={(e) => {
        rowWidth.value = e.nativeEvent.layout.width;
      }}
      style={[styles.row, animatedStyle]}>
      <View
        pointerEvents="none"
        style={[styles.rowFill, { width: `${fraction * 100}%`, backgroundColor: tide.lang.ja }]}
      />
      {busy ? (
        <Animated.View pointerEvents="none" style={[styles.sweepBand, sweepStyle]} />
      ) : null}
      <Animated.View pointerEvents="none" style={[styles.flashFill, { backgroundColor: tide.lang.ja }, flashFillStyle]} />
      <Animated.View pointerEvents="none" style={[styles.flashBorder, { borderColor: tide.lang.ja }, flashBorderStyle]} />
      <View style={styles.cardTop}>
        <Text numberOfLines={2} style={[styles.cardTitle, { color: tide.text, opacity: titleHidden ? 0 : 1 }]}>
          {item.title || 'Untitled island'}
        </Text>
      </View>
      <View style={styles.metaRow}>
        {busy ? <CatConstellation compact /> : null}
        <Text style={[styles.cardMeta, { color: tide.textDim }]}>{meta}</Text>
      </View>
    </AnimatedPressable>
  );
});

const styles = StyleSheet.create({
  fill: { flex: 1 },
  center: { alignItems: 'center', justifyContent: 'center', paddingTop: Spacing.xxl },
  list: { padding: Spacing.lg, paddingBottom: 170, gap: Spacing.md },
  empty: { fontSize: 15, lineHeight: 22, textAlign: 'center', paddingHorizontal: Spacing.xl, fontFamily: fonts.ui },
  row: { borderTopWidth: 1, borderTopColor: tide.waterline, paddingVertical: Spacing.md, gap: Spacing.xs, overflow: 'hidden' },
  rowFill: { position: 'absolute', left: 0, top: 0, bottom: 0, opacity: 0.16 },
  // Clipped by the row's own overflow:hidden, so it never spills past the card.
  sweepBand: {
    position: 'absolute',
    left: 0,
    top: -20,
    bottom: -20,
    backgroundColor: 'rgba(255,255,255,0.16)',
  },
  flashFill: { ...StyleSheet.absoluteFill },
  flashBorder: { ...StyleSheet.absoluteFill, borderWidth: 2 },
  cardTop: { flexDirection: 'row', alignItems: 'center', gap: Spacing.md },
  cardTitle: { flex: 1, fontSize: 17, fontWeight: '600', fontFamily: fonts.serifJp },
  // minHeight matches the compact constellation's canvas (44pt cat + 6pt
  // margin) so the row does not shift height when the island turns ready
  // and the constellation disappears.
  metaRow: { flexDirection: 'row', alignItems: 'center', gap: Spacing.xs, minHeight: 50 },
  cardMeta: { fontSize: 13, fontFamily: fonts.ui },
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
  header: { gap: Spacing.md, marginBottom: Spacing.md },
  sortRow: { flexDirection: 'row', gap: Spacing.sm },
  pill: { borderWidth: 1, borderRadius: Radius.pill, paddingVertical: Spacing.xs + 2, paddingHorizontal: Spacing.md },
  pillText: { fontSize: 13, fontWeight: '700', fontFamily: fonts.ui },
  star: {
    position: 'absolute',
    width: 2,
    height: 2,
    borderRadius: 1,
    backgroundColor: '#FFFFFF',
    zIndex: 0,
  },
  fab: {
    position: 'absolute',
    right: Spacing.lg,
    bottom: 96,
    width: 56,
    height: 56,
    borderRadius: Radius.pill,
    alignItems: 'center',
    justifyContent: 'center',
  },
  fabText: { fontSize: 28, fontWeight: '700', lineHeight: 32 },
});
