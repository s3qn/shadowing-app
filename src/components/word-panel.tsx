import { ScrollView, StyleSheet, Text, View } from 'react-native';

import { PressScale } from '@/components/press-scale';
import { fonts } from '@/constants/fonts';
import { Radius, Spacing, tide } from '@/constants/theme';
import type { Gloss } from '@/lib/api';
import { kanaToRomaji } from '@/lib/romaji';

export const POPOVER_WIDTH = 250;

type Props = {
  word: string;
  gloss: Gloss | null;
  /** Absolute position inside the sentence block, computed by the screen. */
  left: number;
  top: number;
  /** Show the reading as romaji instead of kana, following the reading mode. */
  romaji?: boolean;
  onHear: () => void;
  onClose: () => void;
};

/** は and へ are read as particles (ワ/エ), not their base kana; every other
 * reading is converted mora by mora. */
function toRomajiReading(gloss: Gloss): string {
  const isParticle = gloss.entries[0]?.senses[0]?.pos[0] === 'particle';
  if (isParticle && gloss.reading === 'は') return 'wa';
  if (isParticle && gloss.reading === 'へ') return 'e';
  return kanaToRomaji(gloss.reading);
}

/**
 * Yomitan-style popover under a tapped word: reading, meaning, a button to
 * hear the word again. Absolutely positioned so the sentence never moves.
 * It never touches playback itself; the screen decides what Hear it does.
 */
export function WordPanel({ word, gloss, left, top, romaji = false, onHear, onClose }: Props) {
  const shownReading = gloss ? (romaji ? toRomajiReading(gloss) : gloss.reading) : '';
  return (
    <View style={[styles.pop, { left, top, backgroundColor: tide.water, borderColor: tide.waterline, shadowColor: '#000' }]}>
      <View style={styles.head}>
        <View style={styles.headText}>
          <Text style={styles.word} numberOfLines={1}>
            {word}
          </Text>
          {gloss?.reading ? (
            <Text style={styles.reading} numberOfLines={1}>
              {shownReading}
              {gloss.base && gloss.base !== word.replace(/[、。！？]/g, '') ? `  ·  ${gloss.base}` : ''}
            </Text>
          ) : null}
        </View>
        <PressScale onPress={onClose} hitSlop={12}>
          <Text style={styles.close}>×</Text>
        </PressScale>
      </View>

      <ScrollView style={styles.body} contentContainerStyle={{ gap: 4 }} nestedScrollEnabled>
        {gloss === null ? (
          <Text style={styles.meaning}>Looking up…</Text>
        ) : !gloss.found ? (
          <Text style={styles.meaning}>No dictionary entry.</Text>
        ) : (
          gloss.entries.slice(0, 2).map((entry, i) =>
            entry.senses.slice(0, 3).map((sense, j) => (
              <Text key={`${i}-${j}`} style={styles.meaning}>
                {sense.glosses.join('; ')}
                {sense.pos.length ? <Text style={{ color: tide.textDim }}>  {sense.pos[0]}</Text> : null}
              </Text>
            )),
          )
        )}
      </ScrollView>

      <PressScale onPress={onHear} style={styles.hear}>
        <Text style={styles.hearText}>Hear again</Text>
      </PressScale>
    </View>
  );
}

const styles = StyleSheet.create({
  pop: {
    position: 'absolute',
    width: POPOVER_WIDTH,
    zIndex: 10,
    elevation: 8,
    shadowOpacity: 0.25,
    shadowRadius: 12,
    shadowOffset: { width: 0, height: 6 },
    borderWidth: 1,
    borderRadius: Radius.md,
    padding: Spacing.md,
    gap: Spacing.sm,
  },
  head: { flexDirection: 'row', alignItems: 'flex-start', gap: Spacing.sm },
  headText: { flex: 1 },
  word: { fontSize: 20, fontWeight: '700', fontFamily: fonts.serifJp, color: tide.text },
  reading: { fontSize: 13, fontFamily: fonts.serifJp, color: tide.textDim },
  close: { fontSize: 22, lineHeight: 24, fontWeight: '600', paddingHorizontal: 4, fontFamily: fonts.ui, color: tide.textDim },
  body: { flexGrow: 0, maxHeight: 96 },
  meaning: { fontSize: 14, lineHeight: 20, fontFamily: fonts.ui, color: tide.text },
  hear: { paddingVertical: Spacing.sm, borderRadius: Radius.pill, alignItems: 'center', backgroundColor: tide.lang.ja },
  hearText: { fontSize: 14, fontFamily: fonts.uiMedium, color: tide.sky[0] },
});
