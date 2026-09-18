import { useEffect } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import Animated, { useAnimatedStyle, useSharedValue, withSpring, withTiming } from 'react-native-reanimated';

import { fonts } from '@/constants/fonts';
import { Spacing, prism, tide } from '@/constants/theme';
import { LitPillCover, LitPillRim, PILL_H, PILL_ICON_OFF, PILL_LABEL_SIZE, PillTrayShell } from '@/components/prism/pill-tray';
import { useDir } from '@/lib/i18n';

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
/** The box inside a segment's border, which the lit fill and rim fill. */
const SEGMENT_INNER_H = PILL_H - 2 * SEGMENT_BORDER;

/**
 * One option in a `Segmented` row: a pill that crossfades its own lit fill,
 * the same chrome `SortPill` draws for the Home sort row (`LitPillCover` plus
 * `LitPillRim`, both taking the pill's real size from their own absolute
 * fill). Sized with `flex: 1` so it shares the row evenly with its siblings,
 * unlike the sort row's pills, which hug their own label.
 */
function SegmentPill({ on, label, onPress }: { on: boolean; label: string; onPress: () => void }) {
  const litOpacity = useSharedValue(on ? 1 : 0);
  const scale = useSharedValue(1);
  useEffect(() => {
    litOpacity.value = withTiming(on ? 1 : 0, { duration: 200 });
  }, [on, litOpacity]);
  const scaleStyle = useAnimatedStyle(() => ({ transform: [{ scale: scale.value }] }));

  return (
    <Pressable
      onPress={onPress}
      onPressIn={() => {
        scale.value = withTiming(0.96, { duration: 80 });
      }}
      onPressOut={() => {
        scale.value = withSpring(1, prism.press.spring);
      }}
      accessibilityRole="tab"
      accessibilityState={{ selected: on }}
      style={styles.segment}>
      <Animated.View style={[styles.pill, scaleStyle]}>
        <LitPillCover height={SEGMENT_INNER_H} opacity={litOpacity} />
        <LitPillRim radius={SEGMENT_INNER_H / 2} opacity={litOpacity} />
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
  const dir = useDir();

  return (
    <View style={styles.section}>
      <View style={[styles.row, dir.row]}>
        <Text style={[styles.label, dir.text]}>{label}</Text>
        <View style={styles.trayWrap} accessibilityRole="tablist">
          <PillTrayShell style={[styles.tray, dir.row]}>
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
      <Text style={[styles.description, dir.text]}>{options[index]?.description}</Text>
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
