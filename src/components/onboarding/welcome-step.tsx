import { useEffect } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import Animated, {
  Easing,
  cancelAnimation,
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
  withDelay,
  withRepeat,
  withSequence,
  withTiming,
} from 'react-native-reanimated';

import { StepAction, StepFrame } from '@/components/onboarding/step-frame';
import { TailMark } from '@/components/onboarding/tail-mark';
import { fonts } from '@/constants/fonts';
import { Spacing, tide } from '@/constants/theme';
import { useT } from '@/lib/i18n';

type Chip = { label: string; top?: number; bottom?: number; left?: number; right?: number };

const CHIPS: Chip[] = [
  { label: 'こんにちは', left: -20, top: 10 },
  { label: '¡hola!', right: -24, top: 40 },
  { label: 'hello', left: 8, top: 190 },
  { label: 'שלום', right: -8, top: 170 },
  { label: 'bonjour', left: 120, top: -18 },
];

const CHIP_DELAYS = [0, 500, 1000, 1500, 2000];

/** A finite number or the fallback, for values that reach a Reanimated style
 * on the UI thread, where a NaN throws and exits Expo Go with no red box. */
function finiteOr(x: number, fallback: number) {
  'worklet';
  return Number.isFinite(x) ? x : fallback;
}

/** One floating language chip: translateY drifts 0 to -6 and back, on its
 * own delayed, repeating loop. Still under reduced motion. */
function FloatingChip({ chip, delay, reducedMotion }: { chip: Chip; delay: number; reducedMotion: boolean }) {
  const t = useSharedValue(0);

  useEffect(() => {
    if (reducedMotion) return;
    t.value = withDelay(
      delay,
      withRepeat(
        withSequence(
          withTiming(-6, { duration: 1500, easing: Easing.inOut(Easing.sin) }),
          withTiming(0, { duration: 1500, easing: Easing.inOut(Easing.sin) }),
        ),
        -1,
        false,
      ),
    );
    return () => cancelAnimation(t);
  }, [reducedMotion, delay, t]);

  const style = useAnimatedStyle(() => ({
    transform: [{ translateY: finiteOr(t.value, 0) }],
  }));

  return (
    <Animated.View
      pointerEvents="none"
      style={[
        styles.chip,
        { top: chip.top, bottom: chip.bottom, left: chip.left, right: chip.right },
        style,
      ]}>
      <Text style={styles.chipText}>{chip.label}</Text>
    </Animated.View>
  );
}

/**
 * The first onboarding screen: the Echo Tail mark and wordmark on the flow's
 * shared sky, with the tagline and a ring of floating language chips. The
 * tail draws itself in on a loop with echo rings at the tip
 * (`tail-mark.tsx`); both are still under reduced motion.
 */
export function WelcomeStep({ onNext }: { onNext: () => void }) {
  const { t } = useT();
  const reducedMotion = useReducedMotion();

  return (
    <StepFrame
      fill
      footer={<StepAction verb="listen" label={t('settings.onboarding.getStarted')} onPress={onNext} />}>
      <View style={styles.stack}>
        <View style={styles.markWrap}>
          <TailMark />
          {CHIPS.map((chip, i) => (
            <FloatingChip key={chip.label} chip={chip} delay={CHIP_DELAYS[i]} reducedMotion={reducedMotion} />
          ))}
        </View>
        <Text style={styles.wordmark}>Echo Tail</Text>
        <Text style={styles.tagline}>{t('settings.onboarding.tagline')}</Text>
      </View>
    </StepFrame>
  );
}

const styles = StyleSheet.create({
  stack: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: Spacing.md },
  markWrap: { width: 180, height: 210, alignItems: 'center', justifyContent: 'center' },
  chip: {
    position: 'absolute',
    height: 28,
    paddingHorizontal: 12,
    borderRadius: 14,
    justifyContent: 'center',
    backgroundColor: 'rgba(255,255,255,0.06)',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.10)',
  },
  chipText: { fontFamily: fonts.uiMedium, fontSize: 12, color: tide.textDim, opacity: 0.85 },
  wordmark: {
    fontFamily: fonts.wordmark,
    fontStyle: 'italic',
    fontWeight: '600',
    fontSize: 44,
    letterSpacing: -0.5,
    color: tide.text,
  },
  tagline: { fontFamily: fonts.ui, fontSize: 17, lineHeight: 24, color: tide.textDim, textAlign: 'center', maxWidth: 300 },
});
