import { StyleSheet, Text, View } from 'react-native';
import type { SharedValue } from 'react-native-reanimated';

import { fonts } from '@/constants/fonts';
import { tide } from '@/constants/theme';
import { PressScale } from '@/components/press-scale';
import { RingButton, type RingMode } from '@/components/ring-button';

type Props = {
  ring: SharedValue<number>;
  ringMode: RingMode;
  onToggle: () => void;
  onPrev: () => void;
  onNext: () => void;
  prevDisabled: boolean;
  nextDisabled: boolean;
  recording: boolean;
  onRecord: () => void;
};

/**
 * The player's dock: prev/next, the ring (play/stop) and the round record
 * button. One row, always in the same place at the bottom of the fold, with
 * the toolbar above it.
 */
export function BottomRow({
  ring,
  ringMode,
  onToggle,
  onPrev,
  onNext,
  prevDisabled,
  nextDisabled,
  recording,
  onRecord,
}: Props) {
  return (
    <View style={styles.row}>
      <RoundButton glyph="‹" onPress={onPrev} disabled={prevDisabled} label="Previous line" />
      <RingButton size={84} progress={ring} mode={ringMode} onPress={onToggle} />
      <RoundButton glyph="›" onPress={onNext} disabled={nextDisabled} label="Next line" />
      <PressScale
        onPress={onRecord}
        accessibilityRole="button"
        accessibilityLabel={recording ? 'Stop recording' : 'Record my take'}
        style={[styles.round, recording && styles.recordActive]}>
        <View style={[styles.recordDot, recording && styles.recordDotActive]} />
      </PressScale>
    </View>
  );
}

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
  glyph: { fontFamily: fonts.ui, fontSize: 26, color: tide.text },
  recordActive: { backgroundColor: tide.record },
  recordDot: { width: 14, height: 14, borderRadius: 7, backgroundColor: tide.record },
  recordDotActive: { backgroundColor: tide.sky[0] },
});
