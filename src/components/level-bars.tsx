import { useEffect, useRef } from 'react';
import { Animated, StyleSheet, View } from 'react-native';
import type { SharedValue } from 'react-native-reanimated';

import { Radius, tide } from '@/constants/theme';

const BARS = 28;
const MIN_H = 4;
const MAX_H = 56;
const PUSH_MS = 80;

// Metering is dBFS. Measured on Sean's iPhone: silence -160, speech -42 to -7
// with a median near -19. Below the gate is drawn as silence so room noise
// cannot move the bars; from the gate to the ceiling the height is linear.
const GATE_DB = -45;
const CEILING_DB = -10;

/** dBFS to 0..1: flat below the gate, full height at the ceiling. */
export function meterLevel(db: number | undefined): number {
  if (db === undefined || !Number.isFinite(db) || db < GATE_DB) return 0;
  return Math.min(1, (db - GATE_DB) / (CEILING_DB - GATE_DB));
}

type Props = {
  /** Current loudness, 0..1, already noise-gated by the caller. A shared
   * value so the caller's meter never renders this component; the interval
   * below reads it from JS. */
  level: SharedValue<number>;
  /** While true the history scrolls; when false it flattens out. */
  live: boolean;
};

/**
 * Scrolling level history, voice-memo style. Every PUSH_MS the latest reading
 * enters on the right and the rest shift left, so the picture is made only of
 * real microphone levels: silence is a flat line, speech is what moves it.
 * Nothing here is synthetic. Animated only smooths each bar's height change.
 */
export function LevelBars({ level, live }: Props) {
  const heights = useRef(
    Array.from({ length: BARS }, () => new Animated.Value(MIN_H)),
  ).current;
  const history = useRef<number[]>(new Array<number>(BARS).fill(0));

  useEffect(() => {
    const paint = () => {
      history.current.forEach((v, i) => {
        Animated.timing(heights[i]!, {
          toValue: MIN_H + (MAX_H - MIN_H) * v,
          duration: PUSH_MS,
          useNativeDriver: false,
        }).start();
      });
    };

    if (!live) {
      history.current = new Array<number>(BARS).fill(0);
      paint();
      return;
    }
    const timer = setInterval(() => {
      const v = level.value;
      history.current = [...history.current.slice(1), Number.isFinite(v) ? v : 0];
      paint();
    }, PUSH_MS);
    return () => clearInterval(timer);
  }, [live, heights, level]);

  return (
    <View style={styles.row} accessibilityLabel="Microphone level">
      {heights.map((h, i) => (
        <Animated.View
          key={i}
          style={[styles.bar, { height: h, backgroundColor: live ? tide.record : tide.waterline }]}
        />
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  row: {
    height: MAX_H,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 3,
  },
  bar: { width: 5, borderRadius: Radius.sm },
});
