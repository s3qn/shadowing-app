import { Pressable, StyleSheet, Text, View } from 'react-native';

import { Radius, Spacing, tide } from '@/constants/theme';

type Props = {
  label: string | null; // "first 〜 last" when a phrase is set
  hidden: boolean; // Blind mode: never show Japanese
  onClear: () => void;
};

/**
 * The chip row once a phrase is set: the label (or just "Phrase" in Blind
 * mode) and a button back to the whole line. Renders nothing with no phrase set.
 */
export function PhraseBar({ label, hidden, onClear }: Props) {
  if (!label) return null;

  return (
    <View style={styles.container}>
      <View style={styles.row}>
        <View style={[styles.pill, { backgroundColor: tide.lang.ja }]}>
          <Text style={[styles.pillText, { color: tide.sky[0] }]}>{hidden ? 'Phrase' : `Phrase: ${label}`}</Text>
        </View>
        <Pressable onPress={onClear} hitSlop={8}>
          <Text style={[styles.link, { color: tide.lang.ja }]}>Whole line</Text>
        </Pressable>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { alignItems: 'center' },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: Spacing.sm,
    marginTop: Spacing.xs,
  },
  pill: {
    borderRadius: Radius.pill,
    paddingVertical: Spacing.xs + 2,
    paddingHorizontal: Spacing.md,
  },
  pillText: { fontSize: 13, fontWeight: '700' },
  link: { fontSize: 13, fontWeight: '700' },
});
