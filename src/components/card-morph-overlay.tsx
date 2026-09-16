import { useEffect, useRef, useState } from 'react';
import { StyleSheet, Text, useWindowDimensions } from 'react-native';
import Animated, {
  cancelAnimation,
  Easing,
  Extrapolation,
  interpolate,
  runOnJS,
  runOnUI,
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
  withDelay,
  withTiming,
} from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { PlayerTitle } from '@/components/tide/player-title';
import { fonts } from '@/constants/fonts';
import { Spacing, tide } from '@/constants/theme';
import {
  covered,
  finish,
  headerBoxRect,
  land,
  openPush,
  PLAYER_HEADER_BUTTON,
  PLAYER_HEADER_ROW_H,
  readyWaitingUI,
  setLandHandler,
  setMorphEnabled,
  subscribe,
  subscribeHeaderBox,
  subscribePlayerGone,
  type CardRect,
  type MorphState,
} from '@/lib/card-morph';
import { releaseReveal, revealLinesReady } from '@/lib/content-reveal';
import { loaderCoverSkip, loaderRequest } from '@/lib/loading-overlay';
import { useSkyStyle } from '@/lib/sky';

const MORPH_MS = 380;
const REVEAL_MS = 160;
const BACK_MS = 320;
const COVER_MS = 120;
// One frame: a landing started before native drew the player's content waits this.
const LAND_FRAME_MS = 16;
// Pushes the player at the tap, not partway into the flight: Home's cards
// vanish under the growing card, but nothing swaps visibly under the box.
const PUSH_AT_MS = 0;
// How long a back waits, fully covered, for the player to unmount before it
// shrinks anyway.
const GONE_TIMEOUT_MS = 300;
const MORPH_EASING = Easing.bezier(0.2, 0.8, 0.2, 1);
// The header chrome drawn by the overlay comes in over the second half of the
// open (and leaves over the first half of the shrink), from this scale.
const CHROME_FROM_T = 0.5;
const CHROME_SCALE_FROM = 0.85;
// Where the island card's title sits inside the card: its 1px border plus
// its inner padding (12 across, 11 down).
const CARD_INSET_X = 13;
const CARD_INSET_Y = 12;
const CARD_RADIUS = 16;
// Where the flying header title block sits inside its slot-wide box (its left
// offset once centered, and its height), per title and line row, so a repeat
// open has it on the first frame instead of after a layout pass.
const blockSizes = new Map<string, { x: number; height: number }>();

function finite(n: number, fallback = 0) {
  'worklet';
  return typeof n === 'number' && Number.isFinite(n) ? n : fallback;
}

/**
 * Renders the card-to-player morph above the router `Stack`. Idle, it
 * renders nothing (no view at all, so it never intercepts touches); while a
 * morph is running it swallows taps so a double tap or a mid-flight back
 * press does nothing.
 *
 * The overlay owns the whole transition (the route itself does not animate).
 * On open the card grows over Home with the header's back and menu buttons
 * arriving on it, the player is pushed under the full cover, and the cover
 * fades once the player has its content on screen. On back (the player has
 * already faded its content out) the cover fades in over the player with the
 * header drawn on top, the player is popped under it, and once it is gone the
 * cover shrinks into the card while the header chrome fades.
 */
export function CardMorphOverlay() {
  const [state, setState] = useState<MorphState | null>(null);
  const reducedMotion = useReducedMotion();

  useEffect(() => subscribe(setState), []);
  useEffect(() => {
    setMorphEnabled(!reducedMotion);
  }, [reducedMotion]);

  useEffect(() => {
    if (!state || !reducedMotion) return;
    // A morph that started just before reduced motion turned on.
    covered();
    finish();
  }, [state, reducedMotion]);

  if (!state || reducedMotion) return null;
  return <MorphRun key={state.serial} state={state} />;
}

