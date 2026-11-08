import type { ReactNode } from 'react';
import { StyleSheet, View, type StyleProp, type ViewStyle } from 'react-native';

import { PressScale } from '@/components/press-scale';
import { tide, withAlpha } from '@/constants/theme';

/** The one corner radius of a glass card (the add-island sheet tiles). */
export const GLASS_RADIUS = 20;

/**
 * A card on the Tide sky: faint white fill, hairline border, one radius.
 * With `onPress` it is a PressScale button, without it a plain View. Copied
 * from the add-island sheet tiles; size and layout go in `style`.
 */
export function GlassCard({
  children,
  onPress,
  style,
  accessibilityLabel,
}: {
  children?: ReactNode;
  onPress?: () => void;
  style?: StyleProp<ViewStyle>;
  accessibilityLabel?: string;
}) {
  if (onPress) {
    return (
      <PressScale onPress={onPress} accessibilityRole="button" accessibilityLabel={accessibilityLabel} style={[styles.card, style]}>
        {children}
      </PressScale>
    );
  }
  return <View style={[styles.card, style]}>{children}</View>;
}

const styles = StyleSheet.create({
  card: {
    borderRadius: GLASS_RADIUS,
    borderWidth: 1,
    borderColor: withAlpha(tide.text, 0.12),
    backgroundColor: withAlpha(tide.text, 0.06),
  },
});
