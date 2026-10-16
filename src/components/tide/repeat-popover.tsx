import { SymbolView } from 'expo-symbols';
import { type ReactNode } from 'react';
import { StyleSheet, Text, View } from 'react-native';

import { type SheetIcon } from '@/components/sheet/sheet-rows';
import { POP, PopoverBubble } from '@/components/tide/popover-bubble';
import { TickRuler } from '@/components/tide/tick-ruler';
import { fonts } from '@/constants/fonts';
import { type TFn, useDir, useT } from '@/lib/i18n';
import { PAUSE_MAX_MS, PAUSE_STEP_MS, TIMES_MAX, TIMES_MIN } from '@/lib/settings';

const PAD_X = 14;
const PAD_Y = 6;
const POP_W = 330;
const ROW_H = 48;
const LABEL_W = 84;
const VALUE_W = 56;
const RULER_W = POP_W - 2 * PAD_X - LABEL_W - VALUE_W;
const POP_H = 2 * PAD_Y + 2 * ROW_H + 1;

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
      radius={POP.radius}
      bodyStyle={styles.body}
      onClose={onClose}>
      <RulerRow label={t('player.times')} icon={{ ios: 'repeat', android: 'repeat' }} readout={timesLabel(t, times)}>
        <TickRuler
          width={RULER_W}
          height={ROW_H}
          noLabels
          step={36}
          fadeColor={POP.surface}
          steps={TIMES_STEPS}
          index={times - TIMES_MIN}
          onIndexChange={(i) => onTimes(i + TIMES_MIN)}
          isMajor={() => true}
          tickLabel={(i) => String(i + TIMES_MIN)}
          accessibilityLabel={t('player.timesAccessibility', { label: timesLabel(t, times) })}
        />
      </RulerRow>
      <View style={styles.divider} />
      <RulerRow label={t('player.pause')} icon={{ ios: 'pause', android: 'pause' }} readout={pauseLabel(pauseMs)}>
        <TickRuler
          width={RULER_W}
          height={ROW_H}
          noLabels
          step={24}
          fadeColor={POP.surface}
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
    <View style={[styles.row, dir.row]}>
      <View style={[styles.labelRow, dir.row]}>
        <SymbolView name={icon} size={15} weight="regular" tintColor={POP.goldInk} />
        <Text style={[styles.label, dir.text]} numberOfLines={1}>
          {label}
        </Text>
      </View>
      <Text style={styles.readout}>{readout}</Text>
      {children}
    </View>
  );
}

const styles = StyleSheet.create({
  body: { paddingHorizontal: PAD_X, paddingVertical: PAD_Y },
  row: { height: ROW_H, flexDirection: 'row', alignItems: 'center' },
  divider: { height: 1, backgroundColor: POP.divider },
  labelRow: { width: LABEL_W, flexDirection: 'row', alignItems: 'center', gap: 7 },
  label: {
    flexShrink: 1,
    fontFamily: fonts.uiMedium,
    fontWeight: '600',
    fontSize: 12,
    letterSpacing: 0.5,
    textTransform: 'uppercase',
    color: POP.offInk,
  },
  readout: {
    width: VALUE_W,
    fontFamily: fonts.uiMedium,
    fontWeight: '600',
    fontSize: 18,
    color: '#FFFFFF',
    fontVariant: ['tabular-nums'],
  },
});
