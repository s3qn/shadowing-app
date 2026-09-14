import { Pressable, StyleSheet, Text, View } from 'react-native';

import { Radius, Spacing } from '@/constants/theme';
import { useTheme } from '@/hooks/use-theme';
import { READING_OPTIONS, type ReadingMode } from '@/lib/settings';

const LABEL: Record<ReadingMode, string> = { furigana: 'Furigana', kana: 'Kana', romaji: 'Romaji' };

type Props = {
  value: ReadingMode;
  onChange: (mode: ReadingMode) => void;
  pitch: boolean;
  onTogglePitch: () => void;
};

/** The one reading-display control in the player: how the reading is shown
 * (furigana over the kanji, the kana line, or romaji) and whether pitch marks
 * are drawn on the kana strip. Same look as the Repeat row. */
export function ReadingPills({ value, onChange, pitch, onTogglePitch }: Props) {
  const { palette } = useTheme();
  return (
    <View style={styles.row}>
      <Text style={[styles.label, { color: palette.muted }]}>Reading</Text>
      {READING_OPTIONS.map((mode) => {
        const on = value === mode;
        return (
          <Pressable
            key={mode}
            onPress={() => onChange(mode)}
            style={[
              styles.pill,
              {
                backgroundColor: on ? palette.accent : palette.surface,
                borderColor: on ? palette.accent : palette.line,
              },
            ]}>
            <Text style={[styles.pillText, { color: on ? palette.accentInk : palette.ink }]}>{LABEL[mode]}</Text>
          </Pressable>
        );
      })}
      <Pressable
        onPress={onTogglePitch}
        accessibilityState={{ selected: pitch }}
        style={[
          styles.pill,
          styles.pitchPill,
          {
            backgroundColor: pitch ? palette.accent : palette.surface,
            borderColor: pitch ? palette.accent : palette.line,
          },
        ]}>
        <Text style={[styles.pillText, { color: pitch ? palette.accentInk : palette.ink }]}>Pitch</Text>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: Spacing.sm, flexWrap: 'wrap' },
  label: { fontSize: 13, fontWeight: '600', minWidth: 52 },
  pill: { borderWidth: 1, borderRadius: Radius.pill, paddingVertical: Spacing.xs + 2, paddingHorizontal: Spacing.md },
  pitchPill: { marginLeft: Spacing.sm },
  pillText: { fontSize: 13, fontWeight: '700' },
});
