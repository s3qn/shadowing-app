import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';

import { Radius, Spacing } from '@/constants/theme';
import { useTheme } from '@/hooks/use-theme';
import type { Gloss } from '@/lib/api';

export const POPOVER_WIDTH = 250;

type Props = {
  word: string;
  gloss: Gloss | null;
  /** Absolute position inside the sentence block, computed by the screen. */
  left: number;
  top: number;
  onHear: () => void;
  onClose: () => void;
};

/**
 * Yomitan-style popover under a tapped word: reading, meaning, a button to
 * hear the word again. Absolutely positioned so the sentence never moves.
 * It never touches playback itself; the screen decides what Hear it does.
 */
export function WordPanel({ word, gloss, left, top, onHear, onClose }: Props) {
  const { palette } = useTheme();
  return (
    <View
      style={[
        styles.pop,
        { left, top, backgroundColor: palette.surface, borderColor: palette.line, shadowColor: '#000' },
      ]}>
      <View style={styles.head}>
        <View style={styles.headText}>
          <Text style={[styles.word, { color: palette.ink }]} numberOfLines={1}>
            {word}
          </Text>
          {gloss?.reading ? (
            <Text style={[styles.reading, { color: palette.muted }]} numberOfLines={1}>
              {gloss.reading}
              {gloss.base && gloss.base !== word.replace(/[、。！？]/g, '') ? `  ·  ${gloss.base}` : ''}
            </Text>
          ) : null}
        </View>
        <Pressable onPress={onClose} hitSlop={12}>
          <Text style={[styles.close, { color: palette.muted }]}>×</Text>
        </Pressable>
      </View>

      <ScrollView style={styles.body} contentContainerStyle={{ gap: 4 }} nestedScrollEnabled>
        {gloss === null ? (
          <Text style={[styles.meaning, { color: palette.muted }]}>Looking up…</Text>
        ) : !gloss.found ? (
          <Text style={[styles.meaning, { color: palette.muted }]}>No dictionary entry.</Text>
        ) : (
          gloss.entries.slice(0, 2).map((entry, i) =>
            entry.senses.slice(0, 3).map((sense, j) => (
              <Text key={`${i}-${j}`} style={[styles.meaning, { color: palette.ink }]}>
                {sense.glosses.join('; ')}
                {sense.pos.length ? <Text style={{ color: palette.muted }}>  {sense.pos[0]}</Text> : null}
              </Text>
            )),
          )
        )}
      </ScrollView>

      <Pressable onPress={onHear} style={[styles.hear, { backgroundColor: palette.accent }]}>
        <Text style={[styles.hearText, { color: palette.accentInk }]}>Hear again</Text>
      </Pressable>
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
  word: { fontSize: 20, fontWeight: '700' },
  reading: { fontSize: 13 },
  close: { fontSize: 22, lineHeight: 24, fontWeight: '600', paddingHorizontal: 4 },
  body: { flexGrow: 0, maxHeight: 96 },
  meaning: { fontSize: 14, lineHeight: 20 },
  hear: { paddingVertical: Spacing.sm, borderRadius: Radius.pill, alignItems: 'center' },
  hearText: { fontSize: 14, fontWeight: '700' },
});
