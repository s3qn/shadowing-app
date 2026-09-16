import { memo, type ReactNode, useEffect, useRef, useState } from 'react';
import { type LayoutChangeEvent, StyleSheet, Text, View } from 'react-native';
import Animated, {
  type EntryAnimationsValues,
  type ExitAnimationsValues,
  FadeIn,
  FadeOut,
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
  withSequence,
  withSpring,
  withTiming,
} from 'react-native-reanimated';

import { PressScale } from '@/components/press-scale';
import { fonts } from '@/constants/fonts';
import { tide } from '@/constants/theme';

export type ToolbarItem = {
  key: string;
  icon: ReactNode;
  label: string;
  value?: string;
  active?: boolean;
  onPress: () => void;
  /** The tile's box in the row, for a popover anchored to it. */
  onLayout?: (e: LayoutChangeEvent) => void;
};

/** How long the old value takes to clip away and the new one to roll in. */
const VALUE_ROLL_MS = 200;
/** How far the value text travels while rolling, in px. */
const VALUE_ROLL_DIST = 14;
/** The nudge and settle for a tile icon's one-shot reaction to a value
 * change: quick out, spring back. */
const ICON_SPRING = { damping: 14, stiffness: 260, mass: 0.6 } as const;
/** How far the speed gauge's needle nudges toward the new value, and how
 * long the repeat arrows take for their one full spin. */
const SPEED_NUDGE_DEG = 16;
const REPEAT_SPIN_MS = 380;

/** The new value rolls up from just below its place. */
function valueRollIn(_values: EntryAnimationsValues) {
  'worklet';
  return {
    initialValues: { transform: [{ translateY: VALUE_ROLL_DIST }] },
    animations: { transform: [{ translateY: withTiming(0, { duration: VALUE_ROLL_MS }) }] },
  };
}

/** The old value clips away upward. */
function valueRollOut(_values: ExitAnimationsValues) {
  'worklet';
  return {
    initialValues: { transform: [{ translateY: 0 }] },
    animations: { transform: [{ translateY: withTiming(-VALUE_ROLL_DIST, { duration: VALUE_ROLL_MS }) }] },
  };
}

/** The tile's value line: a fixed-height, clipped window that the old text
 * rolls out of and the new text rolls into. Reduced motion crossfades
 * instead of rolling. */
function ValueRoll({ value, reducedMotion }: { value: string; reducedMotion: boolean }) {
  // The first value is simply there: rolling it in on mount would play under
  // the card morph's cover, or during the player's content reveal.
  const [first] = useState(value);
  const [changed, setChanged] = useState(false);
  if (!changed && value !== first) setChanged(true);
  return (
    <View style={styles.valueClip}>
      <Animated.Text
        key={value}
        style={[styles.value, styles.valueLayer]}
        entering={!changed ? undefined : reducedMotion ? FadeIn.duration(150) : valueRollIn}
        exiting={reducedMotion ? FadeOut.duration(150) : valueRollOut}
      >
        {value}
      </Animated.Text>
    </View>
  );
}

/**
 * One toolbar tile. Watches its own value for changes: a real change (not
 * the first render) gives the icon its one-shot reaction, kind by kind.
 * Reduced motion skips the icon reaction entirely; the value line still
 * updates, just by crossfade instead of rolling (handled in ValueRoll).
 */
function Tile({ item, reducedMotion }: { item: ToolbarItem; reducedMotion: boolean }) {
  const rotate = useSharedValue(0);
  const scaleY = useSharedValue(1);
  const prevValue = useRef(item.value);

  useEffect(() => {
    const prev = prevValue.current;
    prevValue.current = item.value;
    if (reducedMotion || prev === undefined || prev === item.value) return;
    if (item.key === 'speed') {
      const from = Number.parseFloat(prev);
      const to = Number.parseFloat(item.value ?? '');
      const dir = Number.isFinite(from) && Number.isFinite(to) && to !== from ? Math.sign(to - from) : 1;
      rotate.value = withSequence(
        withTiming(dir * SPEED_NUDGE_DEG, { duration: 140 }),
        withSpring(0, ICON_SPRING),
      );
    } else if (item.key === 'blind') {
      scaleY.value = withSequence(withTiming(0.1, { duration: 90 }), withSpring(1, ICON_SPRING));
    } else if (item.key === 'repeat') {
      // Always land on a whole turn, never on whatever angle a drag caught
      // the icon at. If it's already mid-spin toward the next turn, this
      // lands on that same target, so rapid changes stay one smooth spin.
      const target = (Math.floor(rotate.value / 360) + 1) * 360;
      rotate.value = withTiming(target, { duration: REPEAT_SPIN_MS }, (finished) => {
        if (finished && Number.isFinite(rotate.value)) {
          rotate.value = 0;
        }
      });
    }
  }, [item.key, item.value, reducedMotion, rotate, scaleY]);

  const iconStyle = useAnimatedStyle(() => ({
    transform: [{ rotate: `${rotate.value}deg` }, { scaleY: scaleY.value }],
  }));

  return (
    <PressScale
      onPress={item.onPress}
      onLayout={item.onLayout}
      accessibilityRole="button"
      accessibilityLabel={item.value ? `${item.label}, ${item.value}` : item.label}
      style={[styles.item, item.active && styles.itemActive]}>
      <Animated.View style={iconStyle}>{item.icon}</Animated.View>
      <Text style={[styles.label, item.active && styles.active]}>{item.label}</Text>
      {item.value ? <ValueRoll value={item.value} reducedMotion={reducedMotion} /> : null}
    </PressScale>
  );
}

/**
 * The row of icon-plus-label buttons above the dock: Speed, Repeat, Reading,
 * Blind. Each button opens the sheet or popover for its setting; the
 * label under the icon stays put and the value line rolls to whatever was
 * last set.
 */
export const Toolbar = memo(function Toolbar({ items }: { items: ToolbarItem[] }) {
  const reducedMotion = useReducedMotion();
  return (
    <View style={styles.row}>
      {items.map((item) => (
        <Tile key={item.key} item={item} reducedMotion={reducedMotion} />
      ))}
    </View>
  );
});

const styles = StyleSheet.create({
  row: { flexDirection: 'row', justifyContent: 'space-around', paddingTop: 10, paddingBottom: 4, paddingHorizontal: 6, gap: 6 },
  item: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 3,
    minHeight: 54,
    paddingVertical: 8,
    borderRadius: 12,
    backgroundColor: 'rgba(255,255,255,0.05)',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.08)',
  },
  itemActive: { backgroundColor: 'rgba(255,158,128,0.14)', borderColor: tide.lang.ja },
  label: { fontFamily: fonts.uiMedium, fontWeight: '500', fontSize: 11, color: tide.textDim },
  value: { fontFamily: fonts.ui, fontSize: 11, color: tide.text },
  valueClip: { height: 14, width: '100%', overflow: 'hidden', alignItems: 'center' },
  valueLayer: { position: 'absolute', left: 0, right: 0, textAlign: 'center' },
  active: { color: tide.lang.ja },
});
