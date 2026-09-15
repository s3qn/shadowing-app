import { type ReactNode } from 'react';
import { StyleSheet, Text, View } from 'react-native';

import { PopoverBubble } from '@/components/tide/popover-bubble';
import { TICK_RULER_H, TickRuler } from '@/components/tide/tick-ruler';
import { fonts } from '@/constants/fonts';
import { tide } from '@/constants/theme';
import { PAUSE_MAX_MS, PAUSE_STEP_MS, TIMES_MAX, TIMES_MIN } from '@/lib/settings';

const PAD = 12;
const RULER_W = 256;
const HEAD_H = 26;
const ROW_H = HEAD_H + 2 + TICK_RULER_H;
const ROW_GAP = 10;
const POP_W = RULER_W + 2 * PAD;
const POP_H = 2 * PAD + 2 * ROW_H + ROW_GAP;

export const TIMES_STEPS = TIMES_MAX - TIMES_MIN + 1;
export const PAUSE_STEPS = PAUSE_MAX_MS / PAUSE_STEP_MS + 1;

/** "Off" at one play, "2×" and up otherwise. */
export function timesLabel(times: number): string {
  return times <= 1 ? 'Off' : `${times}×`;
}

export function pauseLabel(ms: number): string {
  return `${ms / 1000}s`;
}

/** The Repeat tile's value: "Off" with one play and no pause, else e.g. "3× · 1.5s". */
export function repeatTileLabel(times: number, pauseMs: number): string {
  if (times <= 1 && pauseMs <= 0) return 'Off';
  return `${times}× · ${pauseLabel(pauseMs)}`;
}

type Props = {
  /** The Repeat tile's horizontal centre and top edge, in the parent's coordinates. */
  anchorX: number;
  anchorTop: number;
  /** The parent's width, to keep the bubble on screen. */
  width: number;
  times: number;
  pauseMs: number;
  /** Every step while a ruler moves. */
  onTimes: (times: number) => void;
  onPause: (ms: number) => void;
  /** Once the Pause ruler comes to rest. */
  onPauseSettle: (ms: number) => void;
  onClose: () => void;
};

/**
 * The Repeat tile's popover: two tick rulers, how many times each line plays
 * and the pause after every play. The island always runs on line after line;
 * Off with a 0s pause simply plays it straight through.
 */
export function RepeatPopover({ anchorX, anchorTop, width, times, pauseMs, onTimes, onPause, onPauseSettle, onClose }: Props) {
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
      <RulerRow label="Times" readout={timesLabel(times)}>
        <TickRuler
          width={RULER_W}
          steps={TIMES_STEPS}
          index={times - TIMES_MIN}
          onIndexChange={(i) => onTimes(i + TIMES_MIN)}
          isMajor={() => true}
          tickLabel={(i) => String(i + TIMES_MIN)}
          accessibilityLabel={`Times, ${timesLabel(times)}`}
        />
      </RulerRow>
      <RulerRow label="Pause" readout={pauseLabel(pauseMs)}>
        <TickRuler
          width={RULER_W}
          steps={PAUSE_STEPS}
          index={pauseMs / PAUSE_STEP_MS}
          onIndexChange={(i) => onPause(i * PAUSE_STEP_MS)}
          onSettle={(i) => onPauseSettle(i * PAUSE_STEP_MS)}
          isMajor={(i) => (i * PAUSE_STEP_MS) % 1000 === 0}
          tickLabel={(i) => String((i * PAUSE_STEP_MS) / 1000)}
          accessibilityLabel={`Pause, ${pauseLabel(pauseMs)}`}
        />
      </RulerRow>
    </PopoverBubble>
  );
}

function RulerRow({ label, readout, children }: { label: string; readout: string; children: ReactNode }) {
  return (
    <View style={styles.row}>
      <View style={styles.head}>
        <Text style={styles.label}>{label}</Text>
        <Text style={styles.readout}>{readout}</Text>
        <View style={styles.labelSpacer} />
      </View>
      {children}
    </View>
  );
}

const styles = StyleSheet.create({
  body: { padding: PAD, gap: ROW_GAP },
  row: { height: ROW_H, gap: 2 },
  head: { height: HEAD_H, flexDirection: 'row', alignItems: 'center' },
  label: { width: 52, fontFamily: fonts.uiMedium, fontWeight: '500', fontSize: 12, color: tide.textDim },
  labelSpacer: { width: 52 },
  readout: {
    flex: 1,
    textAlign: 'center',
    fontFamily: fonts.uiMedium,
    fontWeight: '500',
    fontSize: 20,
    lineHeight: HEAD_H,
    color: tide.text,
    fontVariant: ['tabular-nums'],
  },
});
