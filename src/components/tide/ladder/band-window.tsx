// One window of the count-in band: a clip of the sentence's width centred on the sweep,
// its content counter-moved so the text stays still under the moving colour.
// Split out of ladder-stage.tsx as a pure move, no behaviour change.
import type { ReactNode } from 'react';
import { StyleSheet } from 'react-native';
import Animated, { useAnimatedStyle, type SharedValue } from 'react-native-reanimated';

/** Half the widest window: the band starts and ends this far past the edges. */
const BAND_OFF = 0.19;

/**
 * One window of the count-in band: a clip `share` of the sentence wide, centred on the sweep, its
 * content counter-moved so the text stays still. Left to right in every language.
 */
export function BandWindow({ w, sweep, share, opacity, children }: { w: SharedValue<number>; sweep: SharedValue<number>; share: number; opacity: number; children: ReactNode }) {
  const winStyle = useAnimatedStyle(() => {
    const W = Number.isFinite(w.value) ? w.value : 0;
    const s = Number.isFinite(sweep.value) ? sweep.value : 0;
    const ww = W * share;
    const x = W * (-BAND_OFF + s * (1 + 2 * BAND_OFF)) - ww / 2;
    return { width: ww, transform: [{ translateX: x }] };
  });
  const innerStyle = useAnimatedStyle(() => {
    const W = Number.isFinite(w.value) ? w.value : 0;
    const s = Number.isFinite(sweep.value) ? sweep.value : 0;
    const x = W * (-BAND_OFF + s * (1 + 2 * BAND_OFF)) - (W * share) / 2;
    return { width: W, transform: [{ translateX: -x }] };
  });
  return (
    <Animated.View style={[styles.bandWin, { opacity }, winStyle]} pointerEvents="none">
      <Animated.View style={[styles.bandInner, innerStyle]}>{children}</Animated.View>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  bandWin: { position: 'absolute', left: 0, top: 0, bottom: 0, overflow: 'hidden' },
  bandInner: { position: 'absolute', left: 0, top: 0, bottom: 0, alignItems: 'center' },
});
