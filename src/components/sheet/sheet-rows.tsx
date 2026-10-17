import { SymbolView, type SymbolViewProps } from 'expo-symbols';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { fonts } from '@/constants/fonts';
import { tide, withAlpha } from '@/constants/theme';
import { useDir } from '@/lib/i18n';

/** The row every sheet is built from: a menu action with an optional leading icon. */

/** Per-platform symbol names for a sheet row: SF Symbol on iOS, Material Symbol on Android. */
export type SheetIcon = Exclude<SymbolViewProps['name'], string>;

type SheetActionProps = {
  label: string;
  hint?: string;
  destructive?: boolean;
  disabled?: boolean;
  /** Leading symbol. The row picks its tint so it always matches the label. */
  icon?: SheetIcon;
  /** Disc colour behind the leading symbol. Undefined draws the plain icon slot, unchanged. */
  discColor?: string;
  onPress: () => void;
};

export function SheetAction({ label, hint, destructive, disabled, icon, discColor, onPress }: SheetActionProps) {
  const dir = useDir();
  // Same precedence as the label style array: destructive, then disabled overrides.
  const tint = disabled ? tide.textDim : destructive ? tide.record : discColor ? discColor : tide.text;
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      accessibilityRole="button"
      accessibilityState={{ disabled }}
      style={({ pressed }) => [styles.row, dir.row, pressed && !disabled && styles.rowPressed]}>
      <View style={[styles.lead, dir.row]}>
        {icon ? (
          discColor ? (
            <View
              style={[
                styles.iconDisc,
                { backgroundColor: withAlpha(discColor, 0.18), borderColor: withAlpha(discColor, 0.35) },
              ]}>
              <SymbolView name={icon} size={20} weight="regular" tintColor={tint} />
            </View>
          ) : (
            <View style={styles.iconSlot}>
              <SymbolView name={icon} size={20} weight="regular" tintColor={tint} />
            </View>
          )
        ) : null}
        <View style={styles.text}>
          <Text style={[styles.label, dir.text, destructive && styles.destructive, disabled && styles.disabled]}>
            {label}
          </Text>
          {hint ? <Text style={[styles.hint, dir.text]}>{hint}</Text> : null}
        </View>
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    minHeight: 48,
    borderRadius: 12,
    paddingHorizontal: 12,
  },
  rowPressed: { backgroundColor: 'rgba(255,255,255,0.06)' },
  lead: { flexDirection: 'row', alignItems: 'center', gap: 12, flexShrink: 1 },
  iconSlot: { width: 24, height: 24, alignItems: 'center', justifyContent: 'center' },
  iconDisc: {
    width: 26,
    height: 26,
    borderRadius: 13,
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  text: { flexShrink: 1, gap: 2 },
  label: { fontFamily: fonts.ui, fontSize: 16, color: tide.text },
  hint: { fontFamily: fonts.ui, fontSize: 12, color: tide.textDim },
  destructive: { color: tide.record },
  disabled: { color: tide.textDim },
});
