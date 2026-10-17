import { useCallback, useEffect, useRef } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import Animated, {
  cancelAnimation,
  Easing,
  useAnimatedReaction,
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
  withTiming,
} from 'react-native-reanimated';
import { scheduleOnRN } from 'react-native-worklets';

import { POP } from '@/components/tide/popover-bubble';
import { fonts } from '@/constants/fonts';
import { hapticImpact } from '@/lib/haptics';

/** Default distance between two ticks, one step apart. */
const DEFAULT_STEP = 12;
export const TICK_RULER_H = 56;
const GROOVE_TOP = 4;
const GROOVE_H = 36;
/** How far a fling carries past the finger, in seconds of its velocity. */
const FLING_S = 0.12;
const SETTLE_MS = 180;

type Props = {
  /** The ruler's own width; the indicator sits at its centre. */
  width: number;
  /** Number of steps, 0 to steps - 1. */
  steps: number;
  index: number;
  /** Every step the ruler passes, while dragging or settling. */
  onIndexChange: (index: number) => void;
  /** The step the ruler comes to rest on, once per drag, tap or adjust. */
  onSettle?: (index: number) => void;
  /** Ticks that get a taller mark and a number under them. */
  isMajor: (index: number) => boolean;
  tickLabel: (index: number) => string;
  /** Read out by screen readers, e.g. "Times, 2x". */
  accessibilityLabel: string;
  /** Distance between two ticks. */
  step?: number;
  /** Ruler height. Default TICK_RULER_H. */
  height?: number;
  /** Hide the labels under the groove (a one-line ruler). */
  noLabels?: boolean;
  /** Colour the ruler's ends fade into. Unset means no fade. */
  fadeColor?: string;
};

/**
 * A strip of small ticks sliding under a fixed centre mark, like a camera
 * zoom wheel. Drag or fling it and it snaps to the nearest step, with a light
 * haptic on every step it passes; a tap on a tick jumps there. Reduced motion
 * turns the fling and the settle animation off, but it still snaps.
 */
