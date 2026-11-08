import { Platform, Pressable, StyleSheet, Text, View } from 'react-native';

import { PrismButton } from '@/components/prism';
import { tide } from '@/constants/theme';
import { useDir } from '@/lib/i18n';

/** Header-left button for the record, build and import screens: the same tools
 * pill as the back button on the review screen, inset from the screen edge.
 * On iOS 26 the native header already draws a glass capsule around the item, so
 * it renders a bare label there (no inner capsule), like the ladder help button. */
export function HeaderClosePill({ label, onPress }: { label: string; onPress: () => void }) {
  const dir = useDir();
  if (Platform.select({ ios: true, default: false })) {
    return (
      <Pressable onPress={onPress} hitSlop={10} accessibilityRole="button" accessibilityLabel={label} style={({ pressed }) => [styles.bare, pressed && { opacity: 0.7 }]}>
        <Text style={styles.bareText}>{label}</Text>
      </Pressable>
    );
  }
  return (
    <View style={dir.rtl ? { marginEnd: 12 } : { marginStart: 12 }}>
      <PrismButton shape="pill" verb="tools" label={label} onPress={onPress} />
    </View>
  );
}

const styles = StyleSheet.create({
  bare: { minHeight: 36, paddingHorizontal: 4, alignItems: 'center', justifyContent: 'center' },
  bareText: { fontSize: 17, lineHeight: 20, textAlign: 'center', color: tide.text },
});

/** Header options that put the close pill at the reading start: left in a left
 * to right interface, right in Hebrew and Arabic (the native header stays left
 * to right, so the pill moves to `headerRight` and the title follows
 * `headerSides`). Spread into `<Stack.Screen options>`. */
export function useClosePillOptions(label: string, onPress: () => void) {
  const dir = useDir();
  const pill = () => <HeaderClosePill label={label} onPress={onPress} />;
  return dir.rtl
    ? { ...dir.headerSides, headerLeft: () => null, headerRight: pill }
    : { headerLeft: pill };
}
