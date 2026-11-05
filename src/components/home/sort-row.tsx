import { useCallback, useRef, useState } from 'react';
import { Pressable, StyleSheet, View, type LayoutChangeEvent } from 'react-native';
import Animated, { useAnimatedStyle, useSharedValue, withSpring, withTiming, type SharedValue } from 'react-native-reanimated';

import {
  PILL_CHROME_BORDER,
  PILL_H,
  PILL_LABEL_SIZE,
  PILL_PAD_X,
  type PillItemBox,
  PillTrayShell,
  SlidingLitPill,
  usePillChromeStyle,
  usePillLabelStyle,
  useSlidingPill,
} from '@/components/prism/pill-tray';
import { fonts } from '@/constants/fonts';
import { prism, Spacing } from '@/constants/theme';
import { useDir } from '@/lib/i18n';
import { hapticSelection } from '@/lib/haptics';

export const SORTS = ['newest', 'least'] as const;
export type Sort = (typeof SORTS)[number];

// pill-tray-tab-bar: sort row start
const SORT_PILL_BORDER = 1;
/**
 * One sort option: a pill that hugs its label with a plain press scale. The
 * active option shows only the sliding lit pill underneath; an inactive one
 * draws its own faint chip. The border width is constant so the pill never
 * changes size when it turns on. The chip and the label colour follow how
 * much of the sliding pill covers this option.
 */
function SortPill({
  label,
  onPress,
  onLayout,
  box,
  pillX,
  pillW,
}: {
  label: string;
  onPress: () => void;
  onLayout: (e: LayoutChangeEvent) => void;
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
      onLayout={onLayout}
      onPress={onPress}
      onPressIn={() => {
        scale.value = withTiming(0.96, { duration: 80 });
      }}
      onPressOut={() => {
        scale.value = withSpring(1, prism.press.spring);
      }}>
      <Animated.View style={[styles.pill, chromeStyle, scaleStyle]}>
        <Animated.Text style={[styles.pillText, labelStyle]}>{label}</Animated.Text>
      </Animated.View>
    </Pressable>
  );
}

/**
 * The Home sort row: one lit pill slides between the options, like the tab
 * bar. The row inside the tray shares a coordinate space with each option's
 * onLayout, so the slider origin and the measured x agree.
 */
export function SortRow({ sort, onSort, labels }: { sort: Sort; onSort: (s: Sort) => void; labels: Record<Sort, string> }) {
  const dir = useDir();
  const layoutsRef = useRef<Array<{ x: number; width: number }>>([]);
  const [layouts, setLayouts] = useState<Array<{ x: number; width: number }>>([]);
  // Widest option measured so far; the slider's canvas only grows (see PillTabBar).
  const [fillWidth, setFillWidth] = useState(0);
  const { translateX, width } = useSlidingPill(layouts[SORTS.indexOf(sort)]);
  const measured = useCallback((i: number, e: LayoutChangeEvent) => {
    const { x, width: w } = e.nativeEvent.layout;
    layoutsRef.current[i] = { x, width: w };
    setFillWidth((widest) => Math.max(widest, w));
    if (layoutsRef.current.filter((l) => l).length === SORTS.length) setLayouts([...layoutsRef.current]);
  }, []);
  return (
    <PillTrayShell wrapStyle={[styles.sortRowWrap, dir.rtl && styles.sortRowWrapRtl]}>
      <View style={[styles.sortRow, dir.row]}>
        <SlidingLitPill translateX={translateX} width={width} fillWidth={fillWidth} />
        {SORTS.map((s, i) => (
          <SortPill
            key={s}
            label={labels[s]}
            box={layouts[i]}
            pillX={translateX}
            pillW={width}
            onLayout={(e) => measured(i, e)}
            onPress={() => {
              if (s !== sort) void hapticSelection();
              onSort(s);
            }}
          />
        ))}
      </View>
    </PillTrayShell>
  );
}
// pill-tray-tab-bar: sort row end

const styles = StyleSheet.create({
  sortRow: { flexDirection: 'row', gap: Spacing.sm },
  // pill-tray-tab-bar: sort row start
  // Hugs the two pills instead of stretching full width under headerFixed's
  // default alignItems: 'stretch', which also keeps the offset pane a small
  // corner peek instead of a full-width strip (the pane sizes off this wrap).
  sortRowWrap: { alignSelf: 'flex-start' },
  // Hebrew reads from the right, so the tray hugs the opposite edge.
  sortRowWrapRtl: { alignSelf: 'flex-end' },
  pill: {
    alignItems: 'center',
    justifyContent: 'center',
    height: PILL_H,
    borderRadius: PILL_H / 2,
    borderWidth: SORT_PILL_BORDER,
    borderColor: PILL_CHROME_BORDER,
    paddingHorizontal: PILL_PAD_X,
  },
  pillText: { fontSize: PILL_LABEL_SIZE, fontWeight: '600', fontFamily: fonts.ui },
  // pill-tray-tab-bar: sort row end
});