function MorphRun({ state }: { state: MorphState }) {
  const { width: winW, height: winH } = useWindowDimensions();
  const insets = useSafeAreaInsets();
  const sky = useSkyStyle();
  const { phase, stage, rect, title, chrome } = state;

  // Fresh values per morph (this component is keyed by the morph's serial),
  // so the first frame already shows the phase's start state.
  const t = useSharedValue(phase === 'open' ? 0 : 1);
  const boxOpacity = useSharedValue(phase === 'open' ? 1 : 0);
  // 1 once the landing (the cover fade) has started, from either thread.
  const landedUI = useSharedValue(0);
  // Counts out the one frame a landing from the player's layout effect waits.
  const landFrame = useSharedValue(0);
  const openLine = state.line ?? { lineIndex: 0, lineCount: 0 };
  const blockKey = `${title}|${openLine.lineIndex}|${openLine.lineCount}`;
  const knownBlock = blockSizes.get(blockKey);
  const blockX = useSharedValue(knownBlock?.x ?? 0);
  const blockH = useSharedValue(knownBlock?.height ?? 0);
  const blockMeasured = useSharedValue(knownBlock ? 1 : 0);
  const [headerBox, setHeaderBox] = useState<CardRect | null>(headerBoxRect);

  useEffect(() => subscribeHeaderBox(setHeaderBox), []);

  const alive = useRef(true);
  const shrinkFrame = useRef(0);
  const goneTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const stopGone = useRef<(() => void) | null>(null);
  const pushTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // JS side of an open morph's cover: the loader mutable, and the landing
  // when the player was ready first, already ran on the UI thread.
  function onOpenCovered() {
    covered();
  }

  // JS side of the open reveal finishing: the cover is gone and the player's
  // own chrome shows underneath from here on.
  function onOpenCoverGone() {
    finish();
  }

  function shrink() {
    if (!alive.current) return;
    t.value = withTiming(0, { duration: BACK_MS, easing: MORPH_EASING }, (backDone) => {
      if (backDone) runOnJS(land)();
    });
  }

  // Pops the player under the full cover, and shrinks into the card only once
  // the player has unmounted and two more frames have passed: its native
  // teardown then lands while nothing moves, never mid-shrink, and Home is the
  // screen around the shrinking card.
  function onBackCovered() {
    let started = false;
    const go = () => {
      if (started || !alive.current) return;
      started = true;
      stopGone.current?.();
      stopGone.current = null;
      if (goneTimer.current !== null) clearTimeout(goneTimer.current);
      goneTimer.current = null;
      shrinkFrame.current = requestAnimationFrame(() => {
        shrinkFrame.current = requestAnimationFrame(shrink);
      });
    };
    stopGone.current = subscribePlayerGone((goneId) => {
      if (goneId !== state.id) return;
      go();
    });
    goneTimer.current = setTimeout(go, GONE_TIMEOUT_MS);
    covered();
  }

  // The landing: the cover fades and, on open, the content reveal starts, in
  // one UI-thread step. Runs once per morph, whichever thread gets there
  // first; JS only hears about it for bookkeeping.
  // `nextFrame`: the ready signal came from the player's layout effect, before
  // native drew what it committed, so the cover and the reveal wait one frame.
  function landOnUI(open: boolean, nextFrame: boolean) {
    'worklet';
    if (landedUI.value === 1) return;
    landedUI.value = 1;
    const wait = nextFrame === true ? LAND_FRAME_MS : 0;
    const release = () => {
      'worklet';
      // A player still waiting for its lines gets the loader as the cover goes.
      if (readyWaitingUI.value === 1 && revealLinesReady.value !== 1) loaderRequest.value = 1;
      releaseReveal();
    };
    if (open) {
      if (wait > 0) {
        cancelAnimation(landFrame);
        landFrame.value = 0;
        // Cut short, the release never runs here; `finish` releases on JS.
        landFrame.value = withDelay(wait, withTiming(1, { duration: 0 }, (done) => {
          if (done) release();
        }));
      } else {
        release();
      }
    }
    cancelAnimation(boxOpacity);
    boxOpacity.value = withDelay(wait, withTiming(0, { duration: REVEAL_MS }, (done) => {
      if (done) runOnJS(open ? onOpenCoverGone : finish)();
    }));
  }

  function startLanding(nextFrame: boolean) {
    if (!alive.current) return;
    runOnUI(landOnUI)(phase === 'open', nextFrame);
  }

  useEffect(() => {
    setLandHandler(startLanding);
    return () => setLandHandler(null);
    // Once per morph: the component is keyed by its serial.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    alive.current = true;
    if (phase === 'open') {
      pushTimer.current = setTimeout(() => {
        openPush();
      }, PUSH_AT_MS);
      t.value = withTiming(1, { duration: MORPH_MS, easing: MORPH_EASING }, (done) => {
        if (done) {
          // The player already reported ready: land right here, on the UI
          // thread, so the fade never waits on a busy JS thread. Otherwise
          // ask for the loader; the ready signal lands it later.
          const ready = loaderCoverSkip.value === 1;
          if (ready) landOnUI(true, false);
          else loaderRequest.value = 1;
          runOnJS(onOpenCovered)();
        }
      });
    } else {
      boxOpacity.value = withTiming(1, { duration: COVER_MS }, (coverDone) => {
        if (coverDone) runOnJS(onBackCovered)();
      });
    }
    return () => {
      alive.current = false;
      if (pushTimer.current !== null) clearTimeout(pushTimer.current);
      cancelAnimationFrame(shrinkFrame.current);
      if (goneTimer.current !== null) clearTimeout(goneTimer.current);
      stopGone.current?.();
      cancelAnimation(t);
      cancelAnimation(boxOpacity);
      cancelAnimation(landFrame);
    };
    // Runs once per morph: the component is keyed by its serial.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // A fallback only: `land` already called startLanding through the handler,
  // and the UI-thread guard makes this a no-op then.
  useEffect(() => {
    if (stage !== 'landed') return;
    runOnUI(landOnUI)(phase === 'open', false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stage, phase]);

  const fromX = finite(rect.x);
  const fromY = finite(rect.y);
  const fromW = finite(rect.width);
  const fromH = finite(rect.height);
  const toW = finite(winW);
  const toH = finite(winH);

  // A window-sized box moved and scaled from its top-left corner, so each
  // frame is a transform, not a layout pass. Its layers are flat fills and a
  // proportional gradient, which scale to the same look as a box laid out at
  // that size; the 1px border is its own view so it never thins with scale.
  const boxStyle = useAnimatedStyle(() => {
    const p = finite(t.value);
    const w = interpolate(p, [0, 1], [fromW, toW]);
    const h = interpolate(p, [0, 1], [fromH, toH]);
    return {
      opacity: finite(boxOpacity.value),
      transform: [
        { translateX: finite(interpolate(p, [0, 1], [fromX, 0])) },
        { translateY: finite(interpolate(p, [0, 1], [fromY, 0])) },
        { scaleX: toW > 0 ? finite(w / toW, 1) : 1 },
        { scaleY: toH > 0 ? finite(h / toH, 1) : 1 },
      ],
    };
  });

  // The box's corners: CARD_RADIUS on screen at both ends. Mid-flight the
  // scale is uneven, so the radius uses the geometric mean of the two scales.
  const boxRadiusStyle = useAnimatedStyle(() => {
    const p = finite(t.value);
    const sx = toW > 0 ? finite(interpolate(p, [0, 1], [fromW, toW]) / toW, 1) : 1;
    const sy = toH > 0 ? finite(interpolate(p, [0, 1], [fromH, toH]) / toH, 1) : 1;
    const mean = Math.sqrt(Math.max(0, sx * sy));
    return { borderRadius: mean > 0 ? finite(CARD_RADIUS / mean, CARD_RADIUS) : CARD_RADIUS };
  });

  // The card's own glass face (fill and 1px border), laid out at the card's
  // size and scaled with the box, so it matches the card on the first frame
  // and fades before the stretch shows.
  const cardFaceStyle = useAnimatedStyle(() => {
    const p = finite(t.value);
    const w = interpolate(p, [0, 1], [fromW, toW]);
    const h = interpolate(p, [0, 1], [fromH, toH]);
    return {
      opacity: finite(boxOpacity.value) * interpolate(p, [0, 0.2, 0.8], [1, 1, 0], Extrapolation.CLAMP),
      transform: [
        { translateX: finite(interpolate(p, [0, 1], [fromX, 0])) },
        { translateY: finite(interpolate(p, [0, 1], [fromY, 0])) },
        { scaleX: fromW > 0 ? finite(w / fromW, 1) : 1 },
        { scaleY: fromH > 0 ? finite(h / fromH, 1) : 1 },
      ],
    };
  });

  const borderStyle = useAnimatedStyle(() => ({
    opacity: interpolate(finite(t.value), [0, 0.33], [1, 0], Extrapolation.CLAMP),
  }));

  const skyLayerStyle = useAnimatedStyle(() => ({
    opacity: interpolate(finite(t.value), [0.2, 0.8], [0, 1]),
  }));

  // The back and menu buttons: opacity and scale on the same morph progress.
  const buttonStyle = useAnimatedStyle(() => {
    const p = finite(t.value);
    return {
      opacity: interpolate(p, [CHROME_FROM_T, 1], [0, 1], Extrapolation.CLAMP),
      transform: [{ scale: interpolate(p, [CHROME_FROM_T, 1], [CHROME_SCALE_FROM, 1], Extrapolation.CLAMP) }],
    };
  });
  // The header title on back: a fade only, no scale on the text.
  const headerTitleStyle = useAnimatedStyle(() => ({
    opacity: interpolate(finite(t.value), [CHROME_FROM_T, 1], [0, 1], Extrapolation.CLAMP),
  }));

  // The player header's grid, from its measured window rect or, before it has
  // been measured, from a full-width bar at the top of the window.
  const bar = headerBox ?? { x: 0, y: 0, width: toW, height: finite(insets.top) + PLAYER_HEADER_ROW_H };
  const rowTop = bar.y + bar.height - PLAYER_HEADER_ROW_H;
  const buttonTop = rowTop + (PLAYER_HEADER_ROW_H - PLAYER_HEADER_BUTTON) / 2;
  const backLeft = bar.x + Spacing.sm;
  const menuLeft = bar.x + bar.width - Spacing.sm - PLAYER_HEADER_BUTTON;
  const slotLeft = bar.x + Spacing.sm + PLAYER_HEADER_BUTTON;
  const slotWidth = Math.max(0, bar.width - 2 * (Spacing.sm + PLAYER_HEADER_BUTTON));
  const showMenu = phase === 'open' || chrome?.menu !== false;

  // The header's title block (PlayerTitle itself, in a slot-wide box) flies
  // from the card title's spot to the header slot at full size, so nothing
  // changes at the handoff. Hidden until its size is known (one layout pass
  // on a first open of this title), so it never starts from a wrong spot.
  const blockFromX = fromX + CARD_INSET_X;
  const blockFromY = fromY + CARD_INSET_Y;
  const blockToX = slotLeft;
  const blockStyle = useAnimatedStyle(() => {
    const p = finite(t.value);
    const x = finite(blockX.value);
    const h = finite(blockH.value);
    return {
      opacity: finite(blockMeasured.value) > 0 ? 1 : 0,
      transform: [
        { translateX: interpolate(p, [0, 1], [blockFromX - x, blockToX]) },
        { translateY: interpolate(p, [0, 1], [blockFromY, rowTop + (PLAYER_HEADER_ROW_H - h) / 2]) },
      ],
    };
  });

  return (
    <Animated.View pointerEvents="auto" style={StyleSheet.absoluteFill}>
      <Animated.View style={[styles.box, { width: toW, height: toH }, boxStyle, boxRadiusStyle]}>
        <Animated.View style={[StyleSheet.absoluteFill, skyLayerStyle]}>
          <Animated.View style={[StyleSheet.absoluteFill, sky.from]} />
        </Animated.View>
      </Animated.View>
      <Animated.View style={[styles.cardFace, { width: fromW, height: fromH }, cardFaceStyle]}>
        <Animated.View style={[styles.cardBorder, borderStyle]} />
      </Animated.View>
      {/* On open the copies stay over the fading cover until the morph ends,
          identical to the real chrome now showing under it, so the handoff
          has no dip. On back they leave with the shrink. */}
      {phase === 'open' || stage === 'fly' ? (
        <>
          <Animated.View style={[styles.button, { left: backLeft, top: buttonTop }, buttonStyle]}>
            <Text style={styles.backGlyph}>‹</Text>
          </Animated.View>
          {showMenu ? (
            <Animated.View style={[styles.button, { left: menuLeft, top: buttonTop }, buttonStyle]}>
              <Text style={styles.menuGlyph}>…</Text>
            </Animated.View>
          ) : null}
          {phase === 'back' && chrome ? (
            <Animated.View
              style={[
                styles.headerSlot,
                { left: slotLeft, top: rowTop, width: slotWidth, height: PLAYER_HEADER_ROW_H },
                headerTitleStyle,
              ]}>
              <PlayerTitle
                title={chrome.title}
                lineIndex={chrome.lineIndex}
                lineCount={chrome.lineCount}
                placeholder={chrome.placeholder}
              />
            </Animated.View>
          ) : null}
        </>
      ) : null}
      {phase === 'open' ? (
        <Animated.View pointerEvents="none" style={[styles.block, { width: slotWidth }, blockStyle]}>
          <Animated.View
            onLayout={(event) => {
              const x = finite(event.nativeEvent.layout.x);
              const height = finite(event.nativeEvent.layout.height);
              if (height <= 0) return;
              blockSizes.set(blockKey, { x, height });
              blockX.value = x;
              blockH.value = height;
              blockMeasured.value = 1;
            }}>
            <PlayerTitle
              title={title}
              lineIndex={openLine.lineIndex}
              lineCount={openLine.lineCount}
              placeholder
            />
          </Animated.View>
        </Animated.View>
      ) : null}
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  box: { position: 'absolute', left: 0, top: 0, overflow: 'hidden', transformOrigin: 'left top' },
  // The island card's own translucent glass fill and border.
  cardFace: {
    position: 'absolute',
    left: 0,
    top: 0,
    borderRadius: CARD_RADIUS,
    backgroundColor: 'rgba(255,255,255,0.06)',
    transformOrigin: 'left top',
  },
  cardBorder: {
    ...StyleSheet.absoluteFill,
    borderRadius: CARD_RADIUS,
    borderWidth: 1,
    borderColor: 'rgba(236,232,244,0.12)',
  },
  block: { position: 'absolute', left: 0, top: 0, alignItems: 'center' },
  // Match PlayerHeader's buttons, glyphs and title slot in the island screen.
  button: {
    position: 'absolute',
    width: PLAYER_HEADER_BUTTON,
    height: PLAYER_HEADER_BUTTON,
    alignItems: 'center',
    justifyContent: 'center',
  },
  backGlyph: { fontFamily: fonts.ui, fontSize: 28, color: tide.text },
  menuGlyph: { fontFamily: fonts.ui, fontSize: 22, color: tide.text },
  headerSlot: { position: 'absolute', alignItems: 'center', justifyContent: 'center' },
});
