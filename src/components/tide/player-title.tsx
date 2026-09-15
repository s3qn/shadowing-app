import { useEffect, useRef, useState } from 'react';
import { LayoutChangeEvent, StyleSheet, Text, View } from 'react-native';
import Animated, { runOnJS, useAnimatedStyle, useReducedMotion, useSharedValue, withTiming } from 'react-native-reanimated';

import { fonts } from '@/constants/fonts';
import { tide } from '@/constants/theme';

type Props = {
  title: string;
  lineIndex: number;
  lineCount: number;
};

const ROLL_HEIGHT = 14;
// Fallback per-digit width, used only until the real width of a number has
// been measured. Never the final word: see widthFor below.
const DIGIT_WIDTH = 8;
const MIN_NUMBER_WIDTH = 16;
// Equal gap on both sides of the number box, so "LINE" and "OF M" sit the
// same distance from the number regardless of its digit count.
const NUMBER_GAP = 4;

/** The player's header title: the island name over "Line X of Y". */
export function PlayerTitle({ title, lineIndex, lineCount }: Props) {
  const reducedMotion = useReducedMotion();
  const number = lineIndex + 1;

  const prevIndex = useRef(lineIndex);
  const prevNumber = useRef(number);
  const [outNumber, setOutNumber] = useState<number | null>(null);
  const anim = useSharedValue(1);
  const dir = useSharedValue<1 | -1>(1);

  // Real measured widths per number value, filled in by the invisible
  // measurement copies below. Cached across renders so a number we've
  // already seen (e.g. rolling back to it) doesn't flash the estimate again.
  const widthCache = useRef<Map<number, number>>(new Map());
  const [, bumpMeasured] = useState(0);

  const measureWidth = (value: number) => (event: LayoutChangeEvent) => {
    const width = Math.ceil(event.nativeEvent.layout.width);
    if (widthCache.current.get(value) !== width) {
      widthCache.current.set(value, width);
      bumpMeasured((n) => n + 1);
    }
  };

  const widthFor = (value: number) =>
    widthCache.current.get(value) ?? Math.max(MIN_NUMBER_WIDTH, String(value).length * DIGIT_WIDTH);

  useEffect(() => {
    if (lineIndex === prevIndex.current) return;
    dir.value = lineIndex > prevIndex.current ? 1 : -1;
    setOutNumber(prevNumber.current);
    anim.value = 0;
    anim.value = withTiming(1, { duration: reducedMotion ? 160 : 220 }, (finished) => {
      if (finished) runOnJS(setOutNumber)(null);
    });
    prevIndex.current = lineIndex;
    prevNumber.current = number;
  }, [lineIndex, number, reducedMotion, anim, dir]);

  // Sized to whichever of the outgoing and incoming numbers is widest, so a
  // roll from a 2-digit to a 3-digit line (or back) never clips either one.
  // Both layers are then centered within this box (see numberLayer), so
  // whichever one is narrower sits with equal space on either side of it
  // instead of hugging the left edge.
  const clipWidth = Math.max(widthFor(number), outNumber !== null ? widthFor(outNumber) : 0);

  const outStyle = useAnimatedStyle(() => ({
    opacity: 1 - anim.value,
    transform: [{ translateY: reducedMotion ? 0 : -dir.value * anim.value * ROLL_HEIGHT }],
  }));
  const inStyle = useAnimatedStyle(() => ({
    opacity: anim.value,
    transform: [{ translateY: reducedMotion ? 0 : dir.value * (1 - anim.value) * ROLL_HEIGHT }],
  }));

  return (
    <View style={styles.wrap}>
      <Text style={styles.title} numberOfLines={1}>
        {title}
      </Text>
      <View style={styles.lineRow}>
        <Text style={styles.line}>LINE</Text>
        <View style={[styles.numberClip, { width: clipWidth }]}>
          {outNumber !== null && (
            <Animated.View style={[styles.numberLayer, outStyle]}>
              <Text style={styles.line}>{outNumber}</Text>
            </Animated.View>
          )}
          <Animated.View style={[styles.numberLayer, inStyle]}>
            <Text style={styles.line}>{number}</Text>
          </Animated.View>
          {/* Invisible copies laid out normally (not stretched to the clip
              box) so onLayout reports each number's real content width. */}
          <Text style={[styles.line, styles.measure]} pointerEvents="none" onLayout={measureWidth(number)}>
            {number}
          </Text>
          {outNumber !== null && (
            <Text style={[styles.line, styles.measure]} pointerEvents="none" onLayout={measureWidth(outNumber)}>
              {outNumber}
            </Text>
          )}
        </View>
        <Text style={styles.line}>OF {lineCount}</Text>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { alignItems: 'center' },
  title: { fontFamily: fonts.uiMedium, fontWeight: '500', fontSize: 14, color: tide.text },
  lineRow: { flexDirection: 'row', alignItems: 'center' },
  numberClip: { height: ROLL_HEIGHT, overflow: 'hidden', marginHorizontal: NUMBER_GAP },
  numberLayer: { position: 'absolute', left: 0, right: 0, top: 0, bottom: 0, justifyContent: 'center' },
  measure: { position: 'absolute', left: 0, top: 0, opacity: 0 },
  line: {
    fontFamily: fonts.ui,
    fontSize: 10,
    lineHeight: ROLL_HEIGHT,
    letterSpacing: 1.2,
    textTransform: 'uppercase',
    color: tide.textDim,
    textAlign: 'center',
    includeFontPadding: false,
    textAlignVertical: 'center',
  },
});
