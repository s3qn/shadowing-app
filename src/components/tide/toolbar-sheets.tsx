import Slider from '@react-native-community/slider';
import { useState } from 'react';
import { StyleSheet, Text } from 'react-native';

import { BottomSheet } from '@/components/sheet/bottom-sheet';
import { SheetOption, SheetToggle } from '@/components/sheet/sheet-rows';
import { fonts } from '@/constants/fonts';
import { SPEED_MAX, SPEED_MIN, tide } from '@/constants/theme';
import { LAG_OPTIONS, READING_OPTIONS, type LagMs, type ReadingMode } from '@/lib/settings';

/** Off: play the line once. Line: repeat this line. Island: every line in
 * order, then start over. Lives here, not in the screen, so the toolbar and
 * the sheet share one type. */
export type RepeatMode = 'off' | 'line' | 'island';

export const REPEAT_LABEL: Record<RepeatMode, string> = { off: 'Off', line: 'Line', island: 'Island' };
export const READING_LABEL: Record<ReadingMode, string> = { furigana: 'Furigana', kana: 'Kana', romaji: 'Romaji' };

export function lagLabel(ms: LagMs): string {
  return ms === 0 ? 'Off' : `${ms / 1000}s`;
}

type SheetBaseProps = {
  open: boolean;
  onClose: () => void;
  onDismissed?: () => void;
};

type SpeedSheetProps = SheetBaseProps & {
  speed: number;
  onCommit: (speed: number) => void;
};

/** Drag the thumb and the readout follows live; release re-renders the line
 * at the new speed. The sheet itself stays open after a change. */
export function SpeedSheet({ open, onClose, onDismissed, speed, onCommit }: SpeedSheetProps) {
  const [dragging, setDragging] = useState<number | null>(null);
  return (
    <BottomSheet
      open={open}
      onClose={onClose}
      onDismissed={onDismissed}
      title="Speed"
      hint="Slow speech is spoken slowly by the voice, not stretched.">
      <Text style={styles.readout}>{(dragging ?? speed).toFixed(2)}x</Text>
      <Slider
        style={styles.slider}
        minimumValue={SPEED_MIN}
        maximumValue={SPEED_MAX}
        step={0.05}
        value={speed}
        onValueChange={(v) => setDragging(Math.round(v * 20) / 20)}
        onSlidingComplete={(v) => {
          setDragging(null);
          onCommit(Math.round(v * 20) / 20);
        }}
        minimumTrackTintColor={tide.lang.ja}
        maximumTrackTintColor="rgba(255,255,255,0.2)"
        thumbTintColor={tide.lang.ja}
        accessibilityLabel="Playback speed"
      />
    </BottomSheet>
  );
}

type ReadingSheetProps = SheetBaseProps & {
  value: ReadingMode;
  onChange: (mode: ReadingMode) => void;
  pitch: boolean;
  onTogglePitch: () => void;
};

const READING_HINT: Partial<Record<ReadingMode, string>> = {
  furigana: 'Kana over the kanji',
  kana: 'The kana line under the sentence',
};

export function ReadingSheet({ open, onClose, onDismissed, value, onChange, pitch, onTogglePitch }: ReadingSheetProps) {
  return (
    <BottomSheet open={open} onClose={onClose} onDismissed={onDismissed} title="Reading">
      {READING_OPTIONS.map((mode) => (
        <SheetOption
          key={mode}
          label={READING_LABEL[mode]}
          hint={READING_HINT[mode]}
          selected={value === mode}
          onPress={() => {
            onChange(mode);
            onClose();
          }}
        />
      ))}
      <SheetToggle label="Pitch marks" hint="Rises and falls on the kana strip" value={pitch} onValueChange={onTogglePitch} />
    </BottomSheet>
  );
}

type BlindSheetProps = SheetBaseProps & {
  blind: boolean;
  onToggleBlind: () => void;
  hideEnglish: boolean;
  onToggleHideEnglish: () => void;
};

export function BlindSheet({ open, onClose, onDismissed, blind, onToggleBlind, hideEnglish, onToggleHideEnglish }: BlindSheetProps) {
  return (
    <BottomSheet open={open} onClose={onClose} onDismissed={onDismissed} title="Blind">
      <SheetToggle label="Hide the Japanese" hint="Shadow by ear. Tap the line to peek." value={blind} onValueChange={onToggleBlind} />
      <SheetToggle label="Hide the English" value={hideEnglish} onValueChange={onToggleHideEnglish} />
    </BottomSheet>
  );
}

type LagSheetProps = SheetBaseProps & {
  value: LagMs;
  onChange: (ms: LagMs) => void;
};

export function LagSheet({ open, onClose, onDismissed, value, onChange }: LagSheetProps) {
  return (
    <BottomSheet
      open={open}
      onClose={onClose}
      onDismissed={onDismissed}
      title="Lag"
      hint="Speaking a beat behind the voice: the take tail and the breath grow by this much.">
      {LAG_OPTIONS.map((ms) => (
        <SheetOption
          key={ms}
          label={lagLabel(ms)}
          selected={value === ms}
          onPress={() => {
            onChange(ms);
            onClose();
          }}
        />
      ))}
    </BottomSheet>
  );
}

const styles = StyleSheet.create({
  readout: {
    fontFamily: fonts.uiMedium,
    fontWeight: '500',
    fontSize: 24,
    color: tide.text,
    textAlign: 'center',
    fontVariant: ['tabular-nums'],
  },
  slider: { height: 36, marginTop: 8 },
});
