import { useEffect, useRef } from 'react';
import { StyleSheet } from 'react-native';
import Animated, { Easing, useAnimatedStyle, useSharedValue, withTiming } from 'react-native-reanimated';

import { Radius, tide } from '@/constants/theme';

type Box = { x: number; y: number; width: number; height: number };

type Props = {
  /** The active word's layout box, or null when no word is active. */
  box: Box | null;
};

/**
 * A thin outline that glides from word to word as the active word changes,
 * sitting 3px outside the word's box. Fades out when there is no active
 * word instead of collapsing to a point.
 */
export function WordOutline({ box }: Props) {
  const x = useSharedValue(0);
  const y = useSharedValue(0);
  const w = useSharedValue(0);
  const h = useSharedValue(0);
  const opacity = useSharedValue(0);
  const shown = useRef(false);

  useEffect(() => {
    if (!box) {
      opacity.value = withTiming(0, { duration: 120 });
      shown.current = false;
      return;
    }
    const next = { x: box.x - 3, y: box.y - 3, w: box.width + 6, h: box.height + 6 };
    if (!shown.current) {
      x.value = next.x;
      y.value = next.y;
      w.value = next.w;
      h.value = next.h;
      opacity.value = withTiming(1, { duration: 80 });
      shown.current = true;
    } else {
      const timing = { duration: 120, easing: Easing.out(Easing.cubic) };
      x.value = withTiming(next.x, timing);
      y.value = withTiming(next.y, timing);
      w.value = withTiming(next.w, timing);
      h.value = withTiming(next.h, timing);
      opacity.value = withTiming(1, { duration: 80 });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [box?.x, box?.y, box?.width, box?.height]);

  const style = useAnimatedStyle(() => ({
    transform: [{ translateX: x.value }, { translateY: y.value }],
    width: w.value,
    height: h.value,
    opacity: opacity.value,
  }));

  return <Animated.View pointerEvents="none" style={[styles.outline, style]} />;
}

const styles = StyleSheet.create({
  outline: {
    position: 'absolute',
    left: 0,
    top: 0,
    borderWidth: 1.5,
    borderColor: tide.text,
    borderRadius: Radius.sm + 3,
  },
});
