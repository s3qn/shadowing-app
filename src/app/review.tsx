import { Stack, useFocusEffect, useRouter } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { SymbolView } from 'expo-symbols';
import { useCallback, useEffect, useRef, useState } from 'react';
import { AppState, Pressable, ScrollView, StyleSheet, Text, useWindowDimensions, View } from 'react-native';
import Animated, { useSharedValue } from 'react-native-reanimated';
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';

import { CatConstellation } from '@/components/cat-constellation';
import { useBackHeaderOptions } from '@/components/island/player-header';
import { PrismButton } from '@/components/prism';
import { GRAMMAR_LILAC } from '@/components/ruby-word';
import { DragRows } from '@/components/review/drag-rows';
import { ProjectRow, rowStyles, SizeTray, UpFirst } from '@/components/review/project-row';
import { BottomSheet } from '@/components/sheet/bottom-sheet';
import { SheetAction } from '@/components/sheet/sheet-rows';
import { LoadingBlock } from '@/components/state-blocks';
import { HeroNumber } from '@/components/tide/hero-number';
import type { Look } from '@/components/tide/ladder/stage-model';
import { Tile } from '@/components/tide/ladder/stage-tile';
import { fonts } from '@/constants/fonts';
import { Spacing, prism, tide, verb } from '@/constants/theme';
import * as api from '@/lib/api';
import { getSessionPrefs, routeFor, setSessionPrefs, startSession } from '@/lib/auto-practice';
import { useBetaFeatures } from '@/lib/beta';
import { confirmSheet } from '@/lib/confirm-sheet';
import { getGuideStep, guidePracticeStarted, useGuideAnchor, useGuideLock, useGuideStep } from '@/lib/guide';
import { hapticSelection } from '@/lib/haptics';
import { useDir, useT } from '@/lib/i18n';
import { prefetchIsland, prewarmIsland } from '@/lib/island-cache';
import { peekSessionPlan } from '@/lib/plan-cache';
import { getSettingsSync, SESSION_SIZES, sessionLanguage, type SessionSize, setSessionSize } from '@/lib/settings';

const SIZES = SESSION_SIZES;
const NOTE_H = 28;
// Same cap as MAX_EDIT_PROJECTS in backend/review_session.py.
const MAX_PROJECTS = 8;
const ADD_DEFAULT = 3;
const UNDO_MS = 4000;
const READY: Look = { tint: verb.listen.c2, from: 0.38, to: 0.12, rim: 0.5 };
const BAR: Record<api.SessionKind, string> = { podcast: GRAMMAR_LILAC, video: verb.listen.c1, island: verb.read.c1 };

const picksOf = (ps: api.SessionProject[]): api.SessionPick[] => ps.map((p) => ({ island_id: p.island_id, count: p.picked.length }));
/** Grows or trims a picked list to `n` until the server's answer replaces it (-1 holds a place). */
const resize = (picked: number[], n: number) => (n <= picked.length ? picked.slice(0, n) : [...picked, ...Array<number>(n - picked.length).fill(-1)]);

