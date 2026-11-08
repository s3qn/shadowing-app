// The chips above the hint (mock `.mini`): MiniChip, a tiny outlined chip, and
// StageChips, the row of speed, pace and Easy chips; a hold on any opens the pace sheet.
// Split out of ladder-stage.tsx as a pure move, no behaviour change.
import * as Haptics from 'expo-haptics';
import { useRef } from 'react';
import { Pressable, StyleSheet, Text, View, type StyleProp, type ViewStyle } from 'react-native';
import Animated, { type AnimatedStyle } from 'react-native-reanimated';

import { nextSpeed } from '@/components/tide/ladder/stage-model';
import { EDGE } from '@/components/tide/ladder/stage-tokens';
import { paceLabelKey } from '@/components/tide/pace-sheet';
import { fonts } from '@/constants/fonts';
import { tide } from '@/constants/theme';
import type { LadderStageProps } from '@/hooks/ladder/ladder-types';
import { useDir, useT } from '@/lib/i18n';
import { ltr } from '@/lib/bidi';
import { formatSpeed } from '@/lib/format';
import type { LadderPace } from '@/lib/pass-programme';

const CHIP_SLOP = { top: 11, bottom: 11, left: 8, right: 8 };
const PACE_CYCLE: readonly LadderPace[] = ['quick', 'steady', 'calm'];

/** The mock's `.mini span`: a tiny outlined chip; a tap acts at once, a hold opens the pace sheet. */
export function MiniChip({ label, a11y, selected, onPress, onLong }: { label: string; a11y: string; selected?: boolean; onPress: () => void; onLong: () => void }) {
  const { t } = useT();
  return (
    <Pressable
      onPress={() => {
        Haptics.selectionAsync().catch(() => {});
        onPress();
      }}
      onLongPress={onLong}
      hitSlop={CHIP_SLOP}
      accessibilityRole="button"
      accessibilityLabel={a11y}
      accessibilityHint={t('ladder.chipHold')}
      accessibilityState={selected === undefined ? undefined : { selected }}
      style={({ pressed }) => [styles.mini, pressed && { opacity: 0.7 }]}>
      <Text style={styles.miniText}>{label}</Text>
    </Pressable>
  );
}

/**
 * The chips' row (mock `.mini`), directly above the hint's 44pt target: each chip only where
 * its host takes it. Outside the body's detector, so a chip tap never pauses the stage.
 */
export function StageChips({
  speedChip,
  paceChip,
  easy,
  onSpeed,
  onPace,
  onLong,
  hintBottom,
  paused,
  chipsStyle,
  stepName,
  onStep,
  onStepHold,
}: {
  speedChip: number | null;
  paceChip: LadderPace | null;
  easy?: { on: boolean; onPress: () => void };
  onSpeed: LadderStageProps['onSpeed'];
  onPace: LadderStageProps['onPace'];
  onLong: () => void;
  hintBottom: number;
  paused: boolean;
  chipsStyle: StyleProp<AnimatedStyle<ViewStyle>>;
  // focus-stories D9: the step chip first in the row, label `${stepName} ›` (a fixed chevron: the
  // gestures are not mirrored in Hebrew), a11y `ladder.chipStep`; tap `onStep` (the composer's
  // forward rule), hold `onStepHold(anchorX)` with the chip's centre x in the stage (its row `onLayout`
  // x + half its width + 16) to open the step list; absent `stepName`, no step chip.
  stepName?: string;
  onStep?: () => void;
  onStepHold?: (anchorX: number) => void;
}) {
  const { t } = useT();
  const dir = useDir();
  const chipX = useRef(0);
  return (
    <Animated.View style={[styles.minis, dir.row, { bottom: hintBottom + 31 }, chipsStyle]} pointerEvents={paused ? 'none' : 'box-none'}>
      {stepName && onStep ? (
        <View
          onLayout={(e) => {
            const { x, width } = e.nativeEvent.layout;
            chipX.current = x + width / 2 + 16;
          }}>
          <MiniChip
            label={`${stepName} ${ltr(dir.chevron)}`}
            a11y={t('ladder.chipStep', { v: stepName })}
            onPress={onStep}
            onLong={() => {
              Haptics.selectionAsync().catch(() => {});
              onStepHold?.(chipX.current);
            }}
          />
        </View>
      ) : null}
      {speedChip !== null ? (
        <MiniChip
          label={ltr(formatSpeed(speedChip))}
          a11y={t('ladder.chipSpeed', { v: formatSpeed(speedChip) })}
          onPress={() => onSpeed?.(nextSpeed(speedChip))}
          onLong={onLong}
        />
      ) : null}
      {paceChip !== null ? (
        <MiniChip
          label={t(paceLabelKey(paceChip))}
          a11y={t('ladder.chipPace', { v: t(paceLabelKey(paceChip)) })}
          onPress={() => onPace?.(PACE_CYCLE[(PACE_CYCLE.indexOf(paceChip) + 1) % PACE_CYCLE.length]!)}
          onLong={onLong}
        />
      ) : null}
      {easy ? (
        <MiniChip
          label={easy.on ? t('ladder.easyMarked') : t('ladder.chipEasy')}
          a11y={easy.on ? t('ladder.easyMarked') : t('ladder.easy')}
          selected={easy.on}
          onPress={easy.onPress}
          onLong={onLong}
        />
      ) : null}
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  minis: { position: 'absolute', left: 16, right: 16, flexDirection: 'row', justifyContent: 'center', gap: 6 },
  mini: { borderWidth: 1, borderColor: EDGE, borderRadius: 999, paddingHorizontal: 8, paddingVertical: 3 },
  miniText: { fontFamily: fonts.ui, fontSize: 11, lineHeight: 14, color: tide.textDim },
});
