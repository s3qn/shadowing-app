import { StyleSheet, Text } from 'react-native';

import { fonts } from '@/constants/fonts';
import { prism, tide } from '@/constants/theme';
import { PrismButton } from '@/components/prism/prism-button';

type RoundButtonProps = {
  glyph: string;
  onPress: () => void;
  disabled?: boolean;
  label: string;
  /** Drops this button's own blur and drop shadow: for a dock inside a GlassPanel. */
  flat?: boolean;
};

export function RoundButton({ glyph, onPress, disabled, label, flat }: RoundButtonProps) {
  return (
    <PrismButton
      shape="round"
      verb="listen"
      size={prism.sizes.round}
      flat={flat}
      onPress={onPress}
      disabled={disabled}
      accessibilityLabel={label}>
      <Text style={styles.glyph}>{glyph}</Text>
    </PrismButton>
  );
}

const styles = StyleSheet.create({
  glyph: { fontFamily: fonts.ui, fontSize: 26, color: tide.text },
});
