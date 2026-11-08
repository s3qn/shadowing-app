import { Canvas, Fill, LinearGradient, vec } from '@shopify/react-native-skia';
import { useEffect, useState } from 'react';
import { StyleSheet, View } from 'react-native';
import Animated, { type SharedValue, useAnimatedStyle, useSharedValue } from 'react-native-reanimated';

import { tide, withAlpha } from '@/constants/theme';
import { useDir } from '@/lib/i18n';

/**
 * One progress bar. `value` is 0 to 1: a plain number (static) or a
 * SharedValue (animated on the UI thread, no JS state). The fill grows from
 * the reading start, so it fills from the right in Hebrew. The worklet reads
 * only SharedValues and primitives.
 */
export function ProgressBar({
  value,
  color = tide.text,
  height = 4,
  gradient,
}: {
  value: number | SharedValue<number>;
  color?: string;
  height?: number;
  /** Two or more colours: the fill is this gradient across the full track, clipped by the value. */
  gradient?: string[];
}) {
  const dir = useDir();
  const [trackW, setTrackW] = useState(0);
  const own = useSharedValue(typeof value === 'number' ? value : 0);
  useEffect(() => {
    if (typeof value === 'number') own.value = value;
  }, [value, own]);
  const progress = typeof value === 'number' ? own : value;
  const fill = useAnimatedStyle(() => {
    const v = progress.value;
    const clamped = Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : 0;
    return { width: `${clamped * 100}%` };
  });
  return (
    <View
      accessibilityRole="progressbar"
      onLayout={gradient ? (e) => setTrackW(e.nativeEvent.layout.width) : undefined}
      style={[styles.track, { height, borderRadius: height / 2, backgroundColor: withAlpha(tide.text, 0.12), flexDirection: dir.rtl ? 'row-reverse' : 'row' }]}>
      <Animated.View style={[{ height, borderRadius: height / 2, overflow: 'hidden' }, gradient ? null : { backgroundColor: color }, fill]}>
        {gradient && trackW > 0 ? (
          <Canvas style={{ width: trackW, height }}>
            <Fill>
              <LinearGradient start={vec(0, 0)} end={vec(trackW, 0)} colors={gradient} />
            </Fill>
          </Canvas>
        ) : null}
      </Animated.View>
    </View>
  );
}

const styles = StyleSheet.create({
  track: { width: '100%', overflow: 'hidden' },
});
