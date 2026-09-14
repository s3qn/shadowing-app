import { StyleSheet, View } from 'react-native';
import Animated, { useAnimatedProps, type SharedValue } from 'react-native-reanimated';
import Svg, { Circle } from 'react-native-svg';

import { PressScale } from '@/components/press-scale';
import { tide } from '@/constants/theme';

export type RingMode = 'idle' | 'playing' | 'breath';

const AnimatedCircle = Animated.createAnimatedComponent(Circle);

type Props = {
  size?: number;
  /** 0..1, animated on the UI thread by the screen: fills while playing,
   * drains during the breath. */
  progress: SharedValue<number>;
  mode: RingMode;
  onPress: () => void;
};

/**
 * The one big control. A ring around a Play/Stop button carries the state:
 * empty at rest, filling while the line plays, draining through the breath.
 * The scene shows the breath's countdown; this button only fills and drains.
 * The arc is driven by a shared value so it moves at the display's frame
 * rate without touching JavaScript.
 */
export function RingButton({ size = 84, progress, mode, onPress }: Props) {
  const stroke = 4;
  const r = (size - stroke) / 2;
  const c = 2 * Math.PI * r;
  const active = mode !== 'idle';

  const arc = useAnimatedProps(() => ({
    strokeDashoffset: c * (1 - Math.max(0, Math.min(1, progress.value))),
  }));

  return (
    <PressScale
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={active ? 'Stop' : 'Play'}
      style={[styles.wrap, { width: size, height: size }]}>
      <Svg width={size} height={size} style={StyleSheet.absoluteFill}>
        <Circle cx={size / 2} cy={size / 2} r={r} stroke="rgba(255,255,255,0.15)" strokeWidth={stroke} fill="none" />
        <AnimatedCircle
          cx={size / 2}
          cy={size / 2}
          r={r}
          stroke={tide.lang.ja}
          strokeWidth={stroke}
          strokeLinecap="round"
          fill="none"
          strokeDasharray={`${c} ${c}`}
          animatedProps={arc}
          rotation={-90}
          origin={`${size / 2}, ${size / 2}`}
        />
      </Svg>
      <View style={[styles.core, { backgroundColor: active ? tide.lang.ja : 'rgba(255,255,255,0.1)' }]}>
        {active ? <View style={styles.stop} /> : <View style={styles.play} />}
      </View>
    </PressScale>
  );
}

const styles = StyleSheet.create({
  wrap: { alignItems: 'center', justifyContent: 'center' },
  core: { width: '72%', height: '72%', borderRadius: 999, alignItems: 'center', justifyContent: 'center' },
  stop: { width: 18, height: 18, borderRadius: 2, backgroundColor: tide.sky[0] },
  play: {
    width: 0,
    height: 0,
    marginLeft: 5,
    borderTopWidth: 13,
    borderBottomWidth: 13,
    borderLeftWidth: 22,
    borderTopColor: 'transparent',
    borderBottomColor: 'transparent',
    borderLeftColor: tide.text,
  },
});
