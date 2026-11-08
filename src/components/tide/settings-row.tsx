import { type ReactNode, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { SymbolView } from 'expo-symbols';

import { Segmented, type SegmentOption } from '@/components/segmented';
import { TickRuler } from '@/components/tide/tick-ruler';
import { TideToggle } from '@/components/tide/tide-toggle';
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
      {footnote ? (
        <Text {...dir.words.props} style={[styles.footnote, { color: tide.textDim }, dir.text, dir.words.style]}>
          {footnote}
        </Text>
      ) : null}
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
  fitValue,
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
  /** Label keeps at least 40% of the row, the value takes the rest on one line and truncates at its end. */
  fitValue?: boolean;
}) {
  const hasSwitch = onSwitchChange !== undefined;
  const tint = destructive ? tide.record : tide.text;
  const dir = useDir();
  const content = (
    <View
      style={[
        styles.row,
        dir.row,
        fitValue && styles.rowFit,
        !last && { borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: tide.waterline },
      ]}>
      <View style={[styles.lead, dir.row, singleLineValue && styles.leadFixed, fitValue && styles.leadFit]}>
        {icon ? (
          <View style={styles.iconSlot}>
            <SymbolView name={icon} size={20} weight="regular" tintColor={tint} />
          </View>
        ) : null}
        <Text {...dir.words.props} style={[styles.label, { color: destructive ? tide.record : tide.text }, dir.text, dir.words.style]}>
          {label}
        </Text>
      </View>
      {hasSwitch ? (
        <TideToggle value={!!switchValue} onValueChange={onSwitchChange} />
      ) : (
        <View style={[styles.rightGroup, dir.row, (singleLineValue || fitValue) && styles.shrink, fitValue && styles.rightFit]}>
          {dotColor ? <View style={[styles.dot, { backgroundColor: dotColor }]} /> : null}
          {value ? (
            <Text
              {...dir.words.props}
              style={[styles.value, { color: tide.textDim }, dir.text, dir.words.style, (singleLineValue || fitValue) && styles.shrink, fitValue && styles.valueFit, fitValue && { textAlign: dir.rtl ? 'left' : 'right' }]}
              numberOfLines={singleLineValue || fitValue ? 1 : undefined}
              ellipsizeMode={fitValue ? 'tail' : singleLineValue ? 'middle' : undefined}>
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

/** A settings section whose card holds one Segmented (2 to 7 options). */
export function SettingsSegmentRow<T extends string>({
  title,
  footnote,
  options,
  value,
  onChange,
  scrollable,
  ltr,
}: {
  title: string;
  footnote?: string;
  options: readonly SegmentOption<T>[];
  value: T;
  onChange: (next: T) => void;
  scrollable?: boolean;
  ltr?: boolean;
}) {
  return (
    <SettingsSection title={title} footnote={footnote}>
      <View style={styles.segBox}>
        <Segmented options={options} value={value} onChange={onChange} scrollable={scrollable} ltr={ltr} />
      </View>
    </SettingsSection>
  );
}

/** A settings section whose card holds a readout over a TickRuler. The ruler takes the card's width. */
export function SettingsRulerRow({
  title,
  footnote,
  readout,
  steps,
  index,
  onIndexChange,
  onSettle,
  isMajor,
  tickLabel,
  accessibilityLabel,
}: {
  title: string;
  footnote?: string;
  readout: string;
  steps: number;
  index: number;
  onIndexChange: (index: number) => void;
  onSettle?: (index: number) => void;
  isMajor: (index: number) => boolean;
  tickLabel: (index: number) => string;
  accessibilityLabel: string;
}) {
  const [w, setW] = useState(0);
  return (
    <SettingsSection title={title} footnote={footnote}>
      <View style={styles.rulerBox} onLayout={(e) => setW(e.nativeEvent.layout.width - 2 * Spacing.md)}>
        <Text style={styles.readout}>{readout}</Text>
        {w > 0 ? (
          <TickRuler
            width={w}
            steps={steps}
            index={index}
            onIndexChange={onIndexChange}
            onSettle={onSettle}
            isMajor={isMajor}
            tickLabel={tickLabel}
            accessibilityLabel={accessibilityLabel}
          />
        ) : null}
      </View>
    </SettingsSection>
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
  rowFit: { gap: 12 },
  leadFit: { flexShrink: 0, minWidth: '40%' },
  rightFit: { flex: 1, justifyContent: 'flex-end' },
  valueFit: { flexShrink: 1 },
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
  segBox: { padding: Spacing.md },
  rulerBox: { padding: Spacing.md, alignItems: 'center', gap: Spacing.xs },
  readout: { fontFamily: fonts.uiMedium, fontWeight: '500', fontSize: 20, color: tide.text, fontVariant: ['tabular-nums'] },
});
