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

import { fonts } from '@/constants/fonts';
import { tide } from '@/constants/theme';
import { hapticImpact } from '@/lib/haptics';

/** Distance between two ticks, one step apart. */
const STEP = 12;
const TICK_AREA_H = 18;
const TICK_LABEL_H = 12;
export const TICK_RULER_H = TICK_AREA_H + TICK_LABEL_H;
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
};

/**
 * A strip of small ticks sliding under a fixed centre mark, like a camera
 * zoom wheel. Drag or fling it and it snaps to the nearest step, with a light
 * haptic on every step it passes; a tap on a tick jumps there. Reduced motion
 * turns the fling and the settle animation off, but it still snaps.
 */
export function TickRuler({ width, steps, index, onIndexChange, onSettle, isMajor, tickLabel, accessibilityLabel }: Props) {
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
  const step = useCallback((i: number) => {
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
      scheduleOnRN(step, i);
    },
    [last, step],
  );

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
      scheduleOnRN(settle, target);
      if (reducedMotion) {
        offset.value = -target * STEP;
        busy.value = false;
        return;
      }
      offset.value = withTiming(-target * STEP, { duration: SETTLE_MS, easing: Easing.out(Easing.cubic) }, (finished) => {
        // A new drag cancelling this one keeps the ruler busy.
        if (finished) busy.value = false;
      });
    });
  const tap = Gesture.Tap()
    .maxDistance(8)
    .onEnd((e, success) => {
      if (!success) return;
      const target = Math.min(last, Math.max(0, Math.round((e.x - width / 2 - offset.value) / STEP)));
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
    step(target);
    settle(target);
  }

  return (
    <GestureDetector gesture={gesture}>
      <View
        style={[styles.ruler, { width }]}
        accessible
        accessibilityRole="adjustable"
        accessibilityLabel={accessibilityLabel}
        accessibilityActions={[{ name: 'increment' }, { name: 'decrement' }]}
        onAccessibilityAction={(e) => adjust(e.nativeEvent.actionName === 'increment' ? 1 : -1)}>
        <Animated.View style={[styles.strip, { left: width / 2 - STEP / 2 }, stripStyle]}>
          {Array.from({ length: steps }, (_, i) => {
            const major = isMajor(i);
            return (
              <View key={i} style={styles.cell}>
                <View style={styles.tickArea}>
                  <View style={[styles.tick, major && styles.tickMajor]} />
                </View>
                <Text style={styles.tickLabel} numberOfLines={1}>
                  {major ? tickLabel(i) : ''}
                </Text>
              </View>
            );
          })}
        </Animated.View>
        <View style={[styles.indicator, { left: width / 2 - 1 }]} pointerEvents="none" />
      </View>
    </GestureDetector>
  );
}

const styles = StyleSheet.create({
  ruler: { height: TICK_RULER_H, overflow: 'hidden' },
  strip: { position: 'absolute', top: 0, flexDirection: 'row' },
  cell: { width: STEP, alignItems: 'center' },
  tickArea: { height: TICK_AREA_H, justifyContent: 'flex-end', paddingBottom: 2 },
  tick: { width: 1.5, height: 7, borderRadius: 1, backgroundColor: 'rgba(255,255,255,0.3)' },
  tickMajor: { height: 12, backgroundColor: 'rgba(255,255,255,0.6)' },
  // Wider than the cell and centred on it, so "10" is not clipped.
  tickLabel: {
    width: 2 * STEP,
    height: TICK_LABEL_H,
    textAlign: 'center',
    fontFamily: fonts.ui,
    fontSize: 9,
    lineHeight: TICK_LABEL_H,
    color: tide.textDim,
    fontVariant: ['tabular-nums'],
  },
  indicator: {
    position: 'absolute',
    top: 0,
    width: 2,
    height: TICK_AREA_H,
    borderRadius: 1,
    backgroundColor: tide.lang.ja,
  },
});
