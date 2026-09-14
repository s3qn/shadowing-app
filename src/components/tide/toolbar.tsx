import { type ReactNode } from 'react';
import { StyleSheet, Text, View } from 'react-native';

import { PressScale } from '@/components/press-scale';
import { fonts } from '@/constants/fonts';
import { tide } from '@/constants/theme';

export type ToolbarItem = {
  key: string;
  icon: ReactNode;
  label: string;
  value?: string;
  active?: boolean;
  onPress: () => void;
};

/**
 * The row of icon-plus-label buttons above the dock: Speed, Repeat, Reading,
 * Blind, Lag. Each button opens the one sheet for its setting; the label
 * under the icon stays put and the value line follows whatever the sheet
 * last set.
 */
export function Toolbar({ items }: { items: ToolbarItem[] }) {
  return (
    <View style={styles.row}>
      {items.map((item) => (
        <PressScale
          key={item.key}
          onPress={item.onPress}
          accessibilityRole="button"
          accessibilityLabel={item.value ? `${item.label}, ${item.value}` : item.label}
          style={styles.item}>
          {item.icon}
          <Text style={[styles.label, item.active && styles.active]}>{item.label}</Text>
          {item.value ? <Text style={styles.value}>{item.value}</Text> : null}
        </PressScale>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', justifyContent: 'space-around', paddingVertical: 12, paddingHorizontal: 6 },
  item: { minWidth: 60, alignItems: 'center', gap: 3 },
  label: { fontFamily: fonts.uiMedium, fontSize: 11, color: tide.textDim },
  value: { fontFamily: fonts.ui, fontSize: 11, color: tide.text },
  active: { color: tide.lang.ja },
});
