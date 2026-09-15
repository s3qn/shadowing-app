import { useEffect, useRef, useState } from 'react';
import { StyleSheet, View } from 'react-native';
import Animated, {
  cancelAnimation,
  Easing,
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
  withDelay,
  withRepeat,
  withSequence,
  withSpring,
  withTiming,
} from 'react-native-reanimated';

import { PressScale } from '@/components/press-scale';
import { tide } from '@/constants/theme';

export type RingMode = 'idle' | 'playing' | 'breath';

type Props = {
  size?: number;
  mode: RingMode;
  onPress: () => void;
};

// Critically damped (dampingRatio 1): reaches the target in ~180ms with no
// overshoot wobble.
const GLYPH_SPRING = { duration: 180, dampingRatio: 1 };

// `mode` drops to idle for a beat at every repeat and every line change
// (the player stops one clip before the next starts), which would otherwise
// flip the glyph to play and restart the ripples for each of those gaps. Only
// treat a drop to idle as real once it has held for this long.
const IDLE_DEBOUNCE_MS = 250;

// One ripple's life, from leaving the core to fading out. Two rings share
// this clock half a cycle apart, so a new ring leaves every second.
const RIPPLE_MS = 2000;

// How far a ring grows (as a multiple of the core) before it is gone.
const RIPPLE_SCALE = 1.75;

// A ring's opacity as it leaves the core. `breath` is fainter so the pause
// between repeats never reads as another line starting.
const RIPPLE_OPACITY = { playing: 0.55, breath: 0.25 };

// How long the rings and the core glow take to fade in or out.
const FADE_MS = 250;

// Out-cubic, written inline so the worklet has no outside dependency.
function easeOutCubic(t: number) {
  'worklet';
  return 1 - (1 - t) * (1 - t) * (1 - t);
}

/**
 * The one big control. While a line plays or waits its turn, thin rings
 * ripple out from the core like rings on water, and the core carries a soft
 * glow. The breath between repeats uses the same rings, only fainter. The
 * ripples never track audio position, only on/off, so they keep a steady
 * rhythm across line changes instead of resetting with each one. With
 * reduced motion there are no rings, just the still glow.
 */
