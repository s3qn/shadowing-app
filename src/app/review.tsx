import { Stack, useFocusEffect, useRouter } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { SymbolView } from 'expo-symbols';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AppState, type LayoutChangeEvent, Pressable, ScrollView, StyleSheet, Text, useWindowDimensions, View, type ViewStyle } from 'react-native';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import Animated, { Easing, FadeIn, FadeOut, type SharedValue, useAnimatedReaction, useAnimatedStyle, useSharedValue, withTiming } from 'react-native-reanimated';
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';
import { scheduleOnRN } from 'react-native-worklets';

import { CatConstellation } from '@/components/cat-constellation';
import { PrismButton } from '@/components/prism';
import { GlassPanel } from '@/components/prism/glass-panel';
import { PillTrayShell, useSlidingPill } from '@/components/prism/pill-tray';
import { GRAMMAR_LILAC, RubyWord } from '@/components/ruby-word';
import { BottomSheet } from '@/components/sheet/bottom-sheet';
import { SheetAction } from '@/components/sheet/sheet-rows';
import { HeroNumber } from '@/components/tide/hero-number';
import { LadderHelpButton, type Look, Tile } from '@/components/tide/ladder-stage';
import { fonts } from '@/constants/fonts';
import { Spacing, tide, verb } from '@/constants/theme';
import * as api from '@/lib/api';
import { getSessionPrefs, routeFor, setSessionPrefs, startSession } from '@/lib/auto-practice';
import { confirmSheet } from '@/lib/confirm-sheet';
import { getGuideStep, guidePracticeStarted, useGuideAnchor, useGuideLock, useGuideStep } from '@/lib/guide';
import { hapticImpact, hapticSelection } from '@/lib/haptics';
import { useDir, useT } from '@/lib/i18n';
import { kinsokuUnits } from '@/lib/kinsoku';
import { LADDER_PACING } from '@/lib/pass-programme';
import { getSettingsSync, SESSION_SIZES, sessionLanguage, type SessionSize, setSessionSize } from '@/lib/settings';

const SIZES = SESSION_SIZES;
const GOLD_FILL = 'rgba(255,200,87,0.13)';
const GOLD_RIM = 'rgba(255,200,87,0.42)';
const LINE_SCALE = 28 / 22;
const TRAY_TIMING = { timing: { duration: 240, easing: Easing.out(Easing.cubic) } };
const noop = () => {};
const ROW_H = 56;
const MORE_H = 32;
const NOTE_H = 28;
const ELLIPSIS_W = 30;
// Same cap as MAX_EDIT_PROJECTS in backend/review_session.py.
const MAX_PROJECTS = 8;
const ADD_DEFAULT = 3;
const UNDO_MS = 4000;
const LIFT_MS = 160;
const SLIDE = { duration: 180, easing: Easing.out(Easing.cubic) };
// Swipe to remove: the red action's width, and how far past it a release still opens it.
const ACTION_W = 72;
const REMOVE_RED = '#FF5C5C';
// The lifted row's shadow: the theme's `0 6 16 rgba(0,0,0,0.32)`.
const LIFT_SHADOW = { shadowColor: '#000', shadowOffset: { width: 0, height: 6 }, shadowRadius: 8 } as const;
const LIFT_OPACITY = 0.32;

const EMOJI: Record<api.SessionKind, string> = { podcast: '🎧', video: '🎬', island: '🏝️' };
const KIND_KEY = { podcast: 'review.kindPodcast', video: 'review.kindVideo', island: 'review.kindIsland' } as const;
const LOOK: Record<api.SessionKind, Look> = {
  podcast: { tint: GRAMMAR_LILAC, from: 0.4, to: 0.12, rim: 0.55 },
  video: { tint: verb.listen.c1, from: 0.4, to: 0.12, rim: 0.55 },
  island: { tint: verb.read.c1, from: 0.4, to: 0.12, rim: 0.55 },
};
const READY: Look = { tint: verb.listen.c2, from: 0.38, to: 0.12, rim: 0.5 };
const BAR: Record<api.SessionKind, string> = { podcast: GRAMMAR_LILAC, video: verb.listen.c1, island: verb.read.c1 };

const picksOf = (ps: api.SessionProject[]): api.SessionPick[] => ps.map((p) => ({ island_id: p.island_id, count: p.picked.length }));
/** Grows or trims a picked list to `n` until the server's answer replaces it (-1 holds a place). */
const resize = (picked: number[], n: number) => (n <= picked.length ? picked.slice(0, n) : [...picked, ...Array<number>(n - picked.length).fill(-1)]);
const liftHaptic = () => void hapticImpact();
const dropHaptic = () => void hapticSelection();

