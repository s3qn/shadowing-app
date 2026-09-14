import { StyleSheet, Text, View } from 'react-native';

import { Spacing } from '@/constants/theme';
import { useTheme } from '@/hooks/use-theme';
import type { PitchCell } from '@/lib/pitch';

/**
 * OJAD-style pitch notation on the reading: a bar over the high moras of
 * each accent phrase, with a drop tick after the nucleus where the pitch
 * falls. The row never reacts to playback (the reading is static by design,
 * see the word-level highlighting entry in FEATURES.md).
 */

type Props = { cells: PitchCell[] };

export function PitchReading({ cells }: Props) {
  const { palette } = useTheme();
  return (
    <View style={styles.row} accessibilityLabel={cells.map((c) => c.kana).join('')}>
      {cells.map((cell, i) => (
        <View
          key={i}
          style={[styles.cell, cell.phraseStart && styles.phraseGap, { borderTopColor: cell.high ? palette.accent : 'transparent' }]}>
          <Text style={[styles.kana, { color: palette.muted }]}>{cell.kana}</Text>
          {cell.drop ? <View style={[styles.drop, { backgroundColor: palette.accent }]} /> : null}
        </View>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'center' },
  cell: { borderTopWidth: 2, paddingTop: 2, paddingHorizontal: 2 },
  phraseGap: { marginLeft: Spacing.sm },
  drop: { position: 'absolute', top: 0, right: 0, width: 2, height: 12 },
  kana: { fontSize: 20, lineHeight: 30 },
});
