// The count-in's wait cue (V2 Hairline, Sean 2026-11-05): a hairline in the step colour draws left to
// right under the sentence over the whole count, then fades as the line starts. It lives in the
// zero-height anchor under the sentence, so it takes no room. A later swap of the per-step line
// changes only this file; the clock (useCountClock) stays the same.
import { StyleSheet } from 'react-native';
import Animated, { useAnimatedStyle, type SharedValue } from 'react-native-reanimated';

import { SWEEP_EASING } from '@/components/tide/ladder/stage-tokens';

export function CountHairline({ tint, countP, cueOn }: { tint: string; countP: SharedValue<number>; cueOn: SharedValue<number> }) {
  const style = useAnimatedStyle(() => ({
    opacity: 0.55 * cueOn.value,
    transform: [{ scaleX: SWEEP_EASING(countP.value) }],
  }));
  return <Animated.View pointerEvents="none" style={[styles.line, { backgroundColor: tint }, style]} />;
}

const styles = StyleSheet.create({
  // Fixed left to right in every language, like the band.
  line: { position: 'absolute', top: 12, left: '30%', width: '40%', height: 1.5, borderRadius: 1, transformOrigin: 'left' },
});
