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
import { prism, tide, verb } from '@/constants/theme';
import { PrismButton } from '@/components/prism/prism-button';
import { RingButton, type RingMode } from '@/components/ring-button';
import { useT } from '@/lib/i18n';

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
  const { t } = useT();
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
      <RoundButton glyph="‹" onPress={onPrev} disabled={prevDisabled} label={t('player.previousLine')} />
      <RingButton size={84} mode={ringMode} onPress={onToggle} />
      <RoundButton glyph="›" onPress={onNext} disabled={nextDisabled} label={t('player.nextLine')} />
      <View style={styles.recordWrap}>
        <Animated.View pointerEvents="none" style={[styles.recordGlow, glowStyle]} />
        <PrismButton
          shape="round"
          verb="speak"
          size={prism.sizes.bigRound}
          on={recording}
          onPress={onRecord}
          accessibilityLabel={recording ? t('player.stopRecording') : t('player.recordMyTake')}>
          <View style={[styles.recordDot, recording && styles.recordDotActive]} />
        </PrismButton>
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
    <PrismButton
      shape="round"
      verb="listen"
      size={prism.sizes.round}
      onPress={onPress}
      disabled={disabled}
      accessibilityLabel={label}>
      <Text style={styles.glyph}>{glyph}</Text>
    </PrismButton>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 14, paddingVertical: 10, paddingHorizontal: 18 },
  recordWrap: {
    width: prism.sizes.bigRound,
    height: prism.sizes.bigRound,
    alignItems: 'center',
    justifyContent: 'center',
  },
  recordGlow: {
    position: 'absolute',
    width: 64,
    height: 64,
    borderRadius: 32,
    backgroundColor: tide.record,
  },
  glyph: { fontFamily: fonts.ui, fontSize: 26, color: tide.text },
  recordDot: { width: 14, height: 14, borderRadius: 7, backgroundColor: tide.record },
  recordDotActive: { backgroundColor: verb.speak.c1 },
});
