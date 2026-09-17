import { SymbolView, type SymbolViewProps } from 'expo-symbols';
import { type ReactNode } from 'react';
import { Pressable, StyleSheet, Switch, Text, View } from 'react-native';

import { fonts } from '@/constants/fonts';
import { tide } from '@/constants/theme';

/** The rows every sheet is built from: an option to pick, a toggle, a menu
 * action (with an optional leading icon), and a plain note. */

/** Per-platform symbol names for a sheet row: SF Symbol on iOS, Material Symbol on Android. */
export type SheetIcon = Exclude<SymbolViewProps['name'], string>;

type SheetOptionProps = {
  label: string;
  hint?: string;
  selected: boolean;
  onPress: () => void;
};

export function SheetOption({ label, hint, selected, onPress }: SheetOptionProps) {
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityState={{ selected }}
      style={({ pressed }) => [
        styles.row,
        styles.option,
        selected ? styles.optionSelected : styles.optionDivider,
        pressed && !selected && styles.rowPressed,
      ]}>
      <View style={styles.text}>
        <Text style={[styles.label, selected && styles.labelSelected]}>{label}</Text>
        {hint ? <Text style={styles.hint}>{hint}</Text> : null}
      </View>
    </Pressable>
  );
}

type SheetToggleProps = {
  label: string;
  hint?: string;
  value: boolean;
  onValueChange: (value: boolean) => void;
  /** Leading symbol, never destructive or disabled so it always uses `tide.text`. */
  icon?: SheetIcon;
};

export function SheetToggle({ label, hint, value, onValueChange, icon }: SheetToggleProps) {
  return (
    <View style={styles.row}>
      <View style={styles.lead}>
        {icon ? (
          <View style={styles.iconSlot}>
            <SymbolView name={icon} size={20} weight="regular" tintColor={tide.text} />
          </View>
        ) : null}
        <View style={styles.text}>
          <Text style={styles.label}>{label}</Text>
          {hint ? <Text style={styles.hint}>{hint}</Text> : null}
        </View>
      </View>
      <Switch
        value={value}
        onValueChange={onValueChange}
        trackColor={{ true: tide.lang.ja, false: 'rgba(255,255,255,0.2)' }}
      />
    </View>
  );
}

type SheetActionProps = {
  label: string;
  hint?: string;
  destructive?: boolean;
  disabled?: boolean;
  /** Leading symbol. The row picks its tint so it always matches the label. */
  icon?: SheetIcon;
  onPress: () => void;
};

export function SheetAction({ label, hint, destructive, disabled, icon, onPress }: SheetActionProps) {
  // Same precedence as the label style array: destructive, then disabled overrides.
  const tint = disabled ? tide.textDim : destructive ? tide.record : tide.text;
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      accessibilityRole="button"
      accessibilityState={{ disabled }}
      style={({ pressed }) => [styles.row, pressed && !disabled && styles.rowPressed]}>
      <View style={styles.lead}>
        {icon ? (
          <View style={styles.iconSlot}>
            <SymbolView name={icon} size={20} weight="regular" tintColor={tint} />
          </View>
        ) : null}
        <View style={styles.text}>
          <Text style={[styles.label, destructive && styles.destructive, disabled && styles.disabled]}>{label}</Text>
          {hint ? <Text style={styles.hint}>{hint}</Text> : null}
        </View>
      </View>
    </Pressable>
  );
}

export function SheetNote({ children }: { children: ReactNode }) {
  return <Text style={styles.note}>{children}</Text>;
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
  option: { borderWidth: 1, borderColor: 'transparent', marginVertical: 2 },
  optionDivider: { borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: 'rgba(255,255,255,0.06)' },
  optionSelected: { backgroundColor: 'rgba(255,158,128,0.12)', borderColor: tide.lang.ja },
  lead: { flexDirection: 'row', alignItems: 'center', gap: 12, flexShrink: 1 },
  iconSlot: { width: 24, height: 24, alignItems: 'center', justifyContent: 'center' },
  text: { flexShrink: 1, gap: 2 },
  label: { fontFamily: fonts.ui, fontSize: 16, color: tide.text },
  labelSelected: { color: tide.lang.ja },
  hint: { fontFamily: fonts.ui, fontSize: 12, color: tide.textDim },
  destructive: { color: tide.record },
  disabled: { color: tide.textDim },
  note: { fontFamily: fonts.ui, fontSize: 12, color: tide.textDim },
});