export function TickRuler({
  width,
  steps,
  index,
  onIndexChange,
  onSettle,
  isMajor,
  tickLabel,
  accessibilityLabel,
  step: stepProp,
  height = TICK_RULER_H,
  noLabels,
  fadeColor,
}: Props) {
  const STEP = stepProp ?? DEFAULT_STEP;
  const grooveH = Math.round((GROOVE_H * height) / TICK_RULER_H);
  const grooveTop = noLabels ? Math.round((height - grooveH) / 2) : Math.round((GROOVE_TOP * height) / TICK_RULER_H);
  const scale = height / TICK_RULER_H;
  const fadeW = Math.round(width * 0.16);
  const reducedMotion = useReducedMotion();
  const last = steps - 1;
  // The strip's translateX: tick i sits under the centre mark at -i * STEP.
  const offset = useSharedValue(-index * STEP);
  const dragStart = useSharedValue(0);
  // The last step reported to the parent.
  const reported = useSharedValue(index);
  // True from a drag or tap until the strip is at rest, so a parent render
  // from a step reported mid-flight never yanks the strip back.
  const busy = useSharedValue(false);
  const panning = useSharedValue(false);

  // Stable JS callbacks for the worklets below, reading the latest props.
  const handlers = useRef({ onIndexChange, onSettle });
  handlers.current = { onIndexChange, onSettle };
  const reportStep = useCallback((i: number) => {
    void hapticImpact();
    handlers.current.onIndexChange(i);
  }, []);
  const settle = useCallback((i: number) => {
    handlers.current.onSettle?.(i);
  }, []);

  // A value set from outside (a settings load) moves the strip without
  // reporting steps back.
  useEffect(() => {
    if (busy.value || reported.value === index) return;
    reported.value = index;
    cancelAnimation(offset);
    offset.value = -index * STEP;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [index]);

  useAnimatedReaction(
    () => Math.min(last, Math.max(0, Math.round(-offset.value / STEP))),
    (i) => {
      if (i === reported.value) return;
      reported.value = i;
      scheduleOnRN(reportStep, i);
    },
    [last, reportStep],
  );

  // Reports the step and glides the strip onto it (or jumps, with reduced motion).
  const settleTo = (target: number) => {
    'worklet';
    scheduleOnRN(settle, target);
    busy.value = true;
    if (reducedMotion) {
      offset.value = -target * STEP;
      busy.value = false;
      return;
    }
    offset.value = withTiming(-target * STEP, { duration: SETTLE_MS, easing: Easing.out(Easing.cubic) }, (finished) => {
      // A new drag cancelling this one keeps the ruler busy.
      if (finished) busy.value = false;
    });
  };

  const pan = Gesture.Pan()
    .activeOffsetX([-4, 4])
    .onStart(() => {
      cancelAnimation(offset);
      busy.value = true;
      panning.value = true;
      dragStart.value = offset.value;
    })
    .onUpdate((e) => {
      offset.value = Math.min(0, Math.max(-last * STEP, dragStart.value + e.translationX));
    })
    .onFinalize((e) => {
      if (!panning.value) return;
      panning.value = false;
      const projected = reducedMotion ? offset.value : offset.value + e.velocityX * FLING_S;
      const target = Math.min(last, Math.max(0, Math.round(-projected / STEP)));
      settleTo(target);
    });
  const tap = Gesture.Tap()
    .maxDistance(8)
    .onEnd((e, success) => {
      if (!success) return;
      const target = Math.min(last, Math.max(0, Math.round((e.x - width / 2 - offset.value) / STEP)));
      settleTo(target);
    });
  const gesture = Gesture.Race(pan, tap);

  const stripStyle = useAnimatedStyle(() => ({ transform: [{ translateX: offset.value }] }));

  // Screen readers swipe up or down to move one step.
  function adjust(delta: number) {
    const target = Math.min(last, Math.max(0, index + delta));
    if (target === index) return;
    reported.value = target;
    cancelAnimation(offset);
    // cancelAnimation resolves a running settle's withTiming callback with
    // finished: false, so without this, an accessibility adjust mid-settle
    // would leave busy stuck true and lock out the next external index sync.
    busy.value = false;
    offset.value = -target * STEP;
    reportStep(target);
    settle(target);
  }

  return (
    <GestureDetector gesture={gesture}>
      <View
        style={[styles.ruler, { width, height }]}
        accessible
        accessibilityRole="adjustable"
        accessibilityLabel={accessibilityLabel}
        accessibilityActions={[{ name: 'increment' }, { name: 'decrement' }]}
        onAccessibilityAction={(e) => adjust(e.nativeEvent.actionName === 'increment' ? 1 : -1)}>
        <View style={[styles.groove, { top: grooveTop, height: grooveH, borderRadius: grooveH / 2 }]} pointerEvents="none">
          <View style={[StyleSheet.absoluteFill, styles.grooveRing, { borderRadius: grooveH / 2 }]} />
        </View>
        <Animated.View style={[styles.strip, { left: width / 2 - STEP / 2 }, stripStyle]}>
          {Array.from({ length: steps }, (_, i) => {
            const major = isMajor(i);
            return (
              <View key={i} style={[styles.cell, { width: STEP }]}>
                <View style={[styles.tickArea, { top: grooveTop, height: grooveH }]}>
                  <View style={[styles.tick, major ? { height: Math.round(20 * scale), backgroundColor: POP.tickMajor } : { height: Math.round(11 * scale) }]} />
                </View>
                {noLabels ? null : (
                  <Text style={[styles.tickLabel, { width: 2 * STEP, left: -STEP / 2 }]} numberOfLines={1}>
                    {major ? tickLabel(i) : ''}
                  </Text>
                )}
              </View>
            );
          })}
        </Animated.View>
        {fadeColor ? (
          <>
            <FadeEdge color={fadeColor} width={fadeW} side="left" />
            <FadeEdge color={fadeColor} width={fadeW} side="right" />
          </>
        ) : null}
        <View
          style={[styles.indicator, { left: width / 2 - 1, height: Math.round(44 * scale), top: noLabels ? Math.round((height - 44 * scale) / 2) : 0 }]}
          pointerEvents="none"
        />
      </View>
    </GestureDetector>
  );
}

const FADE_BANDS = 8;

/** An edge fade built from stacked bands of falling opacity, no gradient package. */
function FadeEdge({ color, width, side }: { color: string; width: number; side: 'left' | 'right' }) {
  const band = width / FADE_BANDS;
  return (
    <View pointerEvents="none" style={[styles.fade, { width }, side === 'left' ? { left: 0 } : { right: 0 }]}>
      {Array.from({ length: FADE_BANDS }, (_, i) => {
        // Left edge: opaque at the outside. Right edge: mirrored.
        const k = side === 'left' ? i : FADE_BANDS - 1 - i;
        return (
          <View
            key={i}
            style={{ position: 'absolute', top: 0, bottom: 0, left: i * band, width: band + 0.5, backgroundColor: color, opacity: 1 - (k + 0.5) / FADE_BANDS }}
          />
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  ruler: { overflow: 'hidden' },
  groove: { position: 'absolute', left: 0, right: 0, backgroundColor: 'rgba(0,0,0,0.34)' },
  grooveRing: { borderWidth: 1, borderColor: 'rgba(255,255,255,0.08)' },
  strip: { position: 'absolute', top: 0, bottom: 0, flexDirection: 'row' },
  cell: { alignItems: 'center', height: '100%' },
  tickArea: { position: 'absolute', left: 0, right: 0, alignItems: 'center', justifyContent: 'center' },
  tick: { width: 2, borderRadius: 1, backgroundColor: POP.tickMinor },
  fade: { position: 'absolute', top: 0, bottom: 0 },
  // Wider than the cell and centred on it, so "10" is not clipped.
  tickLabel: {
    position: 'absolute',
    bottom: 1,
    height: 12,
    textAlign: 'center',
    fontFamily: fonts.ui,
    fontSize: 10,
    lineHeight: 12,
    color: POP.offInk,
    fontVariant: ['tabular-nums'],
  },
  indicator: {
    position: 'absolute',
    top: 0,
    width: 2,
    borderRadius: 1,
    backgroundColor: POP.goldInk,
    boxShadow: '0 0 10 rgba(255,200,87,0.7)',
  },
});
