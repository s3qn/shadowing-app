import { StyleSheet, TextInput, type TextInputProps } from 'react-native';

import { fonts } from '@/constants/fonts';
import { prism, Radius, Spacing, tide } from '@/constants/theme';

/**
 * The app's one text field: the glass fill and rim of a GlassPanel at
 * Radius.md. Takes every TextInput prop; `style` is applied last so a
 * caller can set margins, minHeight or text direction.
 */
export function GlassInput({ style, placeholderTextColor, ...rest }: TextInputProps) {
  return <TextInput placeholderTextColor={placeholderTextColor ?? tide.textDim} style={[styles.input, style]} {...rest} />;
}

const styles = StyleSheet.create({
  input: {
    fontFamily: fonts.ui,
    fontSize: 16,
    color: tide.text,
    backgroundColor: prism.panel.fill,
    borderRadius: Radius.md,
    borderWidth: 1,
    borderColor: prism.panel.rim,
    paddingHorizontal: Spacing.md,
    paddingVertical: Spacing.sm + 2,
  },
});
