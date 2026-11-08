import { StyleSheet, Text, type TextProps } from 'react-native';

import { fonts } from '@/constants/fonts';
import { tide } from '@/constants/theme';
import { useDir } from '@/lib/i18n';

/** A screen's own title in the body (20/26, medium). The one style every
 * screen uses; copied from the import screen. */
export function ScreenTitle({ style, ...rest }: TextProps) {
  const dir = useDir();
  return <Text {...rest} style={[styles.title, dir.text, style]} />;
}

const styles = StyleSheet.create({
  title: { fontSize: 20, lineHeight: 26, color: tide.text, fontFamily: fonts.uiMedium, fontWeight: '500' },
});
