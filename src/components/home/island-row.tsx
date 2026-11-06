import { useFocusEffect } from 'expo-router';
import { memo, useCallback, useEffect, useRef, useState } from 'react';
import { Dimensions, Pressable, StyleSheet, Text, View } from 'react-native';
import * as Haptics from 'expo-haptics';
import Animated, {
  cancelAnimation,
  Easing,
  FadeOut,
  interpolateColor,
  runOnJS,
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
import { SymbolView } from 'expo-symbols';

import { CatConstellation } from '@/components/cat-constellation';
import { prefetchPeek, type IslandPeekContext } from '@/components/home/island-peek';
import { LANTERN_FADE_MS, LANTERN_RISE_MS, LANTERN_STEP_MS, LanternRow } from '@/components/lantern-row';
import { fonts } from '@/constants/fonts';
import { Radius, Spacing, tide, verb } from '@/constants/theme';
import * as api from '@/lib/api';
import { registerCard, unregisterCard, useMorphHidesTitle, type CardRect } from '@/lib/card-morph';
import { hapticImpact, hapticSelection } from '@/lib/haptics';
import { useT, useDir } from '@/lib/i18n';
import { prewarmIsland } from '@/lib/island-cache';
import { getLastLine } from '@/lib/last-line';
import { useDownloadState } from '@/lib/offline-islands'; // offline-islands
import { getSettingsSync } from '@/lib/settings';
import { getRung } from '@/lib/speed-ladder';
import { weakestLine, type LineTier } from '@/lib/takes';

const AnimatedPressable = Animated.createAnimatedComponent(Pressable);
// A long press holds this long before it counts, so it reads as deliberate
// next to the plain tap that opens the island.
const LONG_PRESS_MS = 400;
// Cards past this position in the list appear instantly instead of joining
// the wave: staggering a whole long list would take too long to settle.
export const WAVE_MAX_CARDS = 10;
const WAVE_STAGGER_MS = 40;
// The wheel: one fixed card height, a gap between cards, and the step a
// scroll of one card takes. Centring math and snapping both key off STEP.
export const CARD_H = 128;
/** The build stages, in the order they happen. A recording skips downloading
 * and extracting, a podcast import runs all of them, so a stage's place in
 * this list is how much of the cat is lit rather than a count of stages: a
 * skipped stage lights its stars all the same. A stage that is not here (a
 * newer backend) falls back to counting the stages this card has seen. */
const STAGE_ORDER: readonly string[] = [
  'queued',
  'downloading',
  'extracting',
  'transcribing',
  'writing',
  'speaking',
  'slicing',
];
/** The last stars wait for the island itself: a running build never draws a
 * complete cat, so a full one means ready. */
const BUILD_MAX = 0.92;
const BUILD_STEP = BUILD_MAX / STAGE_ORDER.length;
const GAP = 8;
export const STEP = CARD_H + GAP;

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

export type IslandRowProps = {
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
  /** The build stage the backend reports, or `''` once the island is not
   * building. Its own prop so a card repaints on every stage the build
   * moves through: the constellation lights another star for each one. */
  stage: string;
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
  onMenu: (item: api.IslandSummary, ctx: IslandPeekContext) => void;
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
 * While the island is still building, the card carries the app's loading
 * visual instead of its status line: the cat constellation, the stage label
 * and the three dots, with another of the cat's stars lit for every stage
 * the build passes. The moment the card turns ready the constellation goes,
 * the lanterns come back, and the card flashes the accent once with a
 * haptic.
 */
export const IslandRow = memo(function IslandRow({
  item,
  slotIndex,
  scrollY,
  viewportH,
  wheelOn,
  centred,
  lit,
  tiers,
  busy,
  stage,
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
  const dlState = useDownloadState(item.id); // offline-islands
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

  // How much of the building card's cat is drawn, 0 to 1. Kept in a ref as
  // well so it only ever goes forward: a stage the backend repeats, or one
  // this build skips, must never put a star out.
  const build = useSharedValue(0);
  const built = useRef(0);
  const stagesSeen = useRef(0);
  const lastStage = useRef('');
  useEffect(() => {
    if (!busy) {
      cancelAnimation(build);
      build.value = 0;
      built.current = 0;
      stagesSeen.current = 0;
      lastStage.current = '';
      return;
    }
    if (stage !== lastStage.current) {
      lastStage.current = stage;
      stagesSeen.current += 1;
    }
    const known = STAGE_ORDER.indexOf(stage);
    const step = known >= 0 ? known + 1 : stagesSeen.current;
    const target = Math.max(built.current, Math.min(BUILD_MAX, step * BUILD_STEP));
    built.current = target;
    build.value = reducedMotion ? target : withTiming(target, { duration: 700, easing: Easing.out(Easing.quad) });
  }, [busy, stage, reducedMotion, build]);

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
      // The hold is about 400ms: the peek's lines are usually cached by then.
      prefetchPeek(item);
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

  function handleLongPress() {
    longPressFired.current = true;
    void hapticImpact(Haptics.ImpactFeedbackStyle.Medium);
    // The peek opens at once; the press-in scale returns underneath it.
    onMenu(item, { meta, due, tiers });
    pressed.value = withTiming(0, { duration: 180 });
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
      opacity: 1 - d * 0.25,
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
        style={[styles.row, cardStyle]}>
        <View
          pointerEvents="none"
          style={[
            styles.rowFill,
            dir.rtl && styles.rowFillRtl,
            { width: `${fraction * 100}%`, backgroundColor: tide.lang.ja },
          ]}
        />
        <Animated.View pointerEvents="none" style={[styles.flashFill, { backgroundColor: tide.lang.ja }, flashFillStyle]} />
        <Animated.View pointerEvents="none" style={[styles.flashBorder, { borderColor: tide.lang.ja }, flashBorderStyle]} />
        <View style={[styles.cardTop, dir.row]}>
          {/* `dir.content`, not `dir.text`: a title is content, ordered by
              its own script whatever the interface language is. */}
          <Text numberOfLines={2} style={[styles.cardTitle, dir.content, { color: tide.text, opacity: titleHidden ? 0 : 1 }]}>
            {item.title || t('home.untitledIsland')}
          </Text>
          {/* offline-islands: the card mark */}
          {dlState === 'done' || dlState === 'downloading' ? (
            <SymbolView
              name={{ ios: dlState === 'done' ? 'arrow.down.circle.fill' : 'arrow.down.circle', android: 'download' }}
              size={14}
              tintColor={tide.textDim}
              style={{ opacity: dlState === 'done' ? 0.9 : 0.5 }}
            />
          ) : null}
        </View>
        <View style={[styles.metaRow, dir.row]}>
          {/* The dot is its own cell, not part of the label: kept inside it,
              the dot would follow "Due today" in Hebrew as well and end up on
              the wrong side of the row once `dir.row` reverses the order. */}
          {due ? (
            <>
              <Text style={[styles.cardMeta, dir.text, { color: verb.read.c2 }]}>{t('home.dueToday')}</Text>
              <Text style={[styles.cardMeta, { color: verb.read.c2 }]}>·</Text>
            </>
          ) : null}
          {busy ? null : <Text style={[styles.cardMeta, dir.text, { color: tide.textDim }]}>{meta}</Text>}
          {langPill ? (
            <View style={styles.langPill}>
              <Text style={styles.langPillText}>{langPill}</Text>
            </View>
          ) : null}
        </View>
        {busy ? (
          <View pointerEvents="none" style={styles.building}>
            <CatConstellation compact size={50} label={meta} progress={build} />
          </View>
        ) : null}
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
  rowFillRtl: { left: 'auto', right: 0 },
  flashFill: { ...StyleSheet.absoluteFill },
  flashBorder: { ...StyleSheet.absoluteFill, borderWidth: 2, borderRadius: 16 },
  cardTop: { flexDirection: 'row', alignItems: 'center', gap: Spacing.md },
  cardTitle: { flex: 1, fontSize: 17, fontWeight: '600', lineHeight: 24, includeFontPadding: false, fontFamily: fonts.serifJp },
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
  // The building card's constellation, laid out over the meta row and the
  // lantern spacer rather than in the flow: the card keeps its height and its
  // title where they are, so nothing moves when the island turns ready.
  building: { position: 'absolute', left: 12, right: 12, bottom: 9 },
  // Matches LanternRow's own height: a busy or failed card has no lanterns
  // but still needs the row's height so every card lines up.
  lanternSpacer: { height: 24 },
});
