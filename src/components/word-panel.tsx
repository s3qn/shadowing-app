import { ScrollView, StyleSheet, Text, View } from 'react-native';

import { PressScale } from '@/components/press-scale';
import { fonts } from '@/constants/fonts';
import { Radius, Spacing, tide } from '@/constants/theme';
import type { Gloss } from '@/lib/api';
import { useDir, useT } from '@/lib/i18n';
import { kanaToRomaji } from '@/lib/romaji';

export const POPOVER_WIDTH = 250;

type Props = {
  word: string;
  gloss: Gloss | null;
  /** How the word functions in this particular sentence. `undefined` means
   * the fetch has not resolved yet, `null` means it resolved with nothing to
   * say (or failed quietly); either way there is no context line to show. */
  context?: string | null;
  /** Absolute position inside the sentence block, computed by the screen. */
  left: number;
  top: number;
  /** Show the reading as romaji instead of kana, following the reading mode. */
  romaji?: boolean;
  /** Whether the word has a JMdict entry to show. False (es and en, which
   * JMdict does not cover) shows the context line as the body instead. */
  dictionary?: boolean;
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
export function WordPanel({ word, gloss, context, left, top, romaji = false, dictionary = true, onHear, onClose }: Props) {
  const { t } = useT();
  const dir = useDir();
  const shownReading = gloss ? (romaji ? toRomajiReading(gloss) : gloss.reading) : '';
  return (
    <View style={[styles.pop, { left, top, backgroundColor: tide.water, borderColor: tide.waterline, shadowColor: '#000' }]}>
      <View style={[styles.head, dir.row]}>
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
        {dictionary ? (
          gloss === null ? (
            <Text style={[styles.meaning, dir.text]}>{t('player.lookingUp')}</Text>
          ) : !gloss.found ? (
            <Text style={[styles.meaning, dir.text]}>{t('player.noDictionaryEntry')}</Text>
          ) : (
            gloss.entries.slice(0, 2).map((entry, i) =>
              entry.senses.slice(0, 3).map((sense, j) => (
                <Text key={`${i}-${j}`} style={styles.meaning}>
                  {sense.glosses.join('; ')}
                  {sense.pos.length ? <Text style={{ color: tide.textDim }}>  {sense.pos[0]}</Text> : null}
                </Text>
              )),
            )
          )
        ) : context === undefined ? (
          <Text style={styles.meaning}>…</Text>
        ) : context === null ? (
          <Text style={[styles.meaning, dir.text]}>{t('player.nothingToAdd')}</Text>
        ) : (
          <Text style={[styles.meaning, dir.content]}>{context}</Text>
        )}
      </ScrollView>

      {dictionary && gloss !== null && context ? (
        <Text style={[styles.context, dir.text]}>{t('player.inThisSentence', { context })}</Text>
      ) : dictionary && gloss !== null && context === undefined ? (
        <Text style={styles.contextLoading}>…</Text>
      ) : null}

      <PressScale onPress={onHear} style={styles.hear}>
        <Text style={styles.hearText}>{t('player.hearAgain')}</Text>
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
  context: { fontSize: 13, lineHeight: 18, fontFamily: fonts.ui, color: tide.textDim },
  contextLoading: { fontSize: 13, lineHeight: 18, fontFamily: fonts.ui, color: tide.textDim },
  hear: { paddingVertical: Spacing.sm, borderRadius: Radius.pill, alignItems: 'center', backgroundColor: tide.lang.ja },
  hearText: { fontSize: 14, fontFamily: fonts.uiMedium, fontWeight: '500', color: tide.sky[0] },
});
