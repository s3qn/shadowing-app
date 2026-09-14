import { type ReactNode } from 'react';
import { Pressable, StyleSheet, Switch, Text, View } from 'react-native';

import { fonts } from '@/constants/fonts';
import { tide } from '@/constants/theme';

/** The rows every sheet is built from: an option to pick, a toggle, a menu
 * action, and a plain note. */

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
      style={({ pressed }) => [styles.row, pressed && styles.rowPressed]}>
      <View style={styles.text}>
        <Text style={styles.label}>{label}</Text>
        {hint ? <Text style={styles.hint}>{hint}</Text> : null}
      </View>
      {selected ? <Text style={styles.check}>✓</Text> : null}
    </Pressable>
  );
}

type SheetToggleProps = {
  label: string;
  hint?: string;
  value: boolean;
  onValueChange: (value: boolean) => void;
};

export function SheetToggle({ label, hint, value, onValueChange }: SheetToggleProps) {
  return (
    <View style={styles.row}>
      <View style={styles.text}>
        <Text style={styles.label}>{label}</Text>
        {hint ? <Text style={styles.hint}>{hint}</Text> : null}
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
  onPress: () => void;
};

export function SheetAction({ label, hint, destructive, disabled, onPress }: SheetActionProps) {
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      accessibilityRole="button"
      accessibilityState={{ disabled }}
      style={({ pressed }) => [styles.row, pressed && !disabled && styles.rowPressed]}>
      <View style={styles.text}>
        <Text style={[styles.label, destructive && styles.destructive, disabled && styles.disabled]}>{label}</Text>
        {hint ? <Text style={styles.hint}>{hint}</Text> : null}
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
  text: { flexShrink: 1, gap: 2 },
  label: { fontFamily: fonts.ui, fontSize: 16, color: tide.text },
  hint: { fontFamily: fonts.ui, fontSize: 12, color: tide.textDim },
  check: { fontFamily: fonts.ui, fontSize: 16, color: tide.lang.ja },
  destructive: { color: tide.record },
  disabled: { color: tide.textDim },
  note: { fontFamily: fonts.ui, fontSize: 12, color: tide.textDim },
});
