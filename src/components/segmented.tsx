import { useEffect, useState } from 'react';
import { type LayoutChangeEvent, Pressable, StyleSheet, Text, View } from 'react-native';
import Animated, { useAnimatedStyle, useSharedValue, withSpring, withTiming } from 'react-native-reanimated';

import { fonts } from '@/constants/fonts';
import { Spacing, prism, tide } from '@/constants/theme';
import { LitPillFill, LitPillRim, PILL_H, PILL_ICON_OFF, PILL_LABEL_SIZE, PillTrayShell } from '@/components/prism/pill-tray';

export type SegmentOption<T extends string> = {
  value: T;
  label: string;
  /** One dim line under the control, shown while this option is selected. */
  description: string;
};

type Props<T extends string> = {
  label: string;
  options: readonly SegmentOption<T>[];
  value: T;
  onChange: (next: T) => void;
};

const SEGMENT_BORDER = 1;

/**
 * One option in a `Segmented` row: a pill that crossfades its own lit fill,
 * the same chrome `SortPill` draws for the Home sort row (`LitPillFill` plus
 * `LitPillRim`). Sized with `flex: 1` so it shares the row evenly with its
 * siblings, unlike the sort row's pills, which hug their own label.
 */
function SegmentPill({ on, label, onPress }: { on: boolean; label: string; onPress: () => void }) {
  const [size, setSize] = useState({ width: 0, height: 0 });
  const litOpacity = useSharedValue(on ? 1 : 0);
  const scale = useSharedValue(1);
  useEffect(() => {
    litOpacity.value = withTiming(on ? 1 : 0, { duration: 200 });
  }, [on, litOpacity]);
  const scaleStyle = useAnimatedStyle(() => ({ transform: [{ scale: scale.value }] }));

  function onLayout(e: LayoutChangeEvent) {
    // The fill and rim sit inside the pill's border, so size them to the box
    // inside it rather than the pill's outer size.
    const { width, height } = e.nativeEvent.layout;
    setSize({ width: Math.max(0, width - 2 * SEGMENT_BORDER), height: Math.max(0, height - 2 * SEGMENT_BORDER) });
  }

  return (
    <Pressable
      onPress={onPress}
      onPressIn={() => {
        scale.value = withTiming(0.96, { duration: 80 });
      }}
      onPressOut={() => {
        scale.value = withSpring(1, prism.press.spring);
      }}
      onLayout={onLayout}
      accessibilityRole="tab"
      accessibilityState={{ selected: on }}
      style={styles.segment}>
      <Animated.View style={[styles.pill, scaleStyle]}>
        <LitPillFill width={size.width} height={size.height} opacity={litOpacity} />
        {size.height > 0 && <LitPillRim radius={size.height / 2} opacity={litOpacity} />}
        <Text numberOfLines={1} style={[styles.pillText, { color: on ? prism.tray.lit.label : PILL_ICON_OFF }]}>
          {label}
        </Text>
      </Animated.View>
    </Pressable>
  );
}

/**
 * A labelled segmented control on one line, with the selected option's
 * description under it: a `PillTrayShell` whose pills split the row evenly
 * and cross-fade a deep blue lit fill when selected, the same look as the
 * Home sort row.
 */
export function Segmented<T extends string>({ label, options, value, onChange }: Props<T>) {
  const index = Math.max(0, options.findIndex((o) => o.value === value));

  return (
    <View style={styles.section}>
      <View style={styles.row}>
        <Text style={styles.label}>{label}</Text>
        <View style={styles.trayWrap} accessibilityRole="tablist">
          <PillTrayShell style={styles.tray}>
            {options.map((o) => (
              <SegmentPill
                key={o.value}
                on={o.value === value}
                label={o.label}
                onPress={() => {
                  if (o.value !== value) onChange(o.value);
                }}
              />
            ))}
          </PillTrayShell>
        </View>
      </View>
      <Text style={styles.description}>{options[index]?.description}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  section: { gap: Spacing.sm },
  row: { flexDirection: 'row', alignItems: 'center', gap: Spacing.md },
  label: { width: 84, fontSize: 15, color: tide.text, fontFamily: fonts.uiMedium, fontWeight: '500' },
  trayWrap: { flex: 1 },
  tray: { flexDirection: 'row', gap: Spacing.sm },
  segment: { flex: 1 },
  pill: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    height: PILL_H,
    // Clips the lit fill and LitPillRim's straight top highlight to the
    // rounded shape, like the sort row's pill.
    borderRadius: PILL_H / 2,
    overflow: 'hidden',
    borderWidth: SEGMENT_BORDER,
    borderColor: 'rgba(255,255,255,0.05)',
    backgroundColor: prism.tray.pillFill,
  },
  pillText: { fontSize: PILL_LABEL_SIZE, fontWeight: '600', fontFamily: fonts.ui },
  description: { fontSize: 13, lineHeight: 18, color: tide.textDim, fontFamily: fonts.ui },
});
