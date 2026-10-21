import { SymbolView } from 'expo-symbols';
import { StyleSheet, Text, View } from 'react-native';

import { POP, PopoverBubble } from '@/components/tide/popover-bubble';
import { TICK_RULER_H, TickRuler } from '@/components/tide/tick-ruler';
import { fonts } from '@/constants/fonts';
import { SPEED_MAX, SPEED_MIN } from '@/constants/theme';
import { useDir, useT } from '@/lib/i18n';

const PAD_X = 14;
const PAD_Y = 6;
const RULER_W = 302;
const HEAD_H = 28;
const POP_W = RULER_W + 2 * PAD_X;
const POP_H = 2 * PAD_Y + HEAD_H + TICK_RULER_H;
/** Distance between ticks: 11 per 0.05, so the 0.5 and 1.5 labels clear the fade edges. */
const TICK_STEP = 11;

const SPEED_STEP = 0.05;
export const SPEED_STEPS = Math.round((SPEED_MAX - SPEED_MIN) / SPEED_STEP) + 1;

function speedAt(index: number): number {
  return Math.round((SPEED_MIN + index * SPEED_STEP) * 100) / 100;
}

/** "1.00×". */
export function speedLabel(speed: number): string {
  return `${speed.toFixed(2)}×`;
}

type Props = {
  /** The Speed tile's horizontal centre and top edge, in the parent's coordinates. */
  anchorX: number;
  anchorTop: number;
  /** The parent's width, to keep the bubble on screen. */
  width: number;
  speed: number;
  /** Every step the ruler passes: the readout and the tile follow at once. */
  onSpeed: (speed: number) => void;
  /** Once the ruler comes to rest, where the line re-renders and restarts. */
  onSettle: (speed: number) => void;
  onClose: () => void;
};

/**
 * The Speed tile's popover: one tick ruler from 0.5x to 1.5x in 0.05 steps,
 * the same concept as the Repeat popover's rulers. The readout follows every
 * step the finger passes; the line only restarts once the ruler settles.
 */
export function SpeedPopover({ anchorX, anchorTop, width, speed, onSpeed, onSettle, onClose }: Props) {
  const { t } = useT();
  const dir = useDir();
  return (
    <PopoverBubble
      anchorX={anchorX}
      anchorTop={anchorTop}
      parentWidth={width}
      width={POP_W}
      height={POP_H}
      radius={POP.radius}
      gap={4}
      bodyStyle={styles.body}
      onClose={onClose}>
      <View style={[styles.head, dir.row]}>
        <View style={[styles.labelRow, dir.row]}>
          <SymbolView name={{ ios: 'speedometer', android: 'speed' }} size={15} weight="regular" tintColor={POP.goldInk} />
          <Text style={styles.label}>{t('player.toolbarSpeed')}</Text>
        </View>
        <Text style={styles.readout}>{speedLabel(speed)}</Text>
      </View>
      <TickRuler
        width={RULER_W}
        steps={SPEED_STEPS}
        index={Math.round((speed - SPEED_MIN) / SPEED_STEP)}
        step={TICK_STEP}
        fadeColor={POP.surface}
        fadeWidth={24}
        onIndexChange={(i) => onSpeed(speedAt(i))}
        onSettle={(i) => onSettle(speedAt(i))}
        isMajor={(i) => i % 5 === 0}
        tickLabel={(i) => String(speedAt(i))}
        accessibilityLabel={t('player.speedAccessibility', { label: speedLabel(speed) })}
      />
    </PopoverBubble>
  );
}

const styles = StyleSheet.create({
  body: { paddingHorizontal: PAD_X, paddingVertical: PAD_Y },
  head: { height: HEAD_H, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  labelRow: { flexDirection: 'row', alignItems: 'center', gap: 7 },
  label: {
    fontFamily: fonts.uiMedium,
    fontWeight: '600',
    fontSize: 12,
    letterSpacing: 0.5,
    textTransform: 'uppercase',
    color: POP.offInk,
  },
  readout: {
    fontFamily: fonts.uiMedium,
    fontWeight: '600',
    fontSize: 24,
    color: '#FFFFFF',
    fontVariant: ['tabular-nums'],
  },
});
