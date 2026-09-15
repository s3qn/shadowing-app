import { StyleSheet, Text } from 'react-native';

import { PopoverBubble } from '@/components/tide/popover-bubble';
import { TICK_RULER_H, TickRuler } from '@/components/tide/tick-ruler';
import { fonts } from '@/constants/fonts';
import { SPEED_MAX, SPEED_MIN, tide } from '@/constants/theme';

const PAD = 12;
const RULER_W = 256;
const HEAD_H = 34;
const POP_W = RULER_W + 2 * PAD;
const POP_H = 2 * PAD + HEAD_H + TICK_RULER_H;

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
  return (
    <PopoverBubble
      anchorX={anchorX}
      anchorTop={anchorTop}
      parentWidth={width}
      width={POP_W}
      height={POP_H}
      radius={20}
      bodyStyle={styles.body}
      onClose={onClose}>
      <Text style={styles.readout}>{speedLabel(speed)}</Text>
      <TickRuler
        width={RULER_W}
        steps={SPEED_STEPS}
        index={Math.round((speed - SPEED_MIN) / SPEED_STEP)}
        onIndexChange={(i) => onSpeed(speedAt(i))}
        onSettle={(i) => onSettle(speedAt(i))}
        isMajor={(i) => i % 2 === 0}
        tickLabel={(i) => speedAt(i).toFixed(1)}
        accessibilityLabel={`Speed, ${speedLabel(speed)}`}
      />
    </PopoverBubble>
  );
}

const styles = StyleSheet.create({
  body: { padding: PAD, alignItems: 'center', gap: 2 },
  readout: {
    height: HEAD_H,
    lineHeight: HEAD_H,
    fontFamily: fonts.uiMedium,
    fontWeight: '500',
    fontSize: 28,
    color: tide.text,
    textAlign: 'center',
    fontVariant: ['tabular-nums'],
  },
});