export function RingButton({ size = 84, mode, onPress }: Props) {
  const rawActive = mode !== 'idle';
  const reducedMotion = useReducedMotion();

  // Debounce drops to idle so a brief gap between repeats or lines never
  // reads as a real stop. Rising back to active is instant, only the fall
  // is delayed.
  const [active, setActive] = useState(rawActive);
  const pendingIdleRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (rawActive) {
      if (pendingIdleRef.current) {
        clearTimeout(pendingIdleRef.current);
        pendingIdleRef.current = null;
      }
      setActive(true);
      return;
    }
    pendingIdleRef.current = setTimeout(() => {
      pendingIdleRef.current = null;
      setActive(false);
    }, IDLE_DEBOUNCE_MS);
    return () => {
      if (pendingIdleRef.current) {
        clearTimeout(pendingIdleRef.current);
        pendingIdleRef.current = null;
      }
    };
  }, [rawActive]);

  // 0 shows the play triangle at full size, 1 shows the stop square.
  // Seeded from the current state so mount never animates from the wrong glyph.
  const glyphT = useSharedValue(active ? 1 : 0);
  const wasActive = useRef(active);

  // Cross-fades the glyph the same render the debounced active flips.
  useEffect(() => {
    if (wasActive.current === active) return;
    wasActive.current = active;
    if (reducedMotion) {
      glyphT.value = active ? 1 : 0;
      return;
    }
    glyphT.value = withSpring(active ? 1 : 0, GLYPH_SPRING);
  }, [active, reducedMotion, glyphT]);

  // `fade` (0..1) fades the rings and the core glow in and out. `clock`
  // (0..1, looping) drives both rings. `ring2Armed` holds the second ring
  // back for its first half cycle, so a start shows one ring leaving the
  // core rather than one already halfway out. All three start and stop only
  // when `active` flips, never on a mode change or a re-render.
  const fade = useSharedValue(0);
  const clock = useSharedValue(0);
  const ring2Armed = useSharedValue(0);

  useEffect(() => {
    if (reducedMotion) {
      cancelAnimation(clock);
      cancelAnimation(ring2Armed);
      clock.value = 0;
      ring2Armed.value = 0;
      fade.value = active ? 1 : 0;
      return;
    }
    if (active) {
      // Still fading out from a stop that did not last: pick the rings up
      // where they are instead of snapping them back to the core.
      const f = fade.value;
      const stillRunning = Number.isFinite(f) && f > 0.01;
      if (!stillRunning) {
        clock.value = withSequence(
          withTiming(0, { duration: 0 }),
          withRepeat(withTiming(1, { duration: RIPPLE_MS, easing: Easing.linear }), -1),
        );
        ring2Armed.value = withSequence(
          withTiming(0, { duration: 0 }),
          withDelay(RIPPLE_MS / 2, withTiming(1, { duration: 0 })),
        );
      }
      fade.value = withTiming(1, { duration: FADE_MS });
      return;
    }
    // Keep the clock running until the rings have faded, so none is frozen
    // or cut off mid-ring.
    fade.value = withTiming(0, { duration: FADE_MS }, (finished) => {
      if (!finished) return;
      cancelAnimation(clock);
      cancelAnimation(ring2Armed);
      ring2Armed.value = 0;
    });
  }, [active, reducedMotion, fade, clock, ring2Armed]);

  useEffect(
    () => () => {
      cancelAnimation(fade);
      cancelAnimation(clock);
      cancelAnimation(ring2Armed);
    },
    [fade, clock, ring2Armed],
  );

  // The ring start opacity for the current mode, eased so a switch between
  // playing and breath never jumps. A drop to idle keeps the last value and
  // leaves the fade to handle it.
  const rippleOpacity = useSharedValue(mode === 'breath' ? RIPPLE_OPACITY.breath : RIPPLE_OPACITY.playing);

  useEffect(() => {
    if (mode === 'idle') return;
    rippleOpacity.value = withTiming(RIPPLE_OPACITY[mode], { duration: 400 });
  }, [mode, rippleOpacity]);

  const playStyle = useAnimatedStyle(() => ({
    opacity: 1 - glyphT.value,
    transform: [{ scale: 0.6 + (1 - glyphT.value) * 0.4 }],
  }));

  const stopStyle = useAnimatedStyle(() => ({
    opacity: glyphT.value,
    transform: [{ scale: 0.6 + glyphT.value * 0.4 }],
  }));

  // The worklets below are guarded: a NaN or undefined value (e.g. mid-teardown)
  // must never throw on the UI thread, which Expo Go swallows silently and
  // leaves the app looking frozen.
  const ring1Style = useAnimatedStyle(() => {
    if (reducedMotion) return { opacity: 0, transform: [{ scale: 1 }] };
    const c = Number.isFinite(clock.value) ? clock.value : 0;
    const e = easeOutCubic(Math.min(Math.max(c % 1, 0), 1));
    const f = Number.isFinite(fade.value) ? fade.value : 0;
    const o = Number.isFinite(rippleOpacity.value) ? rippleOpacity.value : 0;
    return {
      opacity: o * (1 - e) * f,
      transform: [{ scale: 1 + (RIPPLE_SCALE - 1) * e }],
    };
  }, [reducedMotion]);

  const ring2Style = useAnimatedStyle(() => {
    if (reducedMotion) return { opacity: 0, transform: [{ scale: 1 }] };
    const c = Number.isFinite(clock.value) ? clock.value : 0;
    const e = easeOutCubic(Math.min(Math.max((c + 0.5) % 1, 0), 1));
    const f = Number.isFinite(fade.value) ? fade.value : 0;
    const o = Number.isFinite(rippleOpacity.value) ? rippleOpacity.value : 0;
    const armed = Number.isFinite(ring2Armed.value) ? ring2Armed.value : 0;
    return {
      opacity: o * (1 - e) * f * armed,
      transform: [{ scale: 1 + (RIPPLE_SCALE - 1) * e }],
    };
  }, [reducedMotion]);

  const coreGlowStyle = useAnimatedStyle(() => {
    const f = Number.isFinite(fade.value) ? fade.value : 0;
    return { shadowOpacity: 0.6 * f, shadowRadius: 14 * f };
  });

  const coreSize = size * 0.72;
  const ringBox = { width: coreSize, height: coreSize, borderRadius: coreSize / 2 };

  // A tap flips the glyph and starts the ripple fade the same frame, instead
  // of waiting on IDLE_DEBOUNCE_MS, which exists only for automatic gaps
  // between lines and repeats. Optimistic: if `mode` changes at all after
  // this (a stop that did not take and instead lets the line keep playing,
  // or a play that fails and drops back to idle), the effect above picks up
  // that change on the next render and moves `active` to match it, same as
  // any other mode change from the parent.
  const handlePress = () => {
    if (pendingIdleRef.current) {
      clearTimeout(pendingIdleRef.current);
      pendingIdleRef.current = null;
    }
    setActive((current) => !current);
    onPress();
  };

  return (
    <PressScale
      onPress={handlePress}
      accessibilityRole="button"
      accessibilityLabel={active ? 'Stop' : 'Play'}
      style={[styles.wrap, { width: size, height: size }]}>
      <Animated.View pointerEvents="none" style={[styles.ring, ringBox, ring1Style]} />
      <Animated.View pointerEvents="none" style={[styles.ring, ringBox, ring2Style]} />
      <Animated.View
        style={[
          styles.core,
          { width: coreSize, height: coreSize, backgroundColor: active ? tide.lang.ja : 'rgba(255,255,255,0.1)' },
          coreGlowStyle,
        ]}>
        <Animated.View style={[styles.glyphLayer, playStyle]}>
          <View style={styles.play} />
        </Animated.View>
        <Animated.View style={[styles.glyphLayer, stopStyle]}>
          <View style={styles.stop} />
        </Animated.View>
      </Animated.View>
    </PressScale>
  );
}

const styles = StyleSheet.create({
  wrap: { alignItems: 'center', justifyContent: 'center', overflow: 'visible' },
  ring: {
    position: 'absolute',
    backgroundColor: 'transparent',
    borderWidth: 1.5,
    borderColor: tide.lang.ja,
  },
  core: {
    borderRadius: 999,
    alignItems: 'center',
    justifyContent: 'center',
    shadowColor: tide.lang.ja,
    shadowOffset: { width: 0, height: 0 },
  },
  glyphLayer: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, alignItems: 'center', justifyContent: 'center' },
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
