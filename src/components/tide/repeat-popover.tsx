import { SymbolView } from 'expo-symbols';
import { type ReactNode } from 'react';
import { StyleSheet, Text, View } from 'react-native';

import { type SheetIcon } from '@/components/sheet/sheet-rows';
import { PopoverBubble } from '@/components/tide/popover-bubble';
import { TICK_RULER_H, TickRuler } from '@/components/tide/tick-ruler';
import { fonts } from '@/constants/fonts';
import { tide } from '@/constants/theme';
import { type TFn, useDir, useT } from '@/lib/i18n';
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

/** "Off" at one play, "2×" and up otherwise. Takes the caller's `t` (from
 * `useT()`) so the label follows an app language change: the module-level
 * `t` has one identity forever, and the React Compiler would cache the
 * result of this call on it. */
export function timesLabel(t: TFn, times: number): string {
  return times <= 1 ? t('player.off') : `${times}×`;
}

export function pauseLabel(ms: number): string {
  return `${ms / 1000}s`;
}

/** The Repeat tile's value: "Off" with one play and no pause, else e.g. "3× · 1.5s". */
export function repeatTileLabel(t: TFn, times: number, pauseMs: number): string {
  if (times <= 1 && pauseMs <= 0) return t('player.off');
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
  const { t } = useT();
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
      <RulerRow label={t('player.times')} icon={{ ios: 'repeat', android: 'repeat' }} readout={timesLabel(t, times)}>
        <TickRuler
          width={RULER_W}
          steps={TIMES_STEPS}
          index={times - TIMES_MIN}
          onIndexChange={(i) => onTimes(i + TIMES_MIN)}
          isMajor={() => true}
          tickLabel={(i) => String(i + TIMES_MIN)}
          accessibilityLabel={t('player.timesAccessibility', { label: timesLabel(t, times) })}
        />
      </RulerRow>
      <RulerRow label={t('player.pause')} icon={{ ios: 'pause', android: 'pause' }} readout={pauseLabel(pauseMs)}>
        <TickRuler
          width={RULER_W}
          steps={PAUSE_STEPS}
          index={pauseMs / PAUSE_STEP_MS}
          onIndexChange={(i) => onPause(i * PAUSE_STEP_MS)}
          onSettle={(i) => onPauseSettle(i * PAUSE_STEP_MS)}
          isMajor={(i) => (i * PAUSE_STEP_MS) % 1000 === 0}
          tickLabel={(i) => String((i * PAUSE_STEP_MS) / 1000)}
          accessibilityLabel={t('player.pauseAccessibility', { label: pauseLabel(pauseMs) })}
        />
      </RulerRow>
    </PopoverBubble>
  );
}

function RulerRow({
  label,
  icon,
  readout,
  children,
}: {
  label: string;
  icon: SheetIcon;
  readout: string;
  children: ReactNode;
}) {
  const dir = useDir();
  return (
    <View style={styles.row}>
      <View style={[styles.head, dir.row]}>
        <View style={[styles.labelRow, dir.row]}>
          <SymbolView name={icon} size={14} weight="regular" tintColor={tide.textDim} />
          <Text style={[styles.label, dir.text]}>{label}</Text>
        </View>
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
  labelRow: { width: 52, flexDirection: 'row', alignItems: 'center', gap: 4 },
  label: { fontFamily: fonts.uiMedium, fontWeight: '500', fontSize: 12, color: tide.textDim },
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
