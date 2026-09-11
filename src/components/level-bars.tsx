import { useEffect, useRef } from 'react';
import { Animated, StyleSheet, View } from 'react-native';

import { Radius } from '@/constants/theme';
import { useTheme } from '@/hooks/use-theme';

const BARS = 28;
const MIN_H = 4;
const MAX_H = 56;
const PUSH_MS = 80;

type Props = {
  /** Current loudness, 0..1, already noise-gated by the caller. */
  level: number;
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
  const { palette } = useTheme();
  const heights = useRef(
    Array.from({ length: BARS }, () => new Animated.Value(MIN_H)),
  ).current;
  const history = useRef<number[]>(new Array<number>(BARS).fill(0));
  const levelRef = useRef(level);
  levelRef.current = level;

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
      history.current = [...history.current.slice(1), levelRef.current];
      paint();
    }, PUSH_MS);
    return () => clearInterval(timer);
  }, [live, heights]);

  return (
    <View style={styles.row} accessibilityLabel="Microphone level">
      {heights.map((h, i) => (
        <Animated.View
          key={i}
          style={[styles.bar, { height: h, backgroundColor: live ? palette.accent : palette.line }]}
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
