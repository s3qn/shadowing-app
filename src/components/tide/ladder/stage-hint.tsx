// The seal (plan stage-stamp, board V6): on the Shadow and Final take steps a red 96pt seal
// falls into the band, then slides down and becomes the stop button with a pulse ring. Its
// Pressable is the one stop control (`stopOnce` through `onPress`, shared with the body's
// tap); on a hands-free-off step the same tap starts the count. `StageStamp` owns every
// clock; this file only maps the SharedValues to transforms and opacities.
import { Pressable, StyleSheet, Text, View } from 'react-native';
import Animated, { Easing, Extrapolation, interpolate, type SharedValue, useAnimatedStyle, withSpring, withTiming } from 'react-native-reanimated';

import { fonts } from '@/constants/fonts';
import { prism } from '@/constants/theme';
import { hapticImpact } from '@/lib/haptics';
import { useT } from '@/lib/i18n';

/** The seal's diameter; the stop button is 0.75 of it. */
export const SEAL = 96;
export const SEAL_RED = '#FF5468';
/** The plate and seal glass (#141A33 at 0.94). */
export const GLASS = 'rgba(20,26,51,0.94)';
const SEAL_RIM = 'rgba(255,84,104,0.55)';
const SEAL_INK = 'rgba(255,84,104,0.95)';
/** The fall's start, fully above the screen. */
const FROM = -400;

/** A SharedValue read that never throws on the UI thread (Expo Go exits on one): a non-number reads as `d`. */
export function fin(v: number, d = 0): number {
  'worklet';
  return Number.isFinite(v) ? v : d;
}

/** What a tap on the seal does: stop the take, start the count, or nothing (the tap falls through to the body). */
export type SealActive = 'stop' | 'start' | 'off';

type Props = {
  fall: SharedValue<number>;
  sq: SharedValue<number>;
  out: SharedValue<number>;
  travel: SharedValue<number>;
  press: SharedValue<number>;
  pulse: SharedValue<number>;
  pulseOn: SharedValue<number>;
  emoji: string;
  word: string;
  active: SealActive;
  onPress: () => void;
  /** The band's rest centre and the stop slot's centre, in the layer. */
  rest: number;
  stopY: number;
  /** Whether the drawn step records: the seal is drawn only then. */
  rec: boolean;
  reduced: boolean;
};

export function StageHint({ fall, sq, out, travel, press, pulse, pulseOn, emoji, word, active, onPress, rest, stopY, rec, reduced }: Props) {
  const { t } = useT();
  const dy = stopY - rest;

  const sealStyle = useAnimatedStyle(() => {
    const f = fin(fall.value);
    const tr = fin(travel.value);
    const q = fin(sq.value);
    const o = fin(out.value, 1);
    const pr = fin(press.value);
    const soft = reduced ? 0.96 + 0.04 * o : 1;
    const s0 = 1.25 - 0.25 * f;
    return {
      opacity: rec ? o : 0,
      transform: [
        { translateY: FROM * (1 - f) + dy * tr },
        { rotate: `${-6 * (1 - tr)}deg` },
        { scale: (s0 * (1 - tr) + 0.75 * tr) * (1 - 0.1 * pr) * soft },
        { scaleX: 1 + 0.033 * q },
        { scaleY: 1 - 0.06 * q },
      ],
    };
  });
  const fillStyle = useAnimatedStyle(() => ({ opacity: interpolate(fin(travel.value), [0.3, 0.7], [0, 1], Extrapolation.CLAMP) }));
  const labelStyle = useAnimatedStyle(() => ({ opacity: interpolate(fin(travel.value), [0.3, 0.7], [1, 0], Extrapolation.CLAMP) }));
  const squareStyle = useAnimatedStyle(() => ({ opacity: interpolate(fin(travel.value), [0.5, 0.9], [0, 1], Extrapolation.CLAMP) }));
  // The pulse ring lives inside the seal and starts each loop at 0 under the rim: no snap-back.
  const pulseStyle = useAnimatedStyle(() => {
    const tr = fin(travel.value);
    const p = fin(pulse.value);
    const on = fin(pulseOn.value) > 0.5 && (tr > 0.98 || tr < 0.02);
    return { opacity: on ? interpolate(p, [0, 0.15, 1], [0, 0.45, 0], Extrapolation.CLAMP) : 0, transform: [{ scale: 1 + 0.5 * p }] };
  });

  const pressIn = () => {
    press.set(withTiming(1, { duration: 130, easing: Easing.out(Easing.quad) }));
    void hapticImpact();
  };
  const pressOut = () => {
    press.set(withSpring(0, prism.press.spring));
  };

  // The wrapper fills the layer and the seal sits at the band by `top`, so the stop slot it
  // translates to is inside its parent's frame: iOS drops touches outside the parent.
  return (
    <View style={styles.row} pointerEvents="box-none">
      <Animated.View
        style={[styles.seal, { top: rest - SEAL / 2 }, sealStyle]}
        pointerEvents={active === 'off' ? 'none' : 'auto'}
        accessibilityElementsHidden={!rec || active === 'off'}
        importantForAccessibility={rec && active !== 'off' ? 'auto' : 'no-hide-descendants'}>
        <Pressable
          onPressIn={pressIn}
          onPressOut={pressOut}
          onPress={onPress}
          disabled={active === 'off'}
          accessibilityRole="button"
          accessibilityLabel={active === 'start' ? t('ladder.tapToStart') : t('ladder.tapStop')}
          style={styles.face}>
          <View style={styles.rim} pointerEvents="none" />
          <Animated.View style={[styles.fill, fillStyle]} pointerEvents="none" />
          <View style={styles.inner} pointerEvents="none" />
          <Animated.View style={[styles.label, labelStyle]} pointerEvents="none">
            <Text style={styles.emoji}>{emoji}</Text>
            <Text style={styles.word} numberOfLines={1}>
              {word}
            </Text>
          </Animated.View>
          <Animated.View style={[styles.square, squareStyle]} pointerEvents="none" />
          <Animated.View style={[styles.pulse, pulseStyle]} pointerEvents="none" />
        </Pressable>
      </Animated.View>
    </View>
  );
}

const styles = StyleSheet.create({
  row: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0 },
  seal: { position: 'absolute', left: '50%', marginLeft: -SEAL / 2, width: SEAL, height: SEAL },
  face: { width: SEAL, height: SEAL, alignItems: 'center', justifyContent: 'center' },
  rim: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, borderRadius: SEAL / 2, borderWidth: 3, borderColor: SEAL_RED, backgroundColor: GLASS },
  fill: { position: 'absolute', top: -3, left: -3, right: -3, bottom: -3, borderRadius: 999, backgroundColor: SEAL_RED },
  inner: { position: 'absolute', top: 6, left: 6, right: 6, bottom: 6, borderRadius: 999, borderWidth: 1.5, borderColor: SEAL_RIM },
  label: { alignItems: 'center', justifyContent: 'center', gap: 2 },
  emoji: { fontSize: 34, lineHeight: 40 },
  word: { fontFamily: fonts.ui, fontSize: 11, lineHeight: 13, fontWeight: '800', textTransform: 'uppercase', letterSpacing: 2, color: SEAL_INK },
  square: { position: 'absolute', top: (SEAL - 24) / 2, left: (SEAL - 24) / 2, width: 24, height: 24, borderRadius: 5, backgroundColor: '#FFFFFF' },
  pulse: { position: 'absolute', top: -3, left: -3, right: -3, bottom: -3, borderRadius: 999, borderWidth: 2, borderColor: SEAL_RED },
});
