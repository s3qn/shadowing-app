import { View } from 'react-native';

import { PrismButton } from '@/components/prism';

/** Header-left button for the record, build and import screens: the same tools
 * pill as the back button on the review screen, inset from the screen edge. */
export function HeaderClosePill({ label, onPress }: { label: string; onPress: () => void }) {
  return (
    <View style={{ marginStart: 12 }}>
      <PrismButton shape="pill" verb="tools" label={label} onPress={onPress} />
    </View>
  );
}
