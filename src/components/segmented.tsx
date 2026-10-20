import { useCallback, useEffect, useRef, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import Animated, { type SharedValue, useAnimatedStyle, useSharedValue, withSpring, withTiming } from 'react-native-reanimated';

import { fonts } from '@/constants/fonts';
import { Spacing, prism, tide } from '@/constants/theme';
import {
  PILL_CHROME_BORDER,
  PILL_H,
  PILL_LABEL_SIZE,
  type PillItemBox,
  PillTrayShell,
  SlidingLitPill,
  usePillChromeStyle,
  usePillLabelStyle,
  useSlidingPill,
} from '@/components/prism/pill-tray';
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
/** The pill is 36 pt tall; 4 pt above and below makes the 44 pt touch target. The sides stay inside the 8 pt gap between pills. */
const TAB_SLOP = { top: 4, bottom: 4, left: 2, right: 2 } as const;

/**
 * One option in a `Segmented` row. The lit fill is the row's one
 * `SlidingLitPill`, as on the Home sort row; this pill's own chip and label
 * colour follow how much of it sits under this option. Sized with `flex: 1`
 * so it shares the row evenly with its siblings, unlike the sort row's
 * pills, which hug their own label.
 */
function SegmentPill({
  on,
  label,
  onPress,
  fit,
  onLayoutX,
  box,
  pillX,
  pillW,
}: {
  on: boolean;
  label: string;
  onPress: () => void;
  fit?: boolean;
  onLayoutX: (x: number, w: number) => void;
  box: PillItemBox | undefined;
  pillX: SharedValue<number>;
  pillW: SharedValue<number>;
}) {
  const scale = useSharedValue(1);
  const scaleStyle = useAnimatedStyle(() => ({ transform: [{ scale: scale.value }] }));
  const cover = { translateX: pillX, width: pillW, item: box };
  const chromeStyle = usePillChromeStyle(cover);
  const labelStyle = usePillLabelStyle(cover);

  return (
    <Pressable
      onPress={onPress}
      onPressIn={() => {
        scale.value = withTiming(0.96, { duration: 80 });
      }}
      onPressOut={() => {
        scale.value = withSpring(1, prism.press.spring);
      }}
      hitSlop={TAB_SLOP}
      accessibilityRole="tab"
      accessibilityState={{ selected: on }}
      onLayout={(e) => onLayoutX(e.nativeEvent.layout.x, e.nativeEvent.layout.width)}
      style={fit ? styles.segmentFit : styles.segment}>
      <Animated.View style={[styles.pill, fit && styles.pillFit, chromeStyle, scaleStyle]}>
        <Animated.Text numberOfLines={1} style={[styles.pillText, labelStyle]}>
          {label}
        </Animated.Text>
      </Animated.View>
    </Pressable>
  );
}

/**
 * A labelled segmented control on one line, with the selected option's
 * description under it: a `PillTrayShell` whose pills split the row evenly,
 * with one deep blue lit pill that slides to the selected option, the same
 * look as the Home sort row.
 */
export function Segmented<T extends string>({ label, options, value, onChange, scrollable }: Props<T>) {
  const index = Math.max(0, options.findIndex((o) => o.value === value));
  const dir = useDir();
  const scroller = useRef<ScrollView>(null);
  const spans = useRef<Record<string, { x: number; w: number }>>({});
  const viewW = useRef(0);
  // Each option's box in the row, for the sliding lit pill.
  const boxesRef = useRef<PillItemBox[]>([]);
  const [boxes, setBoxes] = useState<PillItemBox[]>([]);
  const [fillWidth, setFillWidth] = useState(0);
  const { translateX, width } = useSlidingPill(boxes[index]);
  const count = options.length;
  const measured = useCallback(
    (i: number, x: number, w: number) => {
      const cur = boxesRef.current[i];
      if (cur && cur.x === x && cur.width === w) return;
      boxesRef.current[i] = { x, width: w };
      setFillWidth((widest) => Math.max(widest, w));
      if (boxesRef.current.slice(0, count).filter((b) => b).length === count) setBoxes(boxesRef.current.slice(0, count));
    },
    [count],
  );

  function reveal(animated: boolean) {
    const span = spans.current[value];
    if (!scrollable || !span || !(viewW.current > 0)) return;
    scroller.current?.scrollTo({ x: Math.max(0, span.x + span.w / 2 - viewW.current / 2), animated });
  }
  useEffect(() => reveal(true));

  const pills = options.map((o, i) => (
    <SegmentPill
      key={o.value}
      on={o.value === value}
      label={o.label}
      fit={scrollable}
      box={boxes[i]}
      pillX={translateX}
      pillW={width}
      onLayoutX={(x, w) => {
        measured(i, x, w);
        if (!scrollable) return;
        spans.current[o.value] = { x, w };
        if (o.value === value) reveal(false);
      }}
      onPress={() => {
        if (o.value !== value) onChange(o.value);
      }}
    />
  ));
  const description = options[index]?.description;
  // Rendered first in the row so its x counts from the row's own edge.
  const slider = <SlidingLitPill translateX={translateX} width={width} fillWidth={fillWidth} />;

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
                {slider}
                {pills}
              </ScrollView>
            </PillTrayShell>
          ) : (
            <PillTrayShell>
              <View style={[styles.tray, dir.row]}>
                {slider}
                {pills}
              </View>
            </PillTrayShell>
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
  // The row inside the capsule, unpadded, so the slider and each option's onLayout share one origin.
  tray: { flex: 1, flexDirection: 'row', gap: Spacing.sm },
  scrollTray: { overflow: 'hidden' },
  scrollContent: { flexDirection: 'row', gap: Spacing.sm },
  segment: { flex: 1 },
  segmentFit: { flexGrow: 0, flexShrink: 0, flexBasis: 'auto' },
  // No `flex: 1`: in the Pressable's column a zero flex basis collapsed the pill to its label's 17 pt line on the web.
  pill: {
    alignItems: 'center',
    justifyContent: 'center',
    height: PILL_H,
    borderRadius: PILL_H / 2,
    borderWidth: SEGMENT_BORDER,
    borderColor: PILL_CHROME_BORDER,
  },
  pillFit: { flexGrow: 0, flexShrink: 0, flexBasis: 'auto', paddingHorizontal: Spacing.md },
  pillText: { fontSize: PILL_LABEL_SIZE, fontWeight: '600', fontFamily: fonts.ui },
  description: { fontSize: 13, lineHeight: 18, color: tide.textDim, fontFamily: fonts.ui },
});
