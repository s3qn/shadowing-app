import { useEffect, useRef } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import Animated, { useAnimatedStyle, useSharedValue, withSpring, withTiming } from 'react-native-reanimated';

import { fonts } from '@/constants/fonts';
import { Spacing, prism, tide } from '@/constants/theme';
import { LitPillCover, LitPillRim, PILL_H, PILL_ICON_OFF, PILL_LABEL_SIZE, PillTrayShell } from '@/components/prism/pill-tray';
import { useDir } from '@/lib/i18n';

export type SegmentOption<T extends string> = {
  value: T;
  label: string;
  /** One dim line under the control, shown while this option is selected. */
  description?: string;
};

type Props<T extends string> = {
  /** Left-hand label. Omit it when the row sits under its own heading. */
  label?: string;
  options: readonly SegmentOption<T>[];
  value: T;
  onChange: (next: T) => void;
  /**
   * Pills hug their labels and the row scrolls sideways, the selected pill
   * scrolled into view. For option sets too long to share one line.
   */
  scrollable?: boolean;
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
function SegmentPill({
  on,
  label,
  onPress,
  fit,
  onLayoutX,
}: {
  on: boolean;
  label: string;
  onPress: () => void;
  fit?: boolean;
  onLayoutX?: (x: number, w: number) => void;
}) {
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
      onLayout={onLayoutX ? (e) => onLayoutX(e.nativeEvent.layout.x, e.nativeEvent.layout.width) : undefined}
      style={fit ? undefined : styles.segment}>
      <Animated.View style={[styles.pill, fit && styles.pillFit, scaleStyle]}>
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
export function Segmented<T extends string>({ label, options, value, onChange, scrollable }: Props<T>) {
  const index = Math.max(0, options.findIndex((o) => o.value === value));
  const dir = useDir();
  const scroller = useRef<ScrollView>(null);
  const spans = useRef<Record<string, { x: number; w: number }>>({});
  const viewW = useRef(0);

  function reveal(animated: boolean) {
    const span = spans.current[value];
    if (!scrollable || !span || !(viewW.current > 0)) return;
    scroller.current?.scrollTo({ x: Math.max(0, span.x + span.w / 2 - viewW.current / 2), animated });
  }
  useEffect(() => reveal(true));

  const pills = options.map((o) => (
    <SegmentPill
      key={o.value}
      on={o.value === value}
      label={o.label}
      fit={scrollable}
      onLayoutX={
        scrollable
          ? (x, w) => {
              spans.current[o.value] = { x, w };
              if (o.value === value) reveal(false);
            }
          : undefined
      }
      onPress={() => {
        if (o.value !== value) onChange(o.value);
      }}
    />
  ));
  const description = options[index]?.description;

  return (
    <View style={styles.section}>
      <View style={[styles.row, dir.row]}>
        {label ? <Text style={[styles.label, dir.text]}>{label}</Text> : null}
        <View style={styles.trayWrap} accessibilityRole="tablist">
          {scrollable ? (
            <PillTrayShell style={styles.scrollTray}>
              <ScrollView
                ref={scroller}
                horizontal
                showsHorizontalScrollIndicator={false}
                onLayout={(e) => {
                  viewW.current = e.nativeEvent.layout.width;
                  reveal(false);
                }}
                contentContainerStyle={[styles.scrollContent, dir.row]}>
                {pills}
              </ScrollView>
            </PillTrayShell>
          ) : (
            <PillTrayShell style={[styles.tray, dir.row]}>{pills}</PillTrayShell>
          )}
        </View>
      </View>
      {description ? <Text style={[styles.description, dir.text]}>{description}</Text> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  section: { gap: Spacing.sm },
  row: { flexDirection: 'row', alignItems: 'center', gap: Spacing.md },
  label: { width: 84, fontSize: 15, color: tide.text, fontFamily: fonts.uiMedium, fontWeight: '500' },
  trayWrap: { flex: 1 },
  tray: { flexDirection: 'row', gap: Spacing.sm },
  scrollTray: { overflow: 'hidden' },
  scrollContent: { flexDirection: 'row', gap: Spacing.sm },
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
  pillFit: { flex: 0, paddingHorizontal: Spacing.md },
  pillText: { fontSize: PILL_LABEL_SIZE, fontWeight: '600', fontFamily: fonts.ui },
  description: { fontSize: 13, lineHeight: 18, color: tide.textDim, fontFamily: fonts.ui },
});
