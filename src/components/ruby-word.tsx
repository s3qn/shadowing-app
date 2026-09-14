import { type LayoutChangeEvent, StyleSheet, Text, View } from 'react-native';

import { fonts } from '@/constants/fonts';
import { Radius, tide } from '@/constants/theme';
import type { Word } from '@/lib/api';
import { kanaToRomaji } from '@/lib/romaji';

type Props = {
  word: Word;
  /** Furigana above the kanji. Off, the word is one plain column. */
  showRuby: boolean;
  active: boolean;
  selected: boolean;
  /** Drawn in the muted colour (a word outside a phrase loop's span). */
  dimmed?: boolean;
  /** How the last take's timing scored this word: a coloured bottom border,
   * always present (transparent when unmarked) so layout does not jump. */
  mark?: 'early' | 'late' | 'dropped' | null;
  /** Layout inside the sentence block, for the popover under the word. */
  onLayout: (e: LayoutChangeEvent) => void;
  /** Part-of-speech bar and romaji row below the word. Off in the mirrored
   * reflection copy, which should only mirror the word itself. */
  showPosAndRomaji?: boolean;
};

/**
 * One word of the line. React Native has no ruby text, so a word with
 * furigana is a wrapping row of columns: each kanji run with its reading
 * above it, each kana run with an empty ruby row so every word in the sentence
 * is the same height. A word with no reading to show is one Text, so a long
 * chunk (a whole-line fallback) wraps like any sentence. Either way the
 * highlight and the selected tint cover the whole word. A plain View: the
 * screen's single gesture on the sentence block does the hit-testing and
 * calls the tap or drag handlers itself.
 */
export function RubyWord({
  word,
  showRuby,
  active,
  selected,
  dimmed,
  mark,
  onLayout,
  showPosAndRomaji = true,
}: Props) {
  const segments = showRuby && word.ruby?.some((s) => s.rt) ? word.ruby : null;
  const ink = active ? tide.sky[0] : dimmed ? tide.textDim : tide.text;
  const rubyInk = active ? tide.sky[0] : tide.textDim;
  const baseStyle = [styles.base, { color: ink, textDecorationLine: selected ? 'underline' : 'none' } as const];
  const markColor =
    mark === 'early' ? tide.listen : mark === 'late' ? tide.turn : mark === 'dropped' ? tide.record : 'transparent';
  const posColor = tide.pos[word.pos ?? 'other'];
  const romaji = showRuby && word.ruby ? kanaToRomaji(word.ruby.map((s) => s.rt || s.text).join('')) : '';
  return (
    <View
      onLayout={onLayout}
      style={[
        styles.word,
        styles.column,
        {
          backgroundColor: active ? tide.lang.ja : selected ? 'rgba(255,255,255,0.12)' : 'transparent',
          borderBottomWidth: 3,
          borderBottomColor: markColor,
        },
      ]}>
      <View style={segments ? styles.rubyRow : styles.plain}>
        {segments ? (
          segments.map((seg, i) => (
            <View key={i} style={styles.segment}>
              <Text style={[styles.rt, { color: rubyInk }]}>{seg.rt}</Text>
              <Text style={baseStyle}>{seg.text}</Text>
            </View>
          ))
        ) : (
          <>
            {showRuby ? <Text style={[styles.rt, { color: rubyInk }]}>{''}</Text> : null}
            <Text style={baseStyle}>{word.text}</Text>
          </>
        )}
      </View>
      {showPosAndRomaji ? (
        <>
          <View style={[styles.posBar, { backgroundColor: posColor }]} />
          {romaji ? <Text style={styles.romaji}>{romaji}</Text> : null}
        </>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  word: {
    flexShrink: 1,
    maxWidth: '100%',
    paddingHorizontal: 4,
    borderRadius: Radius.sm,
  },
  column: { flexDirection: 'column' },
  rubyRow: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'flex-end' },
  plain: { flexDirection: 'column', justifyContent: 'flex-end' },
  segment: { alignItems: 'center', flexShrink: 1, maxWidth: '100%' },
  rt: { fontFamily: fonts.serifJp, fontSize: 12, lineHeight: 15, includeFontPadding: false },
  base: { fontFamily: fonts.serifJp, fontSize: 26, lineHeight: 38, includeFontPadding: false },
  posBar: { height: 2, borderRadius: 1, marginTop: 2, alignSelf: 'stretch' },
  romaji: {
    fontFamily: fonts.ui,
    fontSize: 9,
    lineHeight: 11,
    color: tide.textDim,
    textAlign: 'center',
    includeFontPadding: false,
  },
});