/** One saved line, one island or one podcast at a time: the session's start screen. Practice now plays the plan through the existing players. */
export default function ReviewScreen() {
  const { t } = useT();
  const beta = useBetaFeatures();
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
  // Home fetched the default plan on focus: showing it at once skips the loader. The focus effect still revalidates.
  const [plan, setPlan] = useState<api.SessionPlan | null>(() => peekSessionPlan(size));
  // The learner's own plan once they reorder, change a count, remove or add. Null plays the planner's pick for `size`.
  const [edit, setEdit] = useState<api.SessionPick[] | null>(null);
  const [edited, setEdited] = useState(true);
  const [sheetP, setSheetP] = useState<api.SessionProject | null>(null);
  const [sheetOpen, setSheetOpen] = useState(false);
  const [sheetCount, setSheetCount] = useState(1);
  const [adding, setAdding] = useState(false);
  const [catalogue, setCatalogue] = useState<api.SessionCatalogueItem[] | null>(() => peekSessionPlan(size)?.catalogue ?? null);
  const [undo, setUndo] = useState<{ index: number; project: api.SessionProject } | null>(null);
  const [loadError, setLoadError] = useState('');
  const retryAnchor = useGuideAnchor('sizeRetry', guideSize && !!plan && plan.count === 0 && !!loadError);
  const [starting, setStarting] = useState(false);
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

  // Reads the first island's local copy and fetches it, so Practice now opens it without the dark loader.
  // Runs for the cached plan, the revalidated one and any reorder that changes the first island.
  const firstId = plan?.projects[0]?.island_id;
  useEffect(() => {
    if (!firstId) return;
    prewarmIsland(firstId);
    void prefetchIsland(firstId);
  }, [firstId]);

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
          if (p.catalogue) setCatalogue(p.catalogue);
        })
        .catch((e) => {
          if (seq.current !== mine || soft) return;
          setCatalogue((c) => c ?? []);
          setLoadError(e instanceof Error ? e.message : t('review.loadFailed'));
          setPlan({ session_id: null, size: n, count: 0, minutes: 0, seconds_per_sentence: 0, projects: [], first: null });
        });
    },
    [t],
  );
  const loadDefault = useCallback((n: number) => void getSessionPrefs().then((pr) => load(n, { order: pr.order, catalogue: true })), [load]);

  useFocusEffect(
    useCallback(() => {
      setStarting(false);
      api.clearSessionLines();
      setEdit(null);
      setUndo(null);
      void getSessionPrefs().then((pr) => setEdited(pr.edited));
      loadDefault(sizeRef.current); // the plan carries the Add list too
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
      if (guideSize) guidePracticeStarted();
      const first = started.projects[0];
      if (!first) return setStarting(false);
      if (first.island_id !== firstId) {
        prewarmIsland(first.island_id);
        void prefetchIsland(first.island_id);
      }
      // No count here: the player's own stage count-in is the only one.
      startSession(started);
      router.push(routeFor(first.island_id, first.kind));
    } catch (e) {
      setStarting(false);
      void confirmSheet({ title: e instanceof Error ? e.message : t('review.loadFailed'), actions: [{ label: t('common.ok'), verb: 'tools' }] });
    }
  };

  const help = () => void confirmSheet({ title: t('review.helpTitle'), message: t('review.helpBody'), actions: [{ label: t('common.ok'), verb: 'tools' }] });

  const backHeader = useBackHeaderOptions({
    right: () => (
      <PrismButton shape="round" size={prism.sizes.roundSm} verb="tools" onPress={help} accessibilityLabel={t('player.help')}>
        <Text style={styles.helpGlyph}>?</Text>
      </PrismButton>
    ),
  });
  const header = (
    <Stack.Screen
      options={{
        headerTitle: () => (
          <View style={styles.headTitle}>
            <Text style={[styles.headMain, dir.writing]}>{t('review.title')}</Text>
            <Text style={[styles.headSub, dir.writing]}>{t('review.subtitle')}</Text>
          </View>
        ),
        ...backHeader,
      }}
    />
  );

  if (!plan) {
    return (
      <SafeAreaView edges={['bottom']} style={[styles.fill, { backgroundColor: tide.sky[0] }]}>
        <StatusBar style="light" />
        {header}
        <LoadingBlock />
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
              <PrismButton shape="pill" verb="listen" label={beta.podcast ? t('review.openPodcasts') : t('review.openHome')} onPress={() => router.navigate(beta.podcast ? '/podcast' : '/')} />
            </>
          )}
        </View>
      </SafeAreaView>
    );
  }

  const meta = { min: plan.minutes };
  const total = plan.projects.length;
  const canAdd = total < MAX_PROJECTS;
  const note = undo ? 'undo' : !edited ? 'hint' : null;
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
      {
        <Animated.View style={styles.fill} onStartShouldSetResponderCapture={closeSoon}>
          {/* The body scrolls when the box, Add, the note and Up first outgrow the screen; Practice now stays pinned below. The box scrolls inside it and takes its own touches first. */}
          <ScrollView style={styles.body} contentContainerStyle={[styles.bodyContent, { paddingTop: gap(24) }]} showsVerticalScrollIndicator={false} nestedScrollEnabled bounces={false}>
            <View>
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
            <View style={{ marginTop: gap(14) }}>
              <DragRows
                key={plan.projects.map((p) => p.island_id).join(',')}
                items={plan.projects}
                enabled={!starting}
                dirRow={dir.row}
                rtl={dir.rtl}
                openId={openId}
                keepOpen={keepOpen}
                onOrder={reorder}
                onTap={openRow}
                onRemove={removeId}
              />
              {canAdd ? (
                <Pressable onPress={() => !starting && setAdding(true)} accessibilityRole="button" style={({ pressed }) => [rowStyles.row, dir.row, pressed && styles.pressed]}>
                  <Tile look={READY} size={44} radius={12} fontSize={22}>
                    +
                  </Tile>
                  <Text style={[rowStyles.rowKind, rowStyles.rowText, dir.text]}>{t('review.addFrom')}</Text>
                </Pressable>
              ) : null}
              {note === 'undo' && undo ? (
                <Pressable onPress={restore} accessibilityRole="button" style={[styles.note, dir.row]}>
                  <Text style={[styles.noteText, rowStyles.rowText, dir.text]} numberOfLines={1}>
                    {t('review.removed', { title: undo.project.title })}
                  </Text>
                  <Text style={styles.undo}>{t('review.undo')}</Text>
                </Pressable>
              ) : note === 'hint' ? (
                <Text style={[styles.note, styles.noteText, dir.text]} numberOfLines={2}>
                  {t('review.editHint')}
                </Text>
              ) : null}
            </View>
            <View style={{ marginTop: gap(14) }}>
              <UpFirst plan={plan} />
            </View>
          </ScrollView>
          <View style={[styles.cta, { paddingBottom: Math.max(insets.bottom + 2, 20) }]}>
            <View ref={practiceBtn.ref} onLayout={practiceBtn.onLayout}>
              <PrismButton shape="pill" verb="read" height={58} label={t('review.practiceNow')} disabled={starting} onPress={practice}>
                <SymbolView name={{ ios: 'play.fill', android: 'play_arrow' }} size={16} weight="regular" tintColor={verb.read.c1} />
              </PrismButton>
            </View>
          </View>
        </Animated.View>
      }
      <BottomSheet open={sheetOpen} onClose={closeSheet} title={sheetP?.title ?? t('review.sheetTitle')} contentTitle>
        {sheetP ? (
          <>
            <View style={[styles.stepper, dir.row]}>
              <PrismButton shape="round" size={48} verb="read" disabled={sheetCount <= 1} onPress={() => setSheetCount((c) => Math.max(1, c - 1))} accessibilityLabel={t('review.fewer')}>
                <SymbolView name={{ ios: 'minus', android: 'remove' }} size={20} weight="semibold" tintColor={verb.read.c1} />
              </PrismButton>
              <View style={styles.stepMid}>
                <Text style={styles.stepN}>{sheetCount}</Text>
                <Text style={rowStyles.rowOf}>{t('review.ofTotal', { n: sheetP.total })}</Text>
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

const styles = StyleSheet.create({
  fill: { flex: 1 },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: Spacing.lg, paddingHorizontal: 16 },
  emptyTitle: { fontSize: 20, fontWeight: '700', color: tide.text, fontFamily: fonts.ui, textAlign: 'center' },
  hint: { fontSize: 14, lineHeight: 20, color: tide.textDim, fontFamily: fonts.ui, textAlign: 'center' },
  headTitle: { alignItems: 'center' },
  helpGlyph: { fontFamily: fonts.uiMedium, fontSize: 18, color: tide.text },
  headMain: { fontSize: 15, fontWeight: '600', color: tide.text, fontFamily: fonts.ui },
  headSub: { fontSize: 11.5, color: tide.textDim, fontFamily: fonts.ui },
  body: { flex: 1 },
  bodyContent: { paddingHorizontal: 20, paddingBottom: 8 },
  heroMeta: { marginTop: 6, fontSize: 18, color: tide.textDim, fontFamily: fonts.ui },
  mix: { flexDirection: 'row', height: 14, borderRadius: 7, overflow: 'hidden', gap: 3 },
  pressed: { opacity: 0.6 },
  note: { flexDirection: 'row', alignItems: 'center', minHeight: NOTE_H, gap: 12 },
  noteText: { fontSize: 13, color: tide.textDim, fontFamily: fonts.ui, lineHeight: 18, paddingVertical: 5 },
  undo: { fontSize: 13, fontWeight: '700', color: verb.read.c1, fontFamily: fonts.ui },
  stepper: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingVertical: 12, paddingHorizontal: 8 },
  stepMid: { alignItems: 'center' },
  stepN: { fontSize: 34, fontWeight: '700', color: tide.text, fontFamily: fonts.ui },
  sheetDone: { marginTop: 12 },
  sheetLoad: { alignItems: 'center', paddingVertical: 24 },
  cta: { paddingHorizontal: 20, paddingTop: 12 },
});
