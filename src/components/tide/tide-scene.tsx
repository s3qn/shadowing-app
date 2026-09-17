import {
  memo,
  type ReactNode,
  type RefObject,
  useCallback,
  useEffect,
  useEffectEvent,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import {
  AppState,
  type LayoutChangeEvent,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  useWindowDimensions,
  View,
} from 'react-native';
import { useIsFocused } from 'expo-router';
import { ScrollView } from 'react-native-gesture-handler';
import Animated, {
  cancelAnimation,
  FadeIn,
  FadeOut,
  interpolateColor,
  runOnUI,
  type SharedValue,
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
  withSequence,
  withSpring,
  withTiming,
} from 'react-native-reanimated';

import { Frost } from '@/components/frost';
import { fonts } from '@/constants/fonts';
import { Radius, tide, tideWaters } from '@/constants/theme';
import { useSkyStyle, isNight, currentPeriod } from '@/lib/sky';
import { useWaterSim } from '@/components/tide/use-water-sim';
import { WaterSurface } from '@/components/tide/water-surface';
import { WaterCanvas } from '@/components/tide/water-canvas';
import { isWindowed, LONG_ISLAND, useTranscriptWindow } from '@/components/tide/transcript-window';
import { type ContentReveal, PIECE_RISE, usePieceStyle } from '@/components/tide/use-content-reveal';

/** Temporary kill switch for bisecting the device crash: false skips the
 * Skia canvas, the touch band with its accelerometer, and the water sim's
 * frame callback. Leave it true outside a bisect. */
const WATER_EFFECTS = true;

/** Splash strength for a tap on the band, per the water sim's splashAt
 * contract. A line change sloshes the water instead of splashing it. */
const TAP_SPLASH = 1;

/** How far below its resting place a new active line starts, and the spring
 * that lifts it there: heavily damped, so it surfaces without bouncing. */
const RISE_FROM = 28;
const RISE_SCALE_FROM = 0.96;
const RISE_SPRING = { damping: 24, stiffness: 170, mass: 1 } as const;
const RISE_FADE_MS = 450;
/** The line that just stopped being active lifts away and fades. */
const LIFT_TO = -22;
const LIFT_MS = 300;
/** Under reduced motion a line change is a plain crossfade. */
const CROSSFADE_IN_MS = 250;
const CROSSFADE_OUT_MS = 200;
/** How long a line change waits for the active line's own layout event
 * before it scrolls with the measurements it has (the line's box did not
 * move, so no event comes). */
const SYNC_FALLBACK_MS = 120;
/** The sentence card, transcript and tide marks fade in this long once the
 * island's lines arrive after the scene is already on screen. */
const REVEAL_MS = 180;

/** The active tide mark rides an elevator to its new line: a spring that
 * settles in about 350ms, plus a brief mid-move stretch. */
const MARK_SPRING = { damping: 20, stiffness: 210, mass: 1 } as const;
const MARK_STRETCH_UP_MS = 120;


// How far the waterline sits from the top of the scene at the first and last
// line: the tide rises from WL_MAX to WL_MIN as lineIndex approaches the end.
const WL_MAX = 0.62;
const WL_MIN = 0.42;

/** Past LONG_ISLAND lines the tide marks stop being one per
 * line and become this many bucketed marks instead, so a long island doesn't
 * rebuild hundreds of Views on every line change. */
const MARK_CAP = 40;

type Props = {
  lineIndex: number;
  lineCount: number;
  /** Every line's Japanese text, in order; only the active one is tappable-free. */
  lines: readonly string[];
  /** Blind mode: past and next lines are frosted. */
  blind: boolean;
  /** Playing or recording: keeps the water at full frame rate. */
  busy: boolean;
  /** Seconds left in the breath, giant faded number; null hides it. */
  countdown: number | null;
  banner?: ReactNode;
  /** Sits on the waterline, bottom-anchored. */
  sentence: ReactNode;
  /** Just under the waterline: the PhraseBar. */
  below?: ReactNode;
  scrollRef: RefObject<ScrollView | null>;
  /** A dim line was tapped: the screen should jump to it and start playing. */
  onLineTap: (i: number) => void;
  /** Read when the lines land: true while the card morph still covers the
   * screen, so they show at once and the morph's own fade reveals them. A
   * function, so the screen never re-renders this scene when the cover goes. */
  instantReveal?: () => boolean;
  /** The screen's staged reveal: the sentence card follows `card`, the past
   * and next rows follow `rows`. Without it both follow the lines landing. */
  contentReveal?: ContentReveal;
  /** The scene's expected height before its first layout, so the water and
   * waterline are drawn from the first frame instead of after a layout pass.
   * The real layout replaces it. */
  initialHeight?: number;
  /** Opened under the card morph: a long island's transcript mounts few rows
   * and widens when this calls back (it returns a cancel). Read at mount. */
  widenWhen?: (widen: () => void) => () => void;
};

/**
 * The Tide player scene: every line of the island in one scrolling
 * transcript, the active sentence floating on a waterline over a soft glow,
 * tide marks down the left edge and a giant faded countdown
 * mid-screen during the breath. Auto-scroll keeps the active line on the
 * waterline; a hand drag pauses that behind a pill. Pure layout, no engine
 * knowledge: the screen owns playback and passes the rendered slots in.
 */
export const TideScene = memo(function TideScene({
  lineIndex,
  lineCount,
  lines,
  blind,
  busy,
  countdown,
  banner,
  sentence,
  below,
  scrollRef,
  onLineTap,
  instantReveal,
  contentReveal,
  initialHeight = 0,
  widenWhen,
}: Props) {
  // The scene fills the window's width; its height starts from the caller's
  // estimate. Both only seed the first frame, the layout events take over.
  const { width: windowW } = useWindowDimensions();
  const seedW = Number.isFinite(windowW) && windowW > 0 ? windowW : 0;
  const [sceneH, setSceneH] = useState(() =>
    Number.isFinite(initialHeight) && initialHeight > 0 ? initialHeight : 0,
  );
  const [pill, setPill] = useState<'off' | 'on' | null>(null);
  // Whether the transcript should follow playback. A ref, not state: it must
  // read as up to date inside the same handler that just turned it on, and
  // nothing renders differently from its value directly (the pill does).
  const autoScroll = useRef(true);
  const activeTop = useRef(0);
  const activeH = useRef(0);
  const lastTarget = useRef<number | null>(null);
  const synced = useRef(false);
  // Set when the island's lines arrive after the scene mounted empty: the
  // first scroll then waits for the active line's real layout (see below).
  const arrivalPending = useRef(false);

  // Mounts only the rows near the active line on a long island; on a short
  // one the window is the whole island and both spacers are 0 (see
  // transcript-window.ts).
  const { window: rowWindow, measure, onRowLayout, pastOffset, nextSpacerH, onScroll } = useTranscriptWindow({
    lineIndex,
    lineCount,
    lines,
    autoScroll,
    padTop: WL_MAX,
    padBottom: 1 - WL_MIN,
    widenWhen,
  });
  // Off (the flag, or a short island): no row onLayout and no scroll handler,
  // as on main.
  const windowed = isWindowed(lineCount);
  const rowLayout = windowed ? onRowLayout : undefined;

  const onLayout = (e: LayoutChangeEvent) => {
    setSceneH(e.nativeEvent.layout.height);
  };

  // The water's physics runs only while this screen is focused and the app
  // is in the foreground, on top of the system's reduced-motion setting.
  const [bandWidth, setBandWidth] = useState(seedW);
  const [appActive, setAppActive] = useState(AppState.currentState === 'active');
  useEffect(() => {
    const sub = AppState.addEventListener('change', (state) => setAppActive(state === 'active'));
    return () => sub.remove();
  }, []);
  const isFocused = useIsFocused();
  const reducedMotion = useReducedMotion();
  const waterSim = useWaterSim({
    width: bandWidth,
    enabled: WATER_EFFECTS && isFocused && appActive,
    reducedMotion,
    busy,
  });
  // A line change sloshes the water side to side once; the edge that dips
  // first follows the direction of travel. The band's first width is not a
  // line change, so it only records the index.
  const prevLine = useRef(lineIndex);
  // An effect event: only a genuine line change should slosh, and the sim's
  // sloshAt is a new function each render.
  const slosh = useEffectEvent((direction: number) => {
    runOnUI(waterSim.sloshAt)(direction);
  });
  useEffect(() => {
    const from = prevLine.current;
    prevLine.current = lineIndex;
    if (bandWidth <= 0 || from === lineIndex) return;
    slosh(lineIndex > from ? 1 : -1);
  }, [lineIndex, bandWidth]);

  // Returns whether it actually issued a scrollTo, so callers that only
  // want the instant-vs-glide flag to flip once a real scroll happened
  // (see synced below) can tell a bail apart from a scroll.
  function syncScroll(animated: boolean) {
    if (sceneH === 0 || !autoScroll.current) return false;
    const y = activeTop.current + activeH.current - waterlineFraction(lineIndex, lineCount) * sceneH;
    if (lastTarget.current !== null && Math.abs(y - lastTarget.current) <= 1) return false;
    lastTarget.current = y;
    scrollRef.current?.scrollTo({ y, animated });
    return true;
  }

  // The first sync after mount lands the waterline instantly; every one
  // after that (a line change, a resize) glides there. synced only flips
  // once scrollTo actually ran: if we flipped it on a bail (sceneH still 0
  // on the first render, say), the next real scroll would glide through
  // the whole transcript instead of landing instantly.
  function syncNow() {
    if (syncScroll(synced.current)) {
      synced.current = true;
    }
  }
  // The effects below call syncNow through this, so they run only for the
  // deps they list (re-running for an autoScroll toggle, say, would fight
  // the pill's own scrollTo) and still read this render's lineIndex,
  // lineCount and sceneH.
  const syncFromEffect = useEffectEvent(() => {
    syncNow();
  });

  // lineIndex is handled by the line change effect below.
  useEffect(() => {
    if (arrivalPending.current) {
      const t = setTimeout(() => {
        if (!arrivalPending.current) return;
        arrivalPending.current = false;
        syncFromEffect();
      }, SYNC_FALLBACK_MS);
      return () => clearTimeout(t);
    }
    syncFromEffect();
  }, [lineCount, sceneH]);

  // The active line's card stays mounted across a line change: remounting the
  // whole word tree under a layout animation is what stalled every change.
  // The new line rises out of the water from these values instead, and a
  // plain text copy of the line before it lifts away over the top.
  const riseOpacity = useSharedValue(1);
  const riseY = useSharedValue(0);
  const riseScale = useSharedValue(1);
  const outLift = useSharedValue(1);
  // The line that was active before this one, and where its card sat, noted
  // while rendering the change (before the new line's layout moves activeTop).
  // Running this twice for one render changes nothing.
  const shownIndex = useRef(lineIndex);
  const outgoing = useRef<{ index: number; top: number } | null>(null);
  if (shownIndex.current !== lineIndex) {
    outgoing.current = { index: shownIndex.current, top: activeTop.current };
    shownIndex.current = lineIndex;
  }
  // Waiting for the active line's layout event to scroll with fresh
  // measurements (see syncNow's effect above for why not the stale ones).
  const syncPending = useRef(false);
  // The last line each effect below acted on, so the first line (and an
  // effect run twice for one line) neither rises nor waits.
  const risenIndex = useRef(lineIndex);
  const syncedIndex = useRef(lineIndex);
  // The scene mounts before the island loads (lineCount 0). The lines landing
  // are a first placement, not a line change: no rise, no outgoing copy, no
  // slosh, and the first scroll lands instantly once the line is laid out.
  const shownCount = useRef(lineCount);
  if (shownCount.current !== lineCount) {
    if (shownCount.current <= 0) {
      shownIndex.current = lineIndex;
      risenIndex.current = lineIndex;
      syncedIndex.current = lineIndex;
      prevLine.current = lineIndex;
      outgoing.current = null;
      synced.current = false;
      lastTarget.current = null;
      arrivalPending.current = true;
    }
    shownCount.current = lineCount;
  }
  const hasLines = lineCount > 0;
  const reveal = useSharedValue(hasLines ? 1 : 0);
  // Only the lines landing decide; instantReveal is read at that moment.
  const revealLines = useEffectEvent((shown: boolean) => {
    if (!shown) {
      cancelAnimation(reveal);
      reveal.set(0);
      return;
    }
    if (instantReveal?.()) {
      cancelAnimation(reveal);
      reveal.set(1);
      return;
    }
    reveal.set(withTiming(1, { duration: REVEAL_MS }));
  });
  useEffect(() => {
    revealLines(hasLines);
  }, [hasLines]);
  const revealStyle = useAnimatedStyle(() => ({ opacity: reveal.value }));
  const noRise = useSharedValue(0);
  const cardIn = contentReveal?.card ?? reveal;
  const rowsStyle = usePieceStyle(contentReveal?.rows ?? reveal, contentReveal?.rise ?? noRise);
  // A layout effect, so the start values are sent before the new line's text
  // is on screen and it never shows for a frame at rest before rising.
  useLayoutEffect(() => {
    if (risenIndex.current === lineIndex) return;
    risenIndex.current = lineIndex;
    cancelAnimation(riseOpacity);
    cancelAnimation(riseY);
    cancelAnimation(riseScale);
    cancelAnimation(outLift);
    riseOpacity.value = 0;
    outLift.value = 0;
    if (reducedMotion) {
      riseY.value = 0;
      riseScale.value = 1;
      riseOpacity.value = withTiming(1, { duration: CROSSFADE_IN_MS });
      outLift.value = withTiming(1, { duration: CROSSFADE_OUT_MS });
    } else {
      riseY.value = RISE_FROM;
      riseScale.value = RISE_SCALE_FROM;
      riseOpacity.value = withTiming(1, { duration: RISE_FADE_MS });
      riseY.value = withSpring(0, RISE_SPRING);
      riseScale.value = withSpring(1, RISE_SPRING);
      outLift.value = withTiming(1, { duration: LIFT_MS });
    }
    // The shared values never change identity, and risenIndex above keeps a
    // reduced-motion flip from rising the line again.
  }, [lineIndex, reducedMotion, riseOpacity, riseY, riseScale, outLift]);
  useEffect(() => {
    if (syncedIndex.current === lineIndex) return;
    syncedIndex.current = lineIndex;
    // The line's own onLayout may already have scrolled before this runs; a
    // second syncNow with the same measurements is a no-op (its 1pt guard).
    syncPending.current = true;
    const t = setTimeout(() => {
      if (!syncPending.current) return;
      syncPending.current = false;
      syncFromEffect();
    }, SYNC_FALLBACK_MS);
    return () => clearTimeout(t);
  }, [lineIndex]);
  const cardRise = contentReveal?.rise ?? noRise;
  const riseStyle = useAnimatedStyle(() => {
    const shown = Number.isFinite(cardIn.value) ? cardIn.value : 1;
    const lift = Number.isFinite(cardRise.value) ? cardRise.value : 0;
    return {
      opacity: riseOpacity.value * shown,
      transform: [{ translateY: riseY.value + lift * (1 - shown) * PIECE_RISE }, { scaleY: riseScale.value }],
    };
  });
  const outStyle = useAnimatedStyle(() => ({
    opacity: 1 - outLift.value,
    transform: [{ translateY: reducedMotion ? 0 : LIFT_TO * outLift.value }],
  }));

  useEffect(() => {
    if (pill !== 'on') return;
    const t = setTimeout(() => setPill(null), 1500);
    return () => clearTimeout(t);
  }, [pill]);

  // onLineTap is a new function every render (the screen closes over
  // playback state), so tapLine reads it through a ref kept current below
  // instead of taking it as a dep: with empty deps tapLine's own identity
  // never changes, so the memoised TranscriptLine rows below don't re-render
  // on every render this component gets from an audio tick.
  const onLineTapRef = useRef(onLineTap);
  useLayoutEffect(() => {
    onLineTapRef.current = onLineTap;
  });

  const tapLine = useCallback((i: number) => {
    autoScroll.current = true;
    lastTarget.current = null;
    setPill(null);
    onLineTapRef.current(i);
  }, []);

  // A plain function, not useCallback: it must close over this render's
  // syncScroll (which itself closes over the latest lineIndex/lineCount/
  // sceneH). A memoised version would keep the first render's syncScroll,
  // which always bails because sceneH is still 0 then, so the pill's tap
  // would silently do nothing. Resetting lastTarget also clears the 1px
  // guard, which would otherwise block this scroll if the drag left the
  // view within 1px of the last auto-scrolled position.
  function enableAutoScroll() {
    autoScroll.current = true;
    lastTarget.current = null;
    setPill('on');
    syncScroll(true);
  }

  const onScrollBeginDrag = () => {
    if (autoScroll.current) {
      autoScroll.current = false;
      setPill('off');
    }
  };

  const marks = useMemo(() => {
    if (lineCount <= LONG_ISLAND) {
      return Array.from({ length: lineCount }, (_, i) => lineCount - 1 - i).map((i) => (
        <View key={i} style={[styles.mark, i < lineIndex ? styles.markDone : styles.markPending]} />
      ));
    }
    return Array.from({ length: MARK_CAP }, (_, b) => MARK_CAP - 1 - b).map((b) => {
      const lastLine = Math.floor(((b + 1) * lineCount) / MARK_CAP) - 1;
      return <View key={b} style={[styles.mark, lastLine < lineIndex ? styles.markDone : styles.markPending]} />;
    });
  }, [lineIndex, lineCount]);

  // The active mark is a separate overlay riding on top of the static track
  // above, so it can slide between line positions instead of jumping when a
  // different array element switches to "now". markMounted guards the very
  // first placement (and any resize before it): those land instantly, only
  // a genuine line change glides.
  const [marksH, setMarksH] = useState(0);
  const markY = useSharedValue(0);
  const markStretch = useSharedValue(1);
  const markReady = useSharedValue(0);
  const markMounted = useRef(false);
  const onMarksLayout = useCallback((e: LayoutChangeEvent) => setMarksH(e.nativeEvent.layout.height), []);

  useEffect(() => {
    if (marksH <= 0 || lineCount <= 0) return;
    const p = lineCount - 1 - lineIndex;
    const target = lineCount > 1 ? (p * (marksH - 2)) / (lineCount - 1) : (marksH - 2) / 2;
    if (!markMounted.current) {
      markMounted.current = true;
      markY.value = target;
      markReady.value = withTiming(1, { duration: 150 });
      return;
    }
    if (reducedMotion) {
      markY.value = withTiming(target, { duration: 150 });
      markStretch.value = 1;
      return;
    }
    markY.value = withSpring(target, MARK_SPRING);
    markStretch.value = withSequence(withTiming(1.6, { duration: MARK_STRETCH_UP_MS }), withSpring(1, MARK_SPRING));
  }, [lineIndex, lineCount, marksH, reducedMotion, markY, markStretch, markReady]);

  const markActiveStyle = useAnimatedStyle(() => ({
    opacity: markReady.value,
    transform: [{ translateY: markY.value }, { scaleY: markStretch.value }],
  }));

  const sky = useSkyStyle();
  const night = isNight(new Date());
  const period = currentPeriod(new Date());
  const waterPalette = tideWaters[period];
  // Caustic brightness by period: dim at night, brightest by day.
  const causticIntensity = period === 'night' ? 0.07 : period === 'day' ? 0.14 : 0.1;

  return (
    <View style={styles.fill} onLayout={onLayout} onTouchStart={waterSim.wake}>
      <View style={[StyleSheet.absoluteFill, sky.from]} />
      <Animated.View style={[StyleSheet.absoluteFill, sky.to, sky.fadeStyle]} />
      {night && (
        <>
          <View style={[styles.star, { top: '15%', left: '12%' }]} />
          <View style={[styles.star, { top: '20%', right: '8%' }]} />
          <View style={[styles.star, { top: '35%', left: '25%' }]} />
          <View style={[styles.star, { top: '45%', right: '15%' }]} />
          <View style={[styles.star, { top: '55%', left: '18%' }]} />
          <View style={[styles.star, { top: '65%', right: '22%' }]} />
          <View style={[styles.star, { top: '72%', left: '30%' }]} />
        </>
      )}
      <ScrollView
        ref={scrollRef}
        style={styles.scroll}
        contentContainerStyle={[styles.content, { paddingTop: WL_MAX * sceneH, minHeight: sceneH }]}
        onScrollBeginDrag={onScrollBeginDrag}
        onScroll={windowed ? onScroll : undefined}
        scrollEventThrottle={windowed ? 100 : undefined}
        bounces={false}
        overScrollMode="never"
        showsVerticalScrollIndicator={false}
        keyboardShouldPersistTaps="handled"
      >
        {measure && rowLayout ? (
          // The past rows a widening adds, laid out once out of the flow and
          // unseen, only so their real heights are known before they join it.
          <View
            pointerEvents="none"
            style={styles.measure}
            accessibilityElementsHidden
            importantForAccessibility="no-hide-descendants"
          >
            {lines.slice(measure.start, measure.end).map((text, j) => {
              const i = measure.start + j;
              return (
                <TranscriptLine
                  key={i}
                  index={i}
                  text={text}
                  tone="past"
                  blind={blind}
                  onPress={tapLine}
                  onRowLayout={rowLayout}
                />
              );
            })}
          </View>
        ) : null}
        {/* The rows above the window, as a signed top margin (see pastOffset). */}
        <Animated.View style={[rowsStyle, { marginTop: pastOffset }]}>
          {lines.slice(rowWindow.start, lineIndex).map((text, j) => {
            const i = rowWindow.start + j;
            return (
              <TranscriptLine
                key={i}
                index={i}
                text={text}
                tone="past"
                blind={blind}
                onPress={tapLine}
                onRowLayout={rowLayout}
              />
            );
          })}
        </Animated.View>
        <Animated.View
          style={[styles.active, riseStyle]}
          onLayout={(e) => {
            activeTop.current = e.nativeEvent.layout.y;
            activeH.current = e.nativeEvent.layout.height;
            syncPending.current = false;
            arrivalPending.current = false;
            syncNow();
          }}
        >
          {sentence}
        </Animated.View>
        {outgoing.current && outgoing.current.index !== lineIndex && lines[outgoing.current.index] !== undefined ? (
          <Animated.View
            style={[styles.outgoing, { top: outgoing.current.top }, outStyle]}
            pointerEvents="none"
            accessibilityElementsHidden
            importantForAccessibility="no-hide-descendants"
          >
            <Frost frosted={blind}>
              <Text style={styles.outgoingText}>{lines[outgoing.current.index]}</Text>
            </Frost>
          </Animated.View>
        ) : null}
        <View style={[styles.water, { paddingBottom: (1 - WL_MIN) * sceneH }]}>
          {/* Only ever a fallback below the canvas's own bottom (content
             scrolled past one screen): its top sits exactly at the canvas's
             bottom edge so it never shows a straight edge against the live
             curve above it. */}
          <View
            style={[styles.waterBody, { top: sceneH, backgroundColor: waterPalette.deep }]}
            pointerEvents="none"
          />
          {WATER_EFFECTS ? (
            <WaterSurface
              width={bandWidth}
              boatY={waterSim.boatY}
              boatAngle={waterSim.boatAngle}
              boatX={waterSim.boatX}
              boatDragging={waterSim.boatDragging}
              tilt={waterSim.tilt}
              splashAt={waterSim.splashAt}
              setBoatX={waterSim.setBoatX}
              flickBoat={waterSim.flickBoat}
              enabled={isFocused && appActive}
              reducedMotion={reducedMotion}
              onWidthChange={setBandWidth}
              onSplash={(x) => runOnUI(waterSim.splashAt)(x, TAP_SPLASH)}
            />
          ) : null}
          {WATER_EFFECTS ? (
            <WaterCanvas
              height={sceneH + 20}
              initialWidth={seedW}
              lineD={waterSim.lineD}
              boatX={waterSim.boatX}
              boatY={waterSim.boatY}
              boatAngle={waterSim.boatAngle}
              palette={waterPalette}
              time={waterSim.time}
              centreY={waterSim.centreY}
              intensity={causticIntensity}
              reducedMotion={reducedMotion}
            />
          ) : null}
          {below}
          <Animated.View style={rowsStyle}>
            {lines.slice(lineIndex + 1, rowWindow.end).map((text, j) => {
              const i = lineIndex + 1 + j;
              return (
                <TranscriptLine
                  key={i}
                  index={i}
                  text={text}
                  tone="next"
                  blind={blind}
                  onPress={tapLine}
                  depth={Math.min(j + 1, STILL_DEPTH)}
                  time={waterSim.time}
                  shallow={waterPalette.shallow}
                  onRowLayout={rowLayout}
                />
              );
            })}
          </Animated.View>
          {nextSpacerH > 0 ? <View style={{ height: nextSpacerH }} /> : null}
        </View>
      </ScrollView>
      {countdown !== null ? (
        <View style={[StyleSheet.absoluteFill, styles.countdownWrap]} pointerEvents="none">
          <Text style={styles.countdown}>{countdown}</Text>
        </View>
      ) : null}
      <Animated.View style={[styles.marks, revealStyle]} pointerEvents="none" onLayout={onMarksLayout}>
        {marks}
        <Animated.View style={[styles.markActive, markActiveStyle]} />
      </Animated.View>
      {banner ? (
        <View style={[StyleSheet.absoluteFill, styles.bannerWrap]} pointerEvents="box-none">
          {banner}
        </View>
      ) : null}
      {pill ? (
        <View style={styles.pillWrap} pointerEvents="box-none">
          <Animated.View entering={FadeIn} exiting={FadeOut}>
            <Pressable onPress={enableAutoScroll} style={styles.pill} accessibilityRole="button">
              <Text style={styles.pillText}>
                {pill === 'off' ? 'Auto-scroll disabled. Tap to enable' : 'Auto-scroll enabled'}
              </Text>
            </Pressable>
          </Animated.View>
        </View>
      ) : null}
    </View>
  );
});

// Underwater row styling by depth (1..4, deeper rows reuse the depth-4
// values): colour mixed toward the period's shallow water, opacity, and a
// same-colour text shadow that reads as blur without expo-blur.
const DEPTH_MIX = [0.2, 0.35, 0.5, 0.6];
const DEPTH_OPACITY = [0.8, 0.65, 0.5, 0.4];
const DEPTH_SHADOW_RADIUS = [0, 2, 4, 6];
/** Rows this deep or deeper look the same and do not sway, so they all get
 * this one depth: a line change then leaves their props, and their memo,
 * alone instead of re-rendering every row below the waterline. */
const STILL_DEPTH = 7;

/** A past or upcoming line in the transcript: dim, centred, tap to jump.
 * Next lines sit under the waterline and lose the card look; depth (1 for
 * the row right under the line) tints, dims and softens them, and rows six
 * deep or shallower sway a little with the water's own motion. */
const TranscriptLine = memo(function TranscriptLine({
  index,
  text,
  tone,
  blind,
  onPress,
  depth,
  time,
  shallow,
  onRowLayout,
}: {
  index: number;
  text: string;
  tone: 'past' | 'next';
  blind: boolean;
  onPress: (i: number) => void;
  depth?: number;
  time?: SharedValue<number>;
  shallow?: string;
  onRowLayout?: (index: number, height: number) => void;
}) {
  const submerged = tone === 'next' && depth !== undefined;
  const styleDepth = submerged ? Math.min(depth, 4) : 1;
  const motionDepth = submerged ? Math.min(depth, 6) : 0;
  const wobble = submerged && depth < STILL_DEPTH;
  // The sway reads the depth from a shared value, so a row moving one step
  // deeper on a line change updates a number instead of rebuilding its
  // animated style.
  const swayDepth = useSharedValue(motionDepth);
  useEffect(() => {
    swayDepth.value = motionDepth;
  }, [motionDepth, swayDepth]);

  const submergedColor =
    submerged && shallow
      ? interpolateColor(DEPTH_MIX[styleDepth - 1], [0, 1], [tide.text, shallow])
      : tide.text;
  const shadowRadius = DEPTH_SHADOW_RADIUS[styleDepth - 1];

  // Deps intentionally omit `text`/`blind`: the wobble only ever depends on
  // whether this row sways and the shared values it reads.
  const wobbleStyle = useAnimatedStyle(() => {
    'worklet';
    if (!wobble || !time) return {};
    const t = time.value;
    const d = swayDepth.value;
    return {
      transform: [
        { translateX: (1.5 + 0.6 * d) * Math.sin(0.4 * t + d * 1.7) },
        { scaleY: 1 + 0.012 * Math.sin(0.3 * t + d) },
      ],
    };
  }, [wobble, time]);

  const row = (
    <Frost frosted={blind}>
      <Text
        style={
          submerged
            ? [
                styles.dimText,
                {
                  color: submergedColor,
                  opacity: DEPTH_OPACITY[styleDepth - 1],
                  textShadowColor: submergedColor,
                  textShadowOffset: { width: 0, height: 0 },
                  textShadowRadius: Platform.OS === 'android' ? Math.min(shadowRadius, 5) : shadowRadius,
                },
              ]
            : styles.dimText
        }
      >
        {text}
      </Text>
    </Frost>
  );

  return (
    <Pressable
      onPress={() => onPress(index)}
      onLayout={onRowLayout ? (e) => onRowLayout(index, e.nativeEvent.layout.height) : undefined}
      style={styles.dimLine}
      accessibilityRole="button"
      accessibilityLabel={tone === 'past' ? 'Previous line' : 'Next line'}
    >
      {submerged ? (
        <Animated.View style={[styles.submergedRow, wobbleStyle]}>{row}</Animated.View>
      ) : (
        <View style={styles.dimCard}>{row}</View>
      )}
    </Pressable>
  );
});

/** design: `--wl: 62 - t*5%` (t on a 0..4 scale here becomes lineIndex / (lineCount-1)). */
function waterlineFraction(lineIndex: number, lineCount: number) {
  return WL_MAX - 0.2 * (lineIndex / Math.max(1, lineCount - 1));
}

const styles = StyleSheet.create({
  fill: { flex: 1, overflow: 'hidden' },
  star: {
    position: 'absolute',
    width: 2,
    height: 2,
    borderRadius: 1,
    backgroundColor: '#FFFFFF',
    zIndex: 1,
  },
  scroll: { flex: 1, zIndex: 2 },
  content: { position: 'relative' },
  measure: { position: 'absolute', left: 0, right: 0, top: 0, opacity: 0 },
  active: {
    paddingLeft: 16,
    paddingRight: 16,
    paddingBottom: 10,
    zIndex: 3,
  },
  // Sits where the previous active card was, with the card's own padding, so
  // the copy lifts away from roughly where the line was read.
  outgoing: {
    position: 'absolute',
    left: 0,
    right: 0,
    paddingLeft: 32,
    paddingRight: 32,
    paddingTop: 14,
    zIndex: 3,
  },
  outgoingText: {
    fontFamily: fonts.serifJp,
    fontSize: 22,
    lineHeight: 32,
    textAlign: 'center',
    color: tide.text,
  },
  water: {
    flexGrow: 1,
    overflow: 'visible',
    paddingLeft: 16,
    paddingRight: 16,
    paddingTop: 8,
    zIndex: 2,
  },
  waterBody: {
    position: 'absolute',
    left: 0,
    right: 0,
    top: 20,
    bottom: 0,
  },
  dimLine: {
    paddingLeft: 16,
    paddingRight: 16,
    paddingVertical: 5,
  },
  dimCard: {
    borderRadius: Radius.md,
    borderWidth: 1,
    borderColor: tide.waterline,
    backgroundColor: tide.water,
    paddingVertical: 10,
    paddingHorizontal: 16,
    opacity: 0.55,
  },
  submergedRow: {
    paddingVertical: 10,
    paddingHorizontal: 16,
  },
  dimText: {
    fontFamily: fonts.serifJp,
    fontSize: 18,
    lineHeight: 28,
    textAlign: 'center',
    color: tide.text,
  },
  countdownWrap: {
    alignItems: 'center',
    justifyContent: 'center',
    zIndex: 4,
  },
  countdown: {
    fontFamily: fonts.serifLight,
    fontSize: 200,
    lineHeight: 210,
    color: 'rgba(255,158,128,0.18)',
    fontVariant: ['tabular-nums'],
  },
  marks: {
    position: 'absolute',
    left: 10,
    top: '40%',
    bottom: '34%',
    flexDirection: 'column',
    justifyContent: 'space-between',
    zIndex: 4,
  },
  mark: { width: 14, height: 2, borderRadius: 1, backgroundColor: 'rgba(255,255,255,0.2)' },
  markPending: {},
  markDone: {
    backgroundColor: tide.lang.ja,
    boxShadow: '0 0 8px rgba(255,158,128,0.8)',
  },
  markActive: {
    position: 'absolute',
    top: 0,
    left: 0,
    width: 18,
    height: 2,
    borderRadius: 1,
    backgroundColor: tide.text,
  },
  bannerWrap: {
    zIndex: 5,
  },
  pillWrap: {
    position: 'absolute',
    top: 10,
    left: 0,
    right: 88,
    alignItems: 'center',
    zIndex: 6,
  },
  pill: {
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderRadius: Radius.pill,
    backgroundColor: 'rgba(255,255,255,0.1)',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.15)',
  },
  pillText: {
    fontFamily: fonts.ui,
    fontSize: 12,
    color: tide.text,
  },
});
