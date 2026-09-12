import { Pressable, StyleSheet, Text, View } from 'react-native';
import Animated, { useAnimatedProps, type SharedValue } from 'react-native-reanimated';
import Svg, { Circle } from 'react-native-svg';

import { useTheme } from '@/hooks/use-theme';

export type RingMode = 'idle' | 'playing' | 'breath';

const AnimatedCircle = Animated.createAnimatedComponent(Circle);

type Props = {
  size?: number;
  /** 0..1, animated on the UI thread by the screen: fills while playing,
   * drains during the breath. */
  progress: SharedValue<number>;
  mode: RingMode;
  /** Seconds left in the breath, shown in the middle. */
  countdown?: number | null;
  onPress: () => void;
};

/**
 * The one big control. A ring around a Play/Stop button carries the state:
 * empty at rest, filling while the line plays, draining through the breath
 * with the countdown in the middle. The arc is driven by a shared value so it
 * moves at the display's frame rate without touching JavaScript.
 */
export function RingButton({ size = 176, progress, mode, countdown = null, onPress }: Props) {
  const { palette } = useTheme();
  const stroke = 8;
  const r = (size - stroke) / 2;
  const c = 2 * Math.PI * r;
  const active = mode !== 'idle';

  const arc = useAnimatedProps(() => ({
    strokeDashoffset: c * (1 - Math.max(0, Math.min(1, progress.value))),
  }));

  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={active ? 'Stop' : 'Play'}
      style={[styles.wrap, { width: size, height: size }]}>
      <Svg width={size} height={size} style={StyleSheet.absoluteFill}>
        <Circle cx={size / 2} cy={size / 2} r={r} stroke={palette.line} strokeWidth={stroke} fill="none" />
        <AnimatedCircle
          cx={size / 2}
          cy={size / 2}
          r={r}
          stroke={palette.accent}
          strokeWidth={stroke}
          strokeLinecap="round"
          fill="none"
          strokeDasharray={`${c} ${c}`}
          animatedProps={arc}
          rotation={-90}
          origin={`${size / 2}, ${size / 2}`}
        />
      </Svg>
      <View style={[styles.core, { backgroundColor: active ? palette.accent : palette.surfaceAlt }]}>
        {mode === 'breath' && countdown !== null ? (
          <Text style={[styles.count, { color: palette.accentInk }]}>{countdown}</Text>
        ) : active ? (
          <View style={[styles.stop, { backgroundColor: palette.accentInk }]} />
        ) : (
          <View style={[styles.play, { borderLeftColor: palette.ink }]} />
        )}
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  wrap: { alignItems: 'center', justifyContent: 'center' },
  core: { width: '72%', height: '72%', borderRadius: 999, alignItems: 'center', justifyContent: 'center' },
  count: { fontSize: 40, fontWeight: '300', fontVariant: ['tabular-nums'] },
  stop: { width: 30, height: 30, borderRadius: 6 },
  play: {
    width: 0,
    height: 0,
    marginLeft: 8,
    borderTopWidth: 20,
    borderBottomWidth: 20,
    borderLeftWidth: 34,
    borderTopColor: 'transparent',
    borderBottomColor: 'transparent',
  },
});
