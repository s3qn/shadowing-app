import { StyleSheet, Text, View } from 'react-native';
import { SymbolView } from 'expo-symbols'; // icon-buttons: Whole line

import { PrismButton } from '@/components/prism'; // icon-buttons: Whole line
import { fonts } from '@/constants/fonts'; // icon-buttons: Whole line
import { Radius, Spacing, tide, verb as verbTokens, prism } from '@/constants/theme'; // icon-buttons: Whole line

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
        {/* icon-buttons: Whole line */}
        <View style={{ alignItems: 'center' }}>
          <PrismButton shape="round" size={prism.sizes.roundSm} verb="listen" onPress={onClear} accessibilityLabel="Whole line">
            <SymbolView name={{ ios: 'arrow.left.and.right', android: 'swap_horiz' }} size={16} weight="regular" tintColor={verbTokens.listen.c1} />
          </PrismButton>
          <Text style={{ fontFamily: fonts.ui, fontSize: 11, color: tide.textDim, marginTop: 4, textAlign: 'center' }}>Whole line</Text>
        </View>
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
