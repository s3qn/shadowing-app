import { useEffect, useState } from 'react';
import { type LayoutChangeEvent, StyleSheet, Text, View } from 'react-native';
import Animated, {
  Easing,
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
  withTiming,
} from 'react-native-reanimated';

import { PressScale } from '@/components/press-scale';
import { fonts } from '@/constants/fonts';
import { Radius, Spacing, tide } from '@/constants/theme';

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

const INSET = 3;

/**
 * A labelled segmented control on one line, with the selected option's
 * description under it. The selection pill slides between segments.
 */
export function Segmented<T extends string>({ label, options, value, onChange }: Props<T>) {
  const reducedMotion = useReducedMotion();
  const index = Math.max(0, options.findIndex((o) => o.value === value));
  const [trackWidth, setTrackWidth] = useState(0);
  const segmentWidth = trackWidth > 0 ? (trackWidth - INSET * 2) / options.length : 0;
  const pos = useSharedValue(index);

  useEffect(() => {
    pos.value = reducedMotion
      ? index
      : withTiming(index, { duration: 220, easing: Easing.out(Easing.cubic) });
  }, [index, reducedMotion, pos]);

  const pillStyle = useAnimatedStyle(() => ({
    transform: [{ translateX: pos.value * segmentWidth }],
  }));

  function onTrackLayout(e: LayoutChangeEvent) {
    setTrackWidth(e.nativeEvent.layout.width);
  }

  return (
    <View style={styles.section}>
      <View style={styles.row}>
        <Text style={styles.label}>{label}</Text>
        <View style={styles.track} onLayout={onTrackLayout} accessibilityRole="tablist">
          {segmentWidth > 0 ? (
            <Animated.View style={[styles.pill, { width: segmentWidth }, pillStyle]} />
          ) : null}
          {options.map((o) => {
            const on = o.value === value;
            return (
              <PressScale
                key={o.value}
                onPress={() => {
                  if (!on) onChange(o.value);
                }}
                accessibilityRole="tab"
                accessibilityState={{ selected: on }}
                style={styles.segment}>
                <Text
                  numberOfLines={1}
                  style={[styles.segmentText, { color: on ? tide.sky[0] : tide.text }]}>
                  {o.label}
                </Text>
              </PressScale>
            );
          })}
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
  track: {
    flex: 1,
    height: 40,
    flexDirection: 'row',
    padding: INSET,
    borderRadius: Radius.pill,
    backgroundColor: 'rgba(255,255,255,0.08)',
  },
  pill: {
    position: 'absolute',
    top: INSET,
    bottom: INSET,
    left: INSET,
    borderRadius: Radius.pill,
    backgroundColor: tide.lang.ja,
  },
  segment: { flex: 1, alignItems: 'center', justifyContent: 'center', paddingHorizontal: Spacing.sm },
  segmentText: { fontSize: 14, fontFamily: fonts.uiMedium, fontWeight: '500' },
  description: { fontSize: 13, lineHeight: 18, color: tide.textDim, fontFamily: fonts.ui },
});
