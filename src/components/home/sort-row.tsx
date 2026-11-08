import { useCallback, useRef, useState } from 'react';
import { StyleSheet, View, type LayoutChangeEvent } from 'react-native';

import { PillTrayItem, PillTrayShell, SlidingLitPill, useSlidingPill } from '@/components/prism/pill-tray';
import { Spacing } from '@/constants/theme';
import { useDir } from '@/lib/i18n';
import { hapticSelection } from '@/lib/haptics';

export const SORTS = ['newest', 'least'] as const;
export type Sort = (typeof SORTS)[number];

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
          <PillTrayItem
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
  // pill-tray-tab-bar: sort row end
});
