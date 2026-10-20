import { type ReactNode, useCallback, useRef, useState } from 'react';
import { type LayoutChangeEvent, Pressable, StyleSheet, View } from 'react-native';
import { BlurView } from 'expo-blur';
import Animated, { type SharedValue, useAnimatedStyle, useSharedValue, withSpring, withTiming } from 'react-native-reanimated';

import { PILL_H, type PillItemBox, SlidingLitPill, usePillLabelStyle, useSlidingPill } from '@/components/prism/pill-tray';
import { SLOTS, type Slot } from '@/constants/cosmetics';
import { fonts } from '@/constants/fonts';
import { Radius, prism, tide } from '@/constants/theme';
import { useDir, useT } from '@/lib/i18n';

const ACTIVE_INK = '#0B0D16';
const TRAY_BLUR = 24;
const TRAY_INSET = 4;
const LABEL_SIZE = 14;
/** The label turns from pale to dark ink while the pill covers 35 to 65% of it. */
const INK_SPAN = [0.35, 0.65] as const;

type SlotPillProps = {
  label: string;
  onPress: () => void;
  onLayout: (e: LayoutChangeEvent) => void;
  box: PillItemBox | undefined;
  pillX: SharedValue<number>;
  pillW: SharedValue<number>;
};

/**
 * One slot tab. The light pill behind it is the row's one `SlidingLitPill`;
 * the label's ink follows how much of that pill sits under it, so a label is
 * never dark on the bare tray or pale on the light pill.
 */
function SlotPill({ label, onPress, onLayout, box, pillX, pillW }: SlotPillProps) {
  const scale = useSharedValue(1);
  const inkStyle = usePillLabelStyle({ translateX: pillX, width: pillW, item: box }, tide.textDim, ACTIVE_INK, INK_SPAN);
  const scaleStyle = useAnimatedStyle(() => ({ transform: [{ scale: scale.value }] }));
  return (
    <Pressable
      hitSlop={{ top: 6, bottom: 6, left: 4, right: 4 }}
      style={styles.slot}
      onLayout={onLayout}
      onPress={onPress}
      onPressIn={() => {
        scale.value = withTiming(0.96, { duration: 80 });
      }}
      onPressOut={() => {
        scale.value = withSpring(1, prism.press.spring);
      }}>
      <Animated.View style={[styles.pill, scaleStyle]}>
        <Animated.Text style={[styles.text, inkStyle]}>{label}</Animated.Text>
      </Animated.View>
    </Pressable>
  );
}

export type SlotTabsProps = { slot: Slot; onChange: (slot: Slot) => void };

/** The four slot tabs on a local blur-24 glass tray, with one light pill that slides to the chosen slot. */
export function SlotTabs({ slot, onChange }: SlotTabsProps) {
  const { t } = useT();
  const dir = useDir();
  const boxesRef = useRef<PillItemBox[]>([]);
  const [boxes, setBoxes] = useState<PillItemBox[]>([]);
  const [fillWidth, setFillWidth] = useState(0);
  const { translateX, width } = useSlidingPill(boxes[SLOTS.indexOf(slot)]);
  const measured = useCallback((i: number, e: LayoutChangeEvent) => {
    const { x, width: w } = e.nativeEvent.layout;
    boxesRef.current[i] = { x, width: w };
    setFillWidth((widest) => Math.max(widest, w));
    if (boxesRef.current.filter((b) => b).length === SLOTS.length) setBoxes([...boxesRef.current]);
  }, []);
  return (
    <GlassTray>
      <View style={[styles.row, dir.row]}>
        <SlidingLitPill translateX={translateX} width={width} fillWidth={fillWidth} look="light" />
        {SLOTS.map((s, i) => (
          <SlotPill
            key={s}
            label={t(`wardrobe.slot.${s}` as const)}
            box={boxes[i]}
            pillX={translateX}
            pillW={width}
            onLayout={(e) => measured(i, e)}
            onPress={() => onChange(s)}
          />
        ))}
      </View>
    </GlassTray>
  );
}

function GlassTray({ children }: { children: ReactNode }) {
  return (
    <View style={styles.tray}>
      <BlurView intensity={TRAY_BLUR} tint={prism.blur.tint} style={StyleSheet.absoluteFill} />
      <View style={styles.trayHighlight} />
      {children}
    </View>
  );
}

const styles = StyleSheet.create({
  tray: {
    position: 'relative',
    alignSelf: 'stretch',
    borderRadius: Radius.pill,
    overflow: 'hidden',
    padding: TRAY_INSET,
    borderWidth: 1,
    borderColor: prism.tray.rim,
  },
  trayHighlight: { position: 'absolute', top: 0, left: 0, right: 0, height: 1, backgroundColor: 'rgba(255,255,255,0.16)' },
  slot: { flex: 1 },
  row: { flexDirection: 'row', alignItems: 'center' },
  pill: {
    alignItems: 'center',
    justifyContent: 'center',
    height: PILL_H,
    borderRadius: PILL_H / 2,
  },
  // One weight for every tab: a weight that changes with the selection changes the label's width.
  text: { fontSize: LABEL_SIZE, fontFamily: fonts.ui, fontWeight: '600' },
});
