import { StyleSheet, Text, View } from 'react-native';

import { fonts } from '@/constants/fonts';
import { Spacing, tide } from '@/constants/theme';
import type { PitchCell } from '@/lib/pitch';

/**
 * OJAD-style pitch notation on the reading: a bar over the high moras of
 * each accent phrase, with a drop tick after the nucleus where the pitch
 * falls. The row never reacts to playback (the reading is static by design,
 * see the word-level highlighting entry in FEATURES.md).
 */

type Props = { cells: PitchCell[] };

export function PitchReading({ cells }: Props) {
  return (
    <View style={styles.row} accessibilityLabel={cells.map((c) => c.kana).join('')}>
      {cells.map((cell, i) => (
        <View
          key={i}
          style={[styles.cell, cell.phraseStart && styles.phraseGap, { borderTopColor: cell.high ? tide.lang.ja : 'transparent' }]}>
          <Text style={styles.kana}>{cell.kana}</Text>
          {cell.drop ? <View style={styles.drop} /> : null}
        </View>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'center' },
  cell: { borderTopWidth: 2, paddingTop: 2, paddingHorizontal: 2 },
  phraseGap: { marginLeft: Spacing.sm },
  drop: { position: 'absolute', top: 0, right: 0, width: 2, height: 12, backgroundColor: tide.lang.ja },
  kana: { fontFamily: fonts.serifJp, fontSize: 20, lineHeight: 30, color: tide.textDim },
});
