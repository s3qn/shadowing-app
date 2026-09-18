import { StyleSheet, View } from 'react-native';
import Animated, { Easing, useAnimatedStyle, useReducedMotion, type SharedValue } from 'react-native-reanimated';
import Svg, { Path } from 'react-native-svg';

import { GlassDisc } from '@/components/onboarding/glass-disc';
import { finiteOr, phase, useEffectClock } from '@/components/onboarding/pass-effects';
import { tide, verb } from '@/constants/theme';

/** Art size (`A`), the same token the passes use: the disc is `1.5 * A`
 * across (see `GlassDisc`). */
const A = 84;
const DISC = A * 1.5;
/** The mic glyph inside the disc, at the artifact's glyph-to-core ratio. */
const GLYPH = 54;

const RING_PERIOD = 2400;
const RING_DELAYS = [0, 800, 1600];
const RING_FROM = 0.85;
const RING_TO = 1.9;
/** The box reserves the room the widest ring reaches, so the rings never
 * push or overlap the text under them. */
const BOX = Math.ceil(DISC * RING_TO);
const RING_INSET = (BOX - DISC) / 2;

/** One ring: spreads from just inside the disc rim to `RING_TO` and fades,
 * on its own delayed offset of the shared clock. */
function Ring({ delay, now }: { delay: number; now: SharedValue<number> }) {
  const style = useAnimatedStyle(() => {
    const p = phase(now.value, delay, RING_PERIOD) / RING_PERIOD;
    const scale = RING_FROM + (RING_TO - RING_FROM) * Easing.out(Easing.quad)(p);
    return {
      opacity: finiteOr(0.8 * (1 - p), 0),
      transform: [{ scale: finiteOr(scale, RING_FROM) }],
    };
  });
  return <Animated.View pointerEvents="none" style={[styles.ring, style]} />;
}

/**
 * The microphone step's staging: the passes' Glass Disc holding a mic glyph,
 * with three rings pulsing out of it in the speak colour. Still under reduced
 * motion (the disc and the glyph stay, the rings do not render), and the
 * clock stops as soon as the step unmounts.
 */
export function MicArt() {
  const reducedMotion = useReducedMotion();
  const now = useEffectClock(reducedMotion);

  return (
    <View pointerEvents="none" style={styles.box}>
      {reducedMotion ? null : RING_DELAYS.map((delay) => <Ring key={delay} delay={delay} now={now} />)}
      <GlassDisc size={A} colour={verb.speak.c1}>
        <Svg width={GLYPH} height={GLYPH} viewBox="0 0 24 24" fill="none">
          <Path
            d="M12 3a3 3 0 0 1 3 3v6a3 3 0 0 1-6 0V6a3 3 0 0 1 3-3zM5.5 11a6.5 6.5 0 0 0 13 0M12 17.5V21"
            stroke={tide.text}
            strokeWidth={2}
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </Svg>
      </GlassDisc>
    </View>
  );
}

const styles = StyleSheet.create({
  box: { width: BOX, height: BOX, alignItems: 'center', justifyContent: 'center' },
  ring: {
    position: 'absolute',
    top: RING_INSET,
    left: RING_INSET,
    width: DISC,
    height: DISC,
    borderRadius: DISC / 2,
    borderWidth: 2,
    borderColor: verb.speak.c1,
  },
});
