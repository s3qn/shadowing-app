import { Platform, Pressable, StyleSheet, Text, View } from 'react-native';

import { PrismButton } from '@/components/prism';
import { tide } from '@/constants/theme';

/** Header-left button for the record, build and import screens: the same tools
 * pill as the back button on the review screen, inset from the screen edge.
 * On iOS 26 the native header already draws a glass capsule around the item, so
 * it renders a bare label there (no inner capsule), like the ladder help button. */
export function HeaderClosePill({ label, onPress }: { label: string; onPress: () => void }) {
  if (Platform.select({ ios: true, default: false })) {
    return (
      <Pressable onPress={onPress} hitSlop={10} accessibilityRole="button" accessibilityLabel={label} style={({ pressed }) => [styles.bare, pressed && { opacity: 0.7 }]}>
        <Text style={styles.bareText}>{label}</Text>
      </Pressable>
    );
  }
  return (
    <View style={{ marginStart: 12 }}>
      <PrismButton shape="pill" verb="tools" label={label} onPress={onPress} />
    </View>
  );
}

const styles = StyleSheet.create({
  bare: { minHeight: 36, paddingHorizontal: 4, alignItems: 'center', justifyContent: 'center' },
  bareText: { fontSize: 17, lineHeight: 20, textAlign: 'center', color: tide.text },
});