/** One saved line, one island or one podcast at a time: the session's start screen. Practice now plays the plan through the existing players. */
export default function ReviewScreen() {
  const { t } = useT();
  const dir = useDir();
  const router = useRouter();
  const insets = useSafeAreaInsets();
  // The first-run guide aims for 5, so 5 is chosen up front and the plan does not change under its bubble.
  const [size, setSize] = useState<number>(() => (getGuideStep() === 'size' ? 5 : getSettingsSync().sessionSize));
  const guideSize = useGuideStep() === 'size';
  useGuideLock(guideSize); // bl57-intro-round2
  // The guide lights 5 until it is tapped, then Practice now.
  const [fiveTapped, setFiveTapped] = useState(false);
  const practiceBtn = useGuideAnchor('practiceNow', guideSize && fiveTapped);
  const [plan, setPlan] = useState<api.SessionPlan | null>(null);
  // The learner's own plan once they reorder, change a count, remove or add. Null plays the planner's pick for `size`.
  const [edit, setEdit] = useState<api.SessionPick[] | null>(null);
  const [edited, setEdited] = useState(true);
  const [sheetP, setSheetP] = useState<api.SessionProject | null>(null);
  const [sheetOpen, setSheetOpen] = useState(false);
  const [sheetCount, setSheetCount] = useState(1);
  const [adding, setAdding] = useState(false);
  const [catalogue, setCatalogue] = useState<api.SessionCatalogueItem[] | null>(null);
  const [undo, setUndo] = useState<{ index: number; project: api.SessionProject } | null>(null);
  const [loadError, setLoadError] = useState('');
  const retryAnchor = useGuideAnchor('sizeRetry', guideSize && !!plan && plan.count === 0 && !!loadError);
  const [starting, setStarting] = useState(false);
  const [count, setCount] = useState(0);
  // The picker never scrolls: rows that do not fit between the mix bar and Up first fold into a "+N more" line.
  const [fit, setFit] = useState<{ avail: number | null; top: number | null; up: number | null }>({ avail: null, top: null, up: null });
  const measure = (key: 'avail' | 'top' | 'up') => (e: LayoutChangeEvent) => {
    const h = e.nativeEvent.layout.height;
    setFit((f) => (f[key] === h ? f : { ...f, [key]: h }));
  };
  // Mock gaps at 844 high, down to 45% of them at 667.
  const winH = useWindowDimensions().height;
  const k = Math.min(1, Math.max(0.45, 0.45 + (0.55 * (winH - 667)) / (844 - 667)));
  const gap = (n: number) => Math.round(n * k);
  const sizeRef = useRef(size);
  sizeRef.current = size;
  // Only the newest request may land: a size tap or an edit supersedes the one before.
  const seq = useRef(0);
  // The row whose Remove action is showing, or ''. Any touch on the screen closes it, except one on the action itself.
  const openId = useSharedValue('');
  const closeTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const closeSoon = () => {
    if (!openId.value) return false;
    clearTimeout(closeTimer.current);
    closeTimer.current = setTimeout(() => {
      openId.value = '';
    }, 0);
    return false;
  };
  const keepOpen = () => clearTimeout(closeTimer.current);
  useEffect(() => () => clearTimeout(closeTimer.current), []);

  /** `soft`: an edit's refresh. On failure it keeps the edited plan on screen instead of the error page. */
  const load = useCallback(
    (n: number, shape: api.SessionShape, soft = false) => {
      const mine = ++seq.current;
      api
        .getSessionPlan(n, { ...shape, language: sessionLanguage() })
        .then((p) => {
          if (seq.current !== mine) return;
          setLoadError('');
          setPlan(p);
        })
        .catch((e) => {
          if (seq.current !== mine || soft) return;
          setLoadError(e instanceof Error ? e.message : t('review.loadFailed'));
          setPlan({ session_id: null, size: n, count: 0, minutes: 0, seconds_per_sentence: 0, projects: [], first: null });
        });
    },
    [t],
  );
  const loadDefault = useCallback((n: number) => void getSessionPrefs().then((pr) => load(n, { order: pr.order })), [load]);

  useFocusEffect(
    useCallback(() => {
      setCount(0);
      setStarting(false);
      setEdit(null);
      setUndo(null);
      void getSessionPrefs().then((pr) => setEdited(pr.edited));
      loadDefault(sizeRef.current);
      api
        .getSessionCatalogue(sessionLanguage())
        .then(setCatalogue)
        .catch(() => setCatalogue([]));
      return () => {
        seq.current++;
      };
    }, [loadDefault]),
  );

  // A failed load retries itself every few seconds and when the app comes back to the front, so it recovers once the network returns.
  useEffect(() => {
    if (!loadError) return;
    const again = () => loadDefault(sizeRef.current);
    const id = setInterval(again, 5000);
    const sub = AppState.addEventListener('change', (next) => next === 'active' && again());
    return () => {
      clearInterval(id);
      sub.remove();
    };
  }, [loadError, loadDefault]);

  useEffect(() => {
    if (!undo) return;
    const id = setTimeout(() => setUndo(null), UNDO_MS);
    return () => clearTimeout(id);
  }, [undo]);

  const pick = (n: number) => {
    if (starting) return;
    if (guideSize) setFiveTapped(n === 5);
    if (n === lit && !guideSize) return;
    void hapticSelection();
    if (n === lit) return;
    setSize(n);
    sizeRef.current = n;
    void setSessionSize(n as SessionSize);
    setEdit(null);
    setUndo(null);
    loadDefault(n);
  };

  /** Shows `next` at once (counts, total, minutes), then asks the planner for its lines. `from` holds every project `next` may name. */
  const commit = (next: api.SessionPick[], from: api.SessionProject[]) => {
    const byId = new Map(from.map((p) => [p.island_id, p]));
    const projects = next.flatMap((pk) => {
      const p = byId.get(pk.island_id);
      return p ? [{ ...p, picked: resize(p.picked, pk.count) }] : [];
    });
    const n = projects.reduce((sum, p) => sum + p.picked.length, 0);
    setPlan((cur) => cur && { ...cur, projects, count: n, size: n, minutes: n ? Math.max(1, Math.round((n * cur.seconds_per_sentence) / 60)) : 0 });
    setEdit(next);
    if (!edited) {
      setEdited(true);
      setSessionPrefs({ edited: true });
    }
    load(sizeRef.current, { projects: next }, true);
  };

  const practice = async () => {
    if (!plan || starting || plan.count === 0) return;
    setStarting(true);
    try {
      const started = await api.startSession(size, { ...(edit ? { projects: edit } : { order: plan.projects.map((p) => p.island_id) }), language: sessionLanguage() });
      setPlan(started);
      setCount(3);
      if (guideSize) guidePracticeStarted();
    } catch (e) {
      setStarting(false);
      void confirmSheet({ title: e instanceof Error ? e.message : t('review.loadFailed'), actions: [{ label: t('common.ok'), verb: 'tools' }] });
    }
  };

  // The count-in: 3, 2, 1 at the ladder's beat, then the first player opens.
  useEffect(() => {
    if (count === 0 || !plan) return;
    void hapticSelection();
    const id = setTimeout(() => {
      if (count > 1) return setCount(count - 1);
      const first = plan.projects[0];
      if (!first) return;
      startSession(plan);
      router.push(routeFor(first.island_id, first.kind));
    }, LADDER_PACING[getSettingsSync().ladderPace].beatMs);
    return () => clearTimeout(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [count]);

  const help = () => void confirmSheet({ title: t('review.helpTitle'), message: t('review.helpBody'), actions: [{ label: t('common.ok'), verb: 'tools' }] });

  const header = (
    <Stack.Screen
      options={{
        headerTitle: () => (
          <View style={styles.headTitle}>
            <Text style={[styles.headMain, dir.writing]}>{t('review.title')}</Text>
            <Text style={[styles.headSub, dir.writing]}>{t('review.subtitle')}</Text>
          </View>
        ),
        headerRight: () => (
          <View style={{ marginEnd: 12 }}>
            <LadderHelpButton onPress={help} />
          </View>
        ),
      }}
    />
  );

  if (!plan) {
    return (
      <SafeAreaView edges={['bottom']} style={[styles.fill, { backgroundColor: tide.sky[0] }]}>
        <StatusBar style="light" />
        {header}
        <View style={styles.center}>
          <CatConstellation size={120} />
        </View>
      </SafeAreaView>
    );
  }

  if (plan.count === 0) {
    return (
      <SafeAreaView edges={['bottom']} style={[styles.fill, { backgroundColor: tide.sky[0] }]}>
        <StatusBar style="light" />
        {header}
        <View style={styles.center}>
          {loadError ? (
            <>
              <Text style={[styles.hint, dir.writing]}>{loadError}</Text>
              <View ref={retryAnchor.ref} onLayout={retryAnchor.onLayout} collapsable={false}>
                <PrismButton shape="pill" verb="listen" label={t('common.retry')} onPress={() => loadDefault(sizeRef.current)} />
              </View>
            </>
          ) : (
            <>
              <Text style={[styles.emptyTitle, dir.writing]}>{t('review.emptyTitle')}</Text>
              <Text style={[styles.hint, dir.writing]}>{t('review.emptyHint')}</Text>
              <PrismButton shape="pill" verb="listen" label={t('review.openPodcasts')} onPress={() => router.navigate('/podcast')} />
            </>
          )}
        </View>
      </SafeAreaView>
    );
  }

  const meta = { min: plan.minutes };
  const counting = count > 0;
  const total = plan.projects.length;
  const canAdd = total < MAX_PROJECTS;
  const note = undo ? 'undo' : !edited ? 'hint' : null;
  const fitReady = fit.avail !== null && fit.top !== null && fit.up !== null;
  const space = fitReady ? fit.avail! - gap(24) - fit.top! - gap(14) - fit.up! - gap(14) - (canAdd ? ROW_H : 0) - (note ? NOTE_H : 0) : Infinity;
  const shown = total * ROW_H <= space ? total : Math.max(0, Math.floor((space - MORE_H) / ROW_H));
  const more = total - shown;
  const lit = edit ? ((SIZES as readonly number[]).includes(plan.count) ? plan.count : null) : size;
  const inPlan = new Set(plan.projects.map((p) => p.island_id));
  const addable = (catalogue ?? []).filter((c) => !inPlan.has(c.island_id) && c.total > 0);

  const reorder = (ids: string[]) => {
    const full = [...ids, ...plan.projects.slice(ids.length).map((p) => p.island_id)];
    if (full.every((id, i) => id === plan.projects[i]?.island_id)) return;
    const byId = new Map(plan.projects.map((p) => [p.island_id, p]));
    const next = full.flatMap((id) => (byId.has(id) ? [byId.get(id)!] : []));
    setSessionPrefs({ order: full });
    commit(picksOf(next), plan.projects);
  };
  const openRow = (id: string) => {
    const p = plan.projects.find((x) => x.island_id === id);
    if (!p || starting) return;
    setSheetP(p);
    setSheetCount(Math.max(1, p.picked.length));
    setSheetOpen(true);
  };
  const closeSheet = () => {
    setSheetOpen(false);
    const p = sheetP && plan.projects.find((x) => x.island_id === sheetP.island_id);
    if (!p || sheetCount === p.picked.length) return;
    commit(
      picksOf(plan.projects).map((pk) => (pk.island_id === p.island_id ? { ...pk, count: sheetCount } : pk)),
      plan.projects,
    );
  };
  const removeId = (id: string | undefined) => {
    setSheetOpen(false);
    const index = id ? plan.projects.findIndex((x) => x.island_id === id) : -1;
    if (index < 0 || total <= 1) return;
    setUndo({ index, project: plan.projects[index]! });
    commit(picksOf(plan.projects.filter((_, i) => i !== index)), plan.projects);
  };
  const remove = () => removeId(sheetP?.island_id);
  const restore = () => {
    if (!undo || !canAdd) return setUndo(null);
    const picks = picksOf(plan.projects).filter((pk) => pk.island_id !== undo.project.island_id);
    picks.splice(Math.min(undo.index, picks.length), 0, { island_id: undo.project.island_id, count: undo.project.picked.length });
    setUndo(null);
    commit(picks, [...plan.projects, undo.project]);
  };
  const add = (item: api.SessionCatalogueItem) => {
    setAdding(false);
    if (!canAdd) return;
    const project: api.SessionProject = { ...item, picked: [] };
    commit([...picksOf(plan.projects), { island_id: item.island_id, count: Math.min(ADD_DEFAULT, item.total) }], [...plan.projects, project]);
  };

  return (
    <View style={[styles.fill, { backgroundColor: tide.sky[0] }]}>
      <StatusBar style="light" />
      {header}
      {counting ? (
        // Out, then in: the count screen starts as the pick screen's 150ms fade nears its end, and is under 0.3 until that is gone.
        <Animated.View key="count" entering={FadeIn.delay(80).duration(250)} style={styles.fill}>
          <ScrollView contentContainerStyle={styles.countBody} scrollEnabled={false}>
            <UpFirst plan={plan} roomy />
            <Text style={[styles.label, dir.text, { marginTop: 24, marginBottom: 6 }]}>{t('review.then')}</Text>
            {plan.projects.map((p) => (
              <ProjectRow key={p.island_id} p={p} dirRow={dir.row} withTotal={false} />
            ))}
          </ScrollView>
          <View style={[styles.countFoot, { paddingBottom: insets.bottom + 36 }]}>
            <Text style={[styles.sessionMeta, dir.writing]}>{t('review.sessionMeta', { n: plan.count, ...meta })}</Text>
            <Tile look={READY} size={96} radius={48} fontSize={48}>
              {count}
            </Tile>
          </View>
        </Animated.View>
      ) : (
        <Animated.View key="pick" exiting={FadeOut.duration(150)} style={styles.fill} onStartShouldSetResponderCapture={closeSoon}>
          <View style={[styles.body, { paddingTop: gap(24) }]} onLayout={measure('avail')}>
            <View onLayout={measure('top')}>
              <SizeTray lit={lit} onPick={pick} guide={guideSize} />
              <View style={{ marginTop: gap(28) }}>
                <HeroNumber value={plan.count} />
                <Text style={[styles.heroMeta, dir.text]}>{t('review.heroMeta', { ...meta, n: plan.count })}</Text>
              </View>
              <View style={[styles.mix, dir.row, { marginTop: gap(26) }]}>
                {plan.projects.map((p) => (
                  <View key={p.island_id} style={{ flex: Math.max(p.picked.length, 1), backgroundColor: BAR[p.kind] }} />
                ))}
              </View>
            </View>
            <View style={{ marginTop: gap(14), opacity: fitReady ? 1 : 0 }}>
              <DragRows
                key={plan.projects.slice(0, shown).map((p) => p.island_id).join(',')}
                items={plan.projects.slice(0, shown)}
                enabled={!starting}
                dirRow={dir.row}
                rtl={dir.rtl}
                openId={openId}
                keepOpen={keepOpen}
                onOrder={reorder}
                onTap={openRow}
                onRemove={removeId}
              />
              {more > 0 ? (
                <Text style={[styles.more, dir.text]} numberOfLines={1}>
                  {t('review.moreProjects', { n: more })}
                </Text>
              ) : null}
              {canAdd ? (
                <Pressable onPress={() => !starting && setAdding(true)} accessibilityRole="button" style={({ pressed }) => [styles.row, dir.row, pressed && styles.pressed]}>
                  <Tile look={READY} size={40} radius={12} fontSize={22}>
                    +
                  </Tile>
                  <Text style={[styles.rowKind, styles.rowText, dir.text]}>{t('review.addFrom')}</Text>
                </Pressable>
              ) : null}
              {note === 'undo' && undo ? (
                <Pressable onPress={restore} accessibilityRole="button" style={[styles.note, dir.row]}>
                  <Text style={[styles.noteText, styles.rowText, dir.text]} numberOfLines={1}>
                    {t('review.removed', { title: undo.project.title })}
                  </Text>
                  <Text style={styles.undo}>{t('review.undo')}</Text>
                </Pressable>
              ) : note === 'hint' ? (
                <Text style={[styles.note, styles.noteText, dir.text]} numberOfLines={1}>
                  {t('review.editHint')}
                </Text>
              ) : null}
            </View>
            <View style={{ marginTop: gap(14), opacity: fitReady ? 1 : 0 }} onLayout={measure('up')}>
              <UpFirst plan={plan} />
            </View>
          </View>
          <View style={[styles.cta, { paddingBottom: Math.max(insets.bottom + 2, 20) }]}>
            <View ref={practiceBtn.ref} onLayout={practiceBtn.onLayout}>
              <PrismButton shape="pill" verb="read" height={58} label={t('review.practiceNow')} disabled={starting} onPress={practice}>
                <SymbolView name={{ ios: 'play.fill', android: 'play_arrow' }} size={16} weight="regular" tintColor={verb.read.c1} />
              </PrismButton>
            </View>
          </View>
        </Animated.View>
      )}
      <BottomSheet open={sheetOpen} onClose={closeSheet} title={sheetP?.title} contentTitle>
        {sheetP ? (
          <>
            <View style={[styles.stepper, dir.row]}>
              <PrismButton shape="round" size={48} verb="read" disabled={sheetCount <= 1} onPress={() => setSheetCount((c) => Math.max(1, c - 1))} accessibilityLabel={t('review.fewer')}>
                <SymbolView name={{ ios: 'minus', android: 'remove' }} size={20} weight="semibold" tintColor={verb.read.c1} />
              </PrismButton>
              <View style={styles.stepMid}>
                <Text style={styles.stepN}>{sheetCount}</Text>
                <Text style={styles.rowOf}>{t('review.ofTotal', { n: sheetP.total })}</Text>
              </View>
              <PrismButton shape="round" size={48} verb="read" disabled={sheetCount >= sheetP.total} onPress={() => setSheetCount((c) => Math.min(sheetP.total, c + 1))} accessibilityLabel={t('review.more')}>
                <SymbolView name={{ ios: 'plus', android: 'add' }} size={20} weight="semibold" tintColor={verb.read.c1} />
              </PrismButton>
            </View>
            <SheetAction destructive disabled={total <= 1} icon={{ ios: 'trash', android: 'delete' }} label={t('review.remove')} onPress={remove} />
            <View style={styles.sheetDone}>
              <PrismButton shape="pill" verb="read" label={t('review.done')} onPress={closeSheet} />
            </View>
          </>
        ) : null}
      </BottomSheet>
      <BottomSheet open={adding} onClose={() => setAdding(false)} title={t('review.addTitle')}>
        {catalogue === null ? (
          <View style={styles.sheetLoad}>
            <CatConstellation size={80} />
          </View>
        ) : addable.length === 0 ? (
          <Text style={[styles.hint, dir.writing]}>{t('review.addEmpty')}</Text>
        ) : (
          <ScrollView style={{ maxHeight: winH * 0.5 }}>
            {addable.map((item) => (
              <Pressable key={item.island_id} onPress={() => add(item)} accessibilityRole="button" style={({ pressed }) => pressed && styles.pressed}>
                <ProjectRow p={{ ...item, picked: [] }} dirRow={dir.row} withTotal={false} n={item.total} />
              </Pressable>
            ))}
          </ScrollView>
        )}
      </BottomSheet>
    </View>
  );
}

/** The 5 / 10 / 20 / 30 tray: one lit gold pill that slides under the chosen size (timing, no spring). It fades out while an edited plan matches no size. */
function SizeTray({ lit: chosen, onPick, guide }: { lit: number | null; onPick: (n: number) => void; guide: boolean }) {
  const dir = useDir();
  const tray = useGuideAnchor('sizeTray', guide);
  const five = useGuideAnchor('size5', guide);
  const [lay, setLay] = useState<Array<{ x: number; width: number } | undefined>>([]);
  const at = chosen === null ? -1 : SIZES.indexOf(chosen as SessionSize);
  const { translateX, width } = useSlidingPill(at >= 0 ? lay[at] : undefined, TRAY_TIMING);
  const on = useSharedValue(at >= 0 ? 1 : 0);
  useEffect(() => {
    on.value = withTiming(at >= 0 ? 1 : 0, TRAY_TIMING.timing);
  }, [at, on]);
  const lit = useAnimatedStyle(() => ({ width: width.value, opacity: on.value, transform: [{ translateX: translateX.value }] }));
  const measured = (i: number, e: LayoutChangeEvent) => {
    const { x: lx, width } = e.nativeEvent.layout;
    setLay((cur) => {
      const next = [...cur];
      next[i] = { x: lx, width };
      return next;
    });
  };
  return (
    <PillTrayShell style={styles.tray}>
      <View ref={tray.ref} onLayout={tray.onLayout} style={[styles.trayRow, dir.row]}>
        <Animated.View pointerEvents="none" style={[styles.lit, lit]} />
        {SIZES.map((n, i) => (
          <Pressable key={n} ref={n === 5 ? five.ref : undefined} style={styles.trayPill} onLayout={(e) => { measured(i, e); if (n === 5) five.onLayout(); }} onPress={() => onPick(n)} accessibilityRole="button" accessibilityState={{ selected: n === chosen }}>
            <Text style={[styles.trayText, n === chosen && { color: verb.read.c1 }]}>{n}</Text>
          </Pressable>
        ))}
      </View>
    </PillTrayShell>
  );
}

type DragProps = {
  items: api.SessionProject[];
  enabled: boolean;
  dirRow: ViewStyle | undefined;
  rtl: boolean;
  openId: SharedValue<string>;
  keepOpen: () => void;
  onOrder: (ids: string[]) => void;
  onTap: (id: string) => void;
  onRemove: (id: string) => void;
};

/** The project rows: tap one to change it, hold one (350ms) or its grip to lift it and drag it up or down, swipe it toward the leading edge to show Remove. The order lives in `order` on the UI thread until the drop. */
function DragRows({ items, ...rest }: DragProps) {
  const order = useSharedValue<string[]>(items.map((p) => p.island_id));
  const active = useSharedValue('');
  return (
    <View style={{ height: items.length * ROW_H }}>
      {items.map((p, i) => (
        <DragRow key={p.island_id} p={p} slot={i} rows={items.length} order={order} active={active} canRemove={items.length > 1} {...rest} />
      ))}
    </View>
  );
}

type RowProps = Omit<DragProps, 'items'> & { canRemove: boolean; p: api.SessionProject; slot: number; rows: number; order: SharedValue<string[]>; active: SharedValue<string> };

function DragRow({ p, slot, rows, order, active, enabled, dirRow, rtl, openId, keepOpen, onOrder, onTap, onRemove, canRemove }: RowProps) {
  const { t } = useT();
  const id = p.island_id;
  const maxY = Math.max(0, (rows - 1) * ROW_H);
  const top = useSharedValue(slot * ROW_H);
  const from = useSharedValue(0);
  const lift = useSharedValue(0);
  // Swipe: `shift` is how far the row has moved toward the leading edge (0 closed, ACTION_W open), `rowW` its measured width.
  const shift = useSharedValue(0);
  const shiftFrom = useSharedValue(0);
  const rowW = useSharedValue(0);
  const wasOpen = useSharedValue(false);
  const lead = rtl ? 1 : -1;
  // Another row moved past this one: slide to the new slot.
  useAnimatedReaction(
    () => order.value.indexOf(id),
    (now, prev) => {
      if (prev === null || now === prev || now < 0 || active.value === id) return;
      top.value = withTiming(now * ROW_H, SLIDE);
    },
  );
  // Another row opened, or a touch elsewhere closed this one.
  useAnimatedReaction(
    () => openId.value,
    (now) => {
      if (now !== id && shift.value !== 0) shift.value = withTiming(0, SLIDE);
    },
  );
  // `order`, `active` and `openId` are shared values from the screen, written on the UI thread; the react-compiler rule reads that as prop mutation.
  /* eslint-disable react-hooks/immutability */
  const makePan = (grip: boolean) => {
    const g = Gesture.Pan().enabled(enabled);
    return (grip ? g.minDistance(0) : g.activateAfterLongPress(350))
    .onStart(() => {
      openId.value = '';
      active.value = id;
      from.value = top.value;
      lift.value = withTiming(1, { duration: LIFT_MS });
      scheduleOnRN(liftHaptic);
    })
    .onUpdate((e) => {
      if (active.value !== id) return;
      const dy = Number.isFinite(e.translationY) ? e.translationY : 0;
      const y = Math.min(maxY, Math.max(0, from.value + dy));
      top.value = y;
      const to = Math.min(rows - 1, Math.max(0, Math.round(y / ROW_H)));
      const cur = order.value.indexOf(id);
      if (cur < 0 || to === cur) return;
      const next = order.value.slice();
      next.splice(cur, 1);
      next.splice(to, 0, id);
      order.value = next;
    })
    .onFinalize(() => {
      if (active.value !== id) return;
      const ids = order.value.slice();
      lift.value = withTiming(0, { duration: LIFT_MS });
      scheduleOnRN(dropHaptic);
      top.value = withTiming(Math.max(0, ids.indexOf(id)) * ROW_H, { duration: LIFT_MS }, () => {
        if (active.value === id) active.value = '';
        scheduleOnRN(onOrder, ids);
      });
    });
  };
  const pan = makePan(false);
  const gripPan = makePan(true);
  const swipe = Gesture.Pan()
    .enabled(enabled && canRemove)
    .activeOffsetX([-12, 12])
    .failOffsetY([-10, 10])
    .onStart(() => {
      openId.value = id;
      shiftFrom.value = shift.value;
    })
    .onUpdate((e) => {
      const dx = Number.isFinite(e.translationX) ? e.translationX : 0;
      const w = rowW.value > 0 ? rowW.value : ACTION_W;
      shift.value = Math.min(w, Math.max(0, shiftFrom.value + dx * lead));
    })
    .onEnd((e) => {
      const v = Number.isFinite(e.velocityX) ? e.velocityX * lead : 0;
      const w = rowW.value > 0 ? rowW.value : ACTION_W * 2;
      const s = Number.isFinite(shift.value) ? shift.value : 0;
      if (s > w * 0.5) {
        shift.value = withTiming(w, SLIDE, (done) => {
          if (done) scheduleOnRN(onRemove, id);
        });
      } else if (s > ACTION_W / 2 || v > 300) {
        shift.value = withTiming(ACTION_W, SLIDE);
      } else {
        shift.value = withTiming(0, SLIDE);
        if (openId.value === id) openId.value = '';
      }
    });
  const removeNow = () => {
    if (!enabled) return;
    openId.value = '';
    onRemove(id);
  };
  /* eslint-enable react-hooks/immutability */
  const tap = Gesture.Tap()
    .enabled(enabled)
    .onBegin(() => {
      wasOpen.value = shift.value > 0.5;
    })
    .onEnd((_e, ok) => {
      // A tap on an open row only closes it.
      if (ok && !wasOpen.value) scheduleOnRN(onTap, id);
    });
  const style = useAnimatedStyle(() => {
    const l = Number.isFinite(lift.value) ? lift.value : 0;
    const y = Number.isFinite(top.value) ? top.value : 0;
    return { zIndex: active.value === id ? 2 : 1, shadowOpacity: LIFT_OPACITY * l, transform: [{ translateY: y }, { scale: 1 + 0.03 * l }] };
  });
  const slide = useAnimatedStyle(() => {
    const x = Number.isFinite(shift.value) ? shift.value : 0;
    return { transform: [{ translateX: x * lead }] };
  });
  const reveal = useAnimatedStyle(() => {
    const x = Number.isFinite(shift.value) ? shift.value : 0;
    return { width: Math.max(0, x) };
  });
  return (
    <Animated.View style={[styles.dragRow, LIFT_SHADOW, style]} onLayout={(e) => {
        rowW.value = e.nativeEvent.layout.width;
      }}>
      {canRemove ? (
        <Animated.View style={[styles.action, rtl ? { left: 0 } : { right: 0 }, reveal]}>
          <Pressable onPressIn={keepOpen} onPress={removeNow} accessibilityRole="button" accessibilityLabel={t('review.remove')} style={[styles.actionPress, { alignItems: rtl ? 'flex-end' : 'flex-start' }]}>
            <View style={styles.actionLabel}>
              <Text style={styles.actionText} numberOfLines={1}>
                {t('review.swipeRemove')}
              </Text>
            </View>
          </Pressable>
        </Animated.View>
      ) : null}
      <Animated.View style={[styles.row, dirRow, slide]}>
        <GestureDetector gesture={Gesture.Race(swipe, Gesture.Exclusive(pan, tap))}>
          <View style={styles.rowText} accessibilityRole="button">
            <ProjectRow p={p} dirRow={dirRow} withTotal />
          </View>
        </GestureDetector>
        <GestureDetector gesture={gripPan}>
          <View style={styles.grip} accessibilityLabel={t('review.reorder')}>
            {[0, 1, 2].map((r) => (
              <View key={r} style={styles.gripRow}>
                <View style={styles.gripDot} />
                <View style={styles.gripDot} />
              </View>
            ))}
          </View>
        </GestureDetector>
      </Animated.View>
    </Animated.View>
  );
}

/** One project: its tile, kind and title, and the lines it plays (`n` overrides the count, the Add list shows all its lines). */
function ProjectRow({ p, dirRow, withTotal, n }: { p: api.SessionProject; dirRow: ViewStyle | undefined; withTotal: boolean; n?: number }) {
  const { t } = useT();
  const dir = useDir();
  return (
    <View style={[styles.row, dirRow]}>
      <Tile look={LOOK[p.kind]} size={40} radius={12} fontSize={20}>
        {EMOJI[p.kind]}
      </Tile>
      <View style={styles.rowText}>
        <Text style={[styles.rowKind, dir.text]}>{t(KIND_KEY[p.kind])}</Text>
        <Text style={[styles.rowTitle, dir.content]} numberOfLines={1}>
          {p.title}
        </Text>
      </View>
      <Text style={[styles.rowCount, dir.writing]}>
        {n ?? p.picked.length}
        {withTotal ? <Text style={styles.rowOf}>{` ${t('review.ofTotal', { n: p.total })}`}</Text> : null}
      </Text>
    </View>
  );
}

/** The first line of the session as the ladder shows it: furigana over the kanji at 28pt. */
function UpFirst({ plan, roomy = false }: { plan: api.SessionPlan; roomy?: boolean }) {
  const { t } = useT();
  const dir = useDir();
  const first = plan.first;
  const project = first ? plan.projects.find((p) => p.island_id === first.island_id) : undefined;
  const units = useMemo(() => (first ? kinsokuUnits(first.words) : []), [first]);
  // The picker shows the line on one row: units past the edge hide and an ellipsis takes their place.
  const [lineW, setLineW] = useState(0);
  const [ends, setEnds] = useState<number[]>([]);
  useEffect(() => setEnds([]), [first]);
  let cut = units.length;
  if (!roomy && lineW > 0) {
    const over = ends.findIndex((e) => e > lineW);
    if (over >= 0) {
      cut = over;
      while (cut > 0 && (ends[cut - 1] ?? 0) > lineW - ELLIPSIS_W) cut--;
    }
  }
  const setEnd = (i: number, e: LayoutChangeEvent) => {
    const end = e.nativeEvent.layout.x + e.nativeEvent.layout.width;
    setEnds((cur) => {
      if (cur[i] === end) return cur;
      const next = [...cur];
      next[i] = end;
      return next;
    });
  };
  if (!first || !project) return null;
  return (
    <View>
      <Text style={[styles.label, dir.text, roomy && { marginBottom: 10 }]}>{t('review.upFirst')}</Text>
      <GlassPanel radius={24} style={roomy ? styles.upCardRoomy : styles.upCard}>
        <View style={[styles.upHead, dir.row, roomy && { marginBottom: 6 }]}>
          <Tile look={LOOK[project.kind]} size={roomy ? 36 : 32} radius={roomy ? 11 : 10} fontSize={roomy ? 17 : 16}>
            {EMOJI[project.kind]}
          </Tile>
          <Text style={[styles.upTitle, dir.content]} numberOfLines={1}>
            {project.title}
          </Text>
        </View>
        {first.words.length > 0 ? (
          <View style={roomy ? styles.units : styles.oneLine} onLayout={roomy ? undefined : (e) => setLineW(e.nativeEvent.layout.width)}>
            {units.map((unit, i) => (
              <View key={unit[0]} style={[styles.unit, i >= cut && styles.hidden]} onLayout={roomy ? undefined : (e) => setEnd(i, e)}>
                {unit.map((wi) => (
                  <RubyWord key={wi} word={first.words[wi]!} showRuby index={wi} selected={false} onLayout={noop} showPosAndRomaji={false} scale={LINE_SCALE} />
                ))}
              </View>
            ))}
            {cut < units.length ? <Text style={[styles.ellipsis, { left: ends[cut - 1] ?? 0 }]}>…</Text> : null}
          </View>
        ) : (
          <Text style={styles.plain} numberOfLines={roomy ? undefined : 1}>
            {first.ja}
          </Text>
        )}
        {first.en ? (
          <Text style={[styles.en, dir.content, { marginTop: roomy ? 2 : 0 }]} numberOfLines={roomy ? undefined : 1}>
            {first.en}
          </Text>
        ) : null}
      </GlassPanel>
    </View>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1 },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: Spacing.lg, paddingHorizontal: 16 },
  emptyTitle: { fontSize: 20, fontWeight: '700', color: tide.text, fontFamily: fonts.ui, textAlign: 'center' },
  hint: { fontSize: 14, lineHeight: 20, color: tide.textDim, fontFamily: fonts.ui, textAlign: 'center' },
  headTitle: { alignItems: 'center' },
  headMain: { fontSize: 15, fontWeight: '600', color: tide.text, fontFamily: fonts.ui },
  headSub: { fontSize: 11.5, color: tide.textDim, fontFamily: fonts.ui },
  body: { flex: 1, paddingHorizontal: 20, overflow: 'hidden' },
  tray: { height: 60, padding: 5, borderRadius: 30 },
  trayRow: { flex: 1, flexDirection: 'row' },
  trayPill: { flex: 1, alignItems: 'center', justifyContent: 'center', borderRadius: 25 },
  trayText: { fontSize: 22, fontWeight: '700', color: tide.textDim, fontFamily: fonts.ui },
  lit: { position: 'absolute', left: 0, top: 0, bottom: 0, borderRadius: 25, backgroundColor: GOLD_FILL, borderWidth: 1, borderColor: GOLD_RIM },
  heroMeta: { marginTop: 6, fontSize: 18, color: tide.textDim, fontFamily: fonts.ui },
  mix: { flexDirection: 'row', height: 14, borderRadius: 7, overflow: 'hidden', gap: 3 },
  row: { flexDirection: 'row', height: ROW_H, alignItems: 'center', gap: 12 },
  rowText: { flex: 1 },
  rowKind: { fontSize: 15, fontWeight: '600', color: tide.text, fontFamily: fonts.ui },
  rowTitle: { fontSize: 12, color: tide.textDim, fontFamily: fonts.ui },
  more: { height: MORE_H, lineHeight: MORE_H, fontSize: 13, fontWeight: '600', color: tide.textDim, fontFamily: fonts.ui },
  rowCount: { fontSize: 17, fontWeight: '700', color: tide.text, fontFamily: fonts.ui },
  rowOf: { fontSize: 12, fontWeight: '500', color: tide.textDim },
  dragRow: { position: 'absolute', left: 0, right: 0, top: 0 },
  action: { position: 'absolute', top: 0, bottom: 0, overflow: 'hidden', backgroundColor: REMOVE_RED },
  actionPress: { flex: 1, justifyContent: 'center' },
  actionLabel: { width: ACTION_W, alignItems: 'center' },
  actionText: { color: '#FFFFFF', fontSize: 14, fontWeight: '600', fontFamily: fonts.ui },
  grip: { width: 32, height: 44, alignItems: 'center', justifyContent: 'center', gap: 2.5, opacity: 0.6 },
  gripRow: { flexDirection: 'row', gap: 4 },
  gripDot: { width: 3, height: 3, borderRadius: 1.5, backgroundColor: tide.textDim },
  pressed: { opacity: 0.6 },
  note: { flexDirection: 'row', alignItems: 'center', height: NOTE_H, gap: 12 },
  noteText: { fontSize: 13, color: tide.textDim, fontFamily: fonts.ui, lineHeight: NOTE_H },
  undo: { fontSize: 13, fontWeight: '700', color: verb.read.c1, fontFamily: fonts.ui },
  stepper: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingVertical: 12, paddingHorizontal: 8 },
  stepMid: { alignItems: 'center' },
  stepN: { fontSize: 34, fontWeight: '700', color: tide.text, fontFamily: fonts.ui },
  sheetDone: { marginTop: 12 },
  sheetLoad: { alignItems: 'center', paddingVertical: 24 },
  label: { fontSize: 11, fontWeight: '700', letterSpacing: 0.7, textTransform: 'uppercase', color: tide.textDim, fontFamily: fonts.ui, marginBottom: 8 },
  upCard: { paddingTop: 12, paddingHorizontal: 18, paddingBottom: 14 },
  upCardRoomy: { paddingVertical: 18, paddingHorizontal: 20 },
  upHead: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  upTitle: { flex: 1, fontSize: 13, color: tide.textDim, fontFamily: fonts.ui },
  units: { flexDirection: 'row', flexWrap: 'wrap', marginTop: 4 },
  oneLine: { flexDirection: 'row', overflow: 'hidden', marginTop: 4 },
  hidden: { opacity: 0 },
  ellipsis: { position: 'absolute', bottom: 4, fontSize: 28, fontWeight: '600', color: tide.text, fontFamily: fonts.ui },
  unit: { flexDirection: 'row', flexShrink: 0 },
  plain: { fontSize: 28, fontWeight: '600', color: tide.text, fontFamily: fonts.ui, marginTop: 4 },
  en: { fontSize: 14, lineHeight: 21, color: tide.textDim, fontFamily: fonts.ui },
  cta: { paddingHorizontal: 20, paddingTop: 12 },
  countBody: { paddingHorizontal: 20, paddingTop: 24 },
  countFoot: { alignItems: 'center', gap: 14 },
  sessionMeta: { fontSize: 15, color: tide.textDim, fontFamily: fonts.ui, textAlign: 'center' },
});
