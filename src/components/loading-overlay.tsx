import { useState } from 'react';
import { StyleSheet, View } from 'react-native';
import Animated, {
  cancelAnimation,
  Easing,
  runOnJS,
  useAnimatedReaction,
  useAnimatedStyle,
  useSharedValue,
  withDelay,
  withRepeat,
  withTiming,
} from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { CatConstellation } from '@/components/cat-constellation';
import { PLAYER_HEADER_ROW_H } from '@/lib/card-morph';
import { CLOCK_MS, LOADER_GRACE_MS, LOADER_IN_MS, LOADER_OUT_MS, loaderRequest } from '@/lib/loading-overlay';

/** How much of the screen's bottom the dock takes, so the cat centres in the
 * space above it. The measured dock height from the timing marks; a
 * different real height just shifts the cat's centre by a few points. */
const DOCK_H = 190;

/**
 * The app's one loading visual, mounted once at the root above everything
 * else. Idle it does no per-frame work at all: the clock is off and the
 * layer's opacity is 0 until `loaderRequest` asks for it. `card-morph.ts`
 * flips it from a UI-thread worklet at cover-complete on an open morph, so
 * it can appear while the JS thread is still busy with the player's first
 * render; the player flips it for a cache-miss network wait and clears it
 * once it has landed.
 */
export function LoadingOverlay() {
  const insets = useSafeAreaInsets();
  const clock = useSharedValue(0);
  const shown = useSharedValue(0);
  // Mirrors the request on the JS side for screen readers only: idle, the
  // layer and its progressbar are hidden from them.
  const [active, setActive] = useState(false);

  useAnimatedReaction(
    () => loaderRequest.value,
    (want, prev) => {
      'worklet';
      if (want !== 0 && want !== 1) return;
      if (want === prev) return;
      runOnJS(setActive)(want === 1);
      if (want === 1) {
        clock.value = 0;
        clock.value = withRepeat(
          withTiming(CLOCK_MS, { duration: CLOCK_MS, easing: Easing.linear }),
          -1,
          false,
        );
        shown.value = withDelay(
          LOADER_GRACE_MS,
          withTiming(1, { duration: LOADER_IN_MS, easing: Easing.out(Easing.quad) }),
        );
      } else {
        cancelAnimation(shown);
        shown.value = withTiming(0, { duration: LOADER_OUT_MS, easing: Easing.in(Easing.quad) }, (finished) => {
          if (finished) cancelAnimation(clock);
        });
      }
    },
  );

  const style = useAnimatedStyle(() => ({
    opacity: Number.isFinite(shown.value) ? shown.value : 0,
  }));

  return (
    <Animated.View
      pointerEvents="none"
      accessibilityElementsHidden={!active}
      importantForAccessibility={active ? 'auto' : 'no-hide-descendants'}
      style={[StyleSheet.absoluteFill, style]}>
      <View
        pointerEvents="none"
        style={[styles.box, { top: insets.top + PLAYER_HEADER_ROW_H, bottom: insets.bottom + DOCK_H }]}>
        <CatConstellation size={110} clock={clock} announce={active} />
      </View>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  box: { position: 'absolute', left: 0, right: 0, alignItems: 'center', justifyContent: 'center' },
});
