import { memo, useEffect } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import Animated, {
  interpolate,
  useAnimatedReaction,
  useAnimatedStyle,
  useSharedValue,
  withTiming,
  type SharedValue,
} from 'react-native-reanimated';

import { fonts } from '@/constants/fonts';
import { tide } from '@/constants/theme';
import { PressScale } from '@/components/press-scale';
import { RingButton, type RingMode } from '@/components/ring-button';

type Props = {
  ringMode: RingMode;
  onToggle: () => void;
  onPrev: () => void;
  onNext: () => void;
  prevDisabled: boolean;
  nextDisabled: boolean;
  recording: boolean;
  /** 0..1 live meter level from the take's recorder, written on a timer and
   * read here on the UI thread, so a meter sample never renders the dock. */
  level: SharedValue<number>;
  onRecord: () => void;
};

/**
 * The player's dock: prev/next, the ring (play/stop) and the round record
 * button. One row, always in the same place at the bottom of the fold, with
 * the toolbar above it.
 */
export const BottomRow = memo(function BottomRow({
  ringMode,
  onToggle,
  onPrev,
  onNext,
  prevDisabled,
  nextDisabled,
  recording,
  level,
  onRecord,
}: Props) {
  // Live level, smoothed on the UI thread so the glow breathes instead of
  // jumping per meter sample. Recording state fades the glow in and out
  // within 200ms so it clears quickly once recording stops.
  const smoothLevel = useSharedValue(0);
  const active = useSharedValue(0);

  useAnimatedReaction(
    () => (recording ? level.value : 0),
    (v, prev) => {
      if (v === prev) return;
      const safe = Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : 0;
      smoothLevel.value = withTiming(safe, { duration: 80 });
    },
    [recording]
  );

  useEffect(() => {
    active.value = withTiming(recording ? 1 : 0, { duration: 200 });
  }, [recording, active]);

  const glowStyle = useAnimatedStyle(() => ({
    opacity: active.value * interpolate(smoothLevel.value, [0, 1], [0.15, 0.6]),
    transform: [{ scale: interpolate(smoothLevel.value, [0, 1], [1, 1.35]) }],
  }));

  return (
    <View style={styles.row}>
      <RoundButton glyph="‹" onPress={onPrev} disabled={prevDisabled} label="Previous line" />
      <RingButton size={84} mode={ringMode} onPress={onToggle} />
      <RoundButton glyph="›" onPress={onNext} disabled={nextDisabled} label="Next line" />
      <View style={styles.recordWrap}>
        <Animated.View pointerEvents="none" style={[styles.recordGlow, glowStyle]} />
        <PressScale
          onPress={onRecord}
          accessibilityRole="button"
          accessibilityLabel={recording ? 'Stop recording' : 'Record my take'}
          style={[styles.round, recording && styles.recordActive]}>
          <View style={[styles.recordDot, recording && styles.recordDotActive]} />
        </PressScale>
      </View>
    </View>
  );
});

type RoundButtonProps = {
  glyph: string;
  onPress: () => void;
  disabled?: boolean;
  label: string;
};

export function RoundButton({ glyph, onPress, disabled, label }: RoundButtonProps) {
  return (
    <PressScale
      onPress={onPress}
      disabled={disabled}
      hitSlop={8}
      accessibilityRole="button"
      accessibilityLabel={label}
      style={[styles.round, disabled && styles.roundDisabled]}>
      <Text style={styles.glyph}>{glyph}</Text>
    </PressScale>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 14, paddingVertical: 10, paddingHorizontal: 18 },
  round: {
    width: 44,
    height: 44,
    borderRadius: 22,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(255,255,255,0.08)',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.12)',
  },
  roundDisabled: { opacity: 0.35 },
  recordWrap: { width: 44, height: 44, alignItems: 'center', justifyContent: 'center' },
  recordGlow: {
    position: 'absolute',
    width: 64,
    height: 64,
    borderRadius: 32,
    backgroundColor: tide.record,
  },
  glyph: { fontFamily: fonts.ui, fontSize: 26, color: tide.text },
  recordActive: { backgroundColor: tide.record },
  recordDot: { width: 14, height: 14, borderRadius: 7, backgroundColor: tide.record },
  recordDotActive: { backgroundColor: tide.sky[0] },
});
