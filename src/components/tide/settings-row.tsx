import type { ReactNode } from 'react';
import { StyleSheet, Switch, Text, View } from 'react-native';
import { SymbolView } from 'expo-symbols';

import { PressScale } from '@/components/press-scale';
import type { SheetIcon } from '@/components/sheet/sheet-rows';
import { fonts } from '@/constants/fonts';
import { Radius, Spacing, tide } from '@/constants/theme';

/**
 * iOS-style grouped list section: an uppercase header, a card of rows with a
 * hairline between each (never on the card's own edges), and an optional
 * footnote under the card.
 */
export function SettingsSection({
  title,
  footnote,
  children,
}: {
  title: string;
  footnote?: string;
  children: ReactNode;
}) {
  return (
    <View style={styles.section}>
      <Text style={[styles.title, { color: tide.textDim }]}>{title}</Text>
      <View style={[styles.card, { backgroundColor: tide.water }]}>{children}</View>
      {footnote ? <Text style={[styles.footnote, { color: tide.textDim }]}>{footnote}</Text> : null}
    </View>
  );
}

/** One row in a `SettingsSection`: a label, and a chevron, a value, or a Switch on the right. */
export function SettingsRow({
  label,
  value,
  onPress,
  switchValue,
  onSwitchChange,
  destructive,
  last,
  dotColor,
  icon,
}: {
  label: string;
  value?: string;
  onPress?: () => void;
  switchValue?: boolean;
  onSwitchChange?: (next: boolean) => void;
  destructive?: boolean;
  /** Drops the hairline under the row: pass on the last row of a card. */
  last?: boolean;
  /** Small status dot before the value, for things like a live connection check. */
  dotColor?: string;
  /** Leading symbol. The row picks its tint so it always matches the label. */
  icon?: SheetIcon;
}) {
  const hasSwitch = onSwitchChange !== undefined;
  const tint = destructive ? tide.record : tide.text;
  const content = (
    <View style={[styles.row, !last && { borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: tide.waterline }]}>
      <View style={styles.lead}>
        {icon ? (
          <View style={styles.iconSlot}>
            <SymbolView name={icon} size={20} weight="regular" tintColor={tint} />
          </View>
        ) : null}
        <Text style={[styles.label, { color: destructive ? tide.record : tide.text }]}>{label}</Text>
      </View>
      {hasSwitch ? (
        <Switch
          value={switchValue}
          onValueChange={onSwitchChange}
          trackColor={{ false: 'rgba(255,255,255,0.14)', true: tide.lang.ja }}
        />
      ) : (
        <View style={styles.rightGroup}>
          {dotColor ? <View style={[styles.dot, { backgroundColor: dotColor }]} /> : null}
          {value ? <Text style={[styles.value, { color: tide.textDim }]}>{value}</Text> : null}
          {onPress ? <Text style={[styles.chevron, { color: tide.textDim }]}>{'›'}</Text> : null}
        </View>
      )}
    </View>
  );

  if (!onPress) return content;
  return (
    <PressScale onPress={onPress} accessibilityRole="button" accessibilityLabel={label}>
      {content}
    </PressScale>
  );
}

const styles = StyleSheet.create({
  section: { gap: Spacing.xs },
  title: {
    fontSize: 12,
    fontFamily: fonts.uiMedium,
    fontWeight: '500',
    textTransform: 'uppercase',
    letterSpacing: 0.5,
    marginLeft: Spacing.sm,
  },
  card: { borderRadius: Radius.md, overflow: 'hidden' },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingVertical: Spacing.md,
    paddingHorizontal: Spacing.lg,
    gap: Spacing.md,
  },
  lead: { flexDirection: 'row', alignItems: 'center', gap: 12, flexShrink: 1 },
  iconSlot: { width: 24, height: 24, alignItems: 'center', justifyContent: 'center' },
  label: { fontSize: 16, fontFamily: fonts.ui },
  rightGroup: { flexDirection: 'row', alignItems: 'center', gap: Spacing.xs },
  dot: { width: 8, height: 8, borderRadius: 4 },
  value: { fontSize: 15, fontFamily: fonts.ui },
  chevron: { fontSize: 18, fontFamily: fonts.ui },
  footnote: { fontSize: 12, lineHeight: 17, marginHorizontal: Spacing.sm },
});
