import { SymbolView } from 'expo-symbols';
import { StyleSheet, View } from 'react-native';

import { PrismButton } from '@/components/prism'; // icon-buttons: Whole line
import { Spacing, tide } from '@/constants/theme';
import { useDir, useT } from '@/lib/i18n';

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
  const { t } = useT();
  const dir = useDir();
  if (!label) return null;

  return (
    <View style={styles.container}>
      <View style={[styles.row, dir.row]}>
        <PrismButton
          shape="pill"
          verb="speak"
          label={hidden ? t('player.phrase') : t('player.phraseWith', { label })}
          onPress={onClear}
          accessibilityLabel={t('player.wholeLine')}>
          <SymbolView name={{ ios: 'xmark', android: 'close' }} size={12} weight="semibold" tintColor={tide.textDim} />
        </PrismButton>
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
});
