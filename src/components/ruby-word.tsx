import { type LayoutChangeEvent, StyleSheet, Text, View } from 'react-native';

import { Radius } from '@/constants/theme';
import { useTheme } from '@/hooks/use-theme';
import type { Word } from '@/lib/api';

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
export function RubyWord({ word, showRuby, active, selected, dimmed, mark, onLayout }: Props) {
  const { palette } = useTheme();
  const segments = showRuby && word.ruby?.some((s) => s.rt) ? word.ruby : null;
  const ink = active ? palette.accentInk : dimmed ? palette.muted : palette.ink;
  const rubyInk = active ? palette.accentInk : palette.muted;
  const baseStyle = [styles.base, { color: ink, textDecorationLine: selected ? 'underline' : 'none' } as const];
  const markColor =
    mark === 'early' ? palette.info : mark === 'late' ? palette.warn : mark === 'dropped' ? palette.danger : 'transparent';
  return (
    <View
      onLayout={onLayout}
      style={[
        styles.word,
        segments ? styles.rubyRow : styles.plain,
        {
          backgroundColor: active ? palette.accent : selected ? palette.surfaceAlt : 'transparent',
          borderBottomWidth: 3,
          borderBottomColor: markColor,
        },
      ]}>
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
  );
}

const styles = StyleSheet.create({
  word: {
    flexShrink: 1,
    maxWidth: '100%',
    paddingHorizontal: 4,
    borderRadius: Radius.sm,
  },
  rubyRow: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'flex-end' },
  plain: { flexDirection: 'column', justifyContent: 'flex-end' },
  segment: { alignItems: 'center', flexShrink: 1, maxWidth: '100%' },
  rt: { fontSize: 13, lineHeight: 16, includeFontPadding: false },
  base: { fontSize: 32, lineHeight: 40, fontWeight: '600', includeFontPadding: false },
});
