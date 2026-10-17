import { useEffect } from 'react';
import { StyleSheet, View } from 'react-native';
import Animated, { type SharedValue, useAnimatedStyle, useSharedValue, withTiming } from 'react-native-reanimated';

import { Radius, tide } from '@/constants/theme';
import { useT } from '@/lib/i18n';

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
 * Nothing here is synthetic. Reanimated smooths each bar's height change on the UI thread.
 */
export function LevelBars({ level, live }: Props) {
  const { t } = useT();
  const history = useSharedValue<number[]>(new Array<number>(BARS).fill(0));

  useEffect(() => {
    if (!live) {
      history.value = new Array<number>(BARS).fill(0);
      return;
    }
    const timer = setInterval(() => {
      const v = level.value;
      history.value = [...history.value.slice(1), Number.isFinite(v) ? v : 0];
    }, PUSH_MS);
    return () => clearInterval(timer);
  }, [live, history, level]);

  return (
    <View style={styles.row} accessibilityLabel={t('player.microphoneLevel')}>
      {Array.from({ length: BARS }, (_, i) => (
        <Bar key={i} index={i} history={history} color={live ? tide.record : tide.waterline} />
      ))}
    </View>
  );
}

/** One bar: its height follows its slot in the shared history on the UI thread. */
function Bar({ index, history, color }: { index: number; history: SharedValue<number[]>; color: string }) {
  const style = useAnimatedStyle(() => {
    const raw = history.value[index];
    const v = typeof raw === 'number' && Number.isFinite(raw) ? Math.min(1, Math.max(0, raw)) : 0;
    return { height: withTiming(MIN_H + (MAX_H - MIN_H) * v, { duration: PUSH_MS }) };
  });
  return <Animated.View style={[styles.bar, style, { backgroundColor: color }]} />;
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
