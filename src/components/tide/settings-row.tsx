import type { ReactNode } from 'react';
import { StyleSheet, Switch, Text, View } from 'react-native';
import { SymbolView } from 'expo-symbols';

import { PressScale } from '@/components/press-scale';
import type { SheetIcon } from '@/components/sheet/sheet-rows';
import { fonts } from '@/constants/fonts';
import { Radius, Spacing, tide, verb, withAlpha } from '@/constants/theme';
import { useDir } from '@/lib/i18n';

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
  const dir = useDir();
  return (
    <View style={styles.section}>
      <Text style={[styles.title, { color: tide.textDim }, dir.text, dir.rtl && styles.titleRtl]}>{title}</Text>
      <View style={[styles.card, { backgroundColor: tide.water }]}>{children}</View>
      {footnote ? <Text style={[styles.footnote, { color: tide.textDim }, dir.text]}>{footnote}</Text> : null}
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
  singleLineValue,
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
  /** Keeps a long value on one line, truncated in the middle, with the label kept whole. */
  singleLineValue?: boolean;
}) {
  const hasSwitch = onSwitchChange !== undefined;
  const tint = destructive ? tide.record : tide.text;
  const dir = useDir();
  const content = (
    <View
      style={[
        styles.row,
        dir.row,
        !last && { borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: tide.waterline },
      ]}>
      <View style={[styles.lead, dir.row, singleLineValue && styles.leadFixed]}>
        {icon ? (
          <View style={styles.iconSlot}>
            <SymbolView name={icon} size={20} weight="regular" tintColor={tint} />
          </View>
        ) : null}
        <Text style={[styles.label, { color: destructive ? tide.record : tide.text }, dir.text]}>{label}</Text>
      </View>
      {hasSwitch ? (
        <Switch
          value={switchValue}
          onValueChange={onSwitchChange}
          trackColor={{ false: 'rgba(255,255,255,0.14)', true: tide.lang.ja }}
        />
      ) : (
        <View style={[styles.rightGroup, dir.row, singleLineValue && styles.shrink]}>
          {dotColor ? <View style={[styles.dot, { backgroundColor: dotColor }]} /> : null}
          {value ? (
            <Text
              style={[styles.value, { color: tide.textDim }, dir.text, singleLineValue && styles.shrink]}
              numberOfLines={singleLineValue ? 1 : undefined}
              ellipsizeMode={singleLineValue ? 'middle' : undefined}>
              {value}
            </Text>
          ) : null}
          {onPress ? <Text style={[styles.chevron, { color: tide.textDim }]}>{dir.chevron}</Text> : null}
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
  titleRtl: { marginLeft: 0, marginRight: Spacing.sm },
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
  leadFixed: { flexShrink: 0 },
  shrink: { flexShrink: 1 },
  iconSlot: {
    width: 26,
    height: 26,
    borderRadius: 13,
    backgroundColor: withAlpha(verb.tools.c2, 0.16),
    alignItems: 'center',
    justifyContent: 'center',
  },
  label: { fontSize: 16, fontFamily: fonts.ui },
  rightGroup: { flexDirection: 'row', alignItems: 'center', gap: Spacing.xs },
  dot: { width: 8, height: 8, borderRadius: 4 },
  value: { fontSize: 15, fontFamily: fonts.ui },
  chevron: { fontSize: 18, fontFamily: fonts.ui },
  footnote: { fontSize: 12, lineHeight: 17, marginHorizontal: Spacing.sm },
});
