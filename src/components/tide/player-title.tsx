import { useEffect, useRef, useState } from 'react';
import { LayoutChangeEvent, StyleSheet, Text, View } from 'react-native';
import Animated, { runOnJS, useAnimatedStyle, useReducedMotion, useSharedValue, withTiming } from 'react-native-reanimated';

import { fonts } from '@/constants/fonts';
import { tide } from '@/constants/theme';
import { useDir, useT } from '@/lib/i18n';

type Props = {
  title: string;
  lineIndex: number;
  lineCount: number;
  /** Both rows at opacity 0 while the card morph's flying title stands in. */
  hidden?: boolean;
  /** Where the title text sits on screen, reported after every layout. */
  onTitleRect?: (rect: { x: number; y: number; width: number; height: number }) => void;
  /** With no line count yet: show the line row with a pill standing in for
   * the count (loading), instead of keeping the row invisible. */
  placeholder?: boolean;
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
export function PlayerTitle({ title, lineIndex, lineCount, hidden = false, onTitleRect, placeholder = false }: Props) {
  const reducedMotion = useReducedMotion();
  const { t } = useT();
  // `dir` below is the roll's up/down direction, so the writing direction
  // keeps its own name here.
  const writing = useDir();
  const number = lineIndex + 1;
  const titleRef = useRef<Text>(null);
  const reportTitleRect = () => {
    if (!onTitleRect) return;
    titleRef.current?.measureInWindow((x, y, width, height) => onTitleRect({ x, y, width, height }));
  };

  const prevIndex = useRef(lineIndex);
  const prevNumber = useRef(number);
  const [outNumber, setOutNumber] = useState<number | null>(null);
  const anim = useSharedValue(1);
  const dir = useSharedValue<1 | -1>(1);

  // Real measured widths per number value, filled in by the invisible
  // measurement copies below. Kept across renders so a number we've
  // already seen (e.g. rolling back to it) doesn't flash the estimate again.
  const [widths, setWidths] = useState<ReadonlyMap<number, number>>(() => new Map());

  const measureWidth = (value: number) => (event: LayoutChangeEvent) => {
    const width = Math.ceil(event.nativeEvent.layout.width);
    setWidths((prev) => (prev.get(value) === width ? prev : new Map(prev).set(value, width)));
  };

  const widthFor = (value: number) =>
    widths.get(value) ?? Math.max(MIN_NUMBER_WIDTH, String(value).length * DIGIT_WIDTH);

  // While the island loads there is no line count yet and the line row is
  // invisible; the line it then opens on (a resumed one, say) lands without a roll.
  const prevCount = useRef(lineCount);
  useEffect(() => {
    const wasEmpty = prevCount.current <= 0;
    prevCount.current = lineCount;
    if (lineIndex === prevIndex.current) return;
    if (wasEmpty) {
      prevIndex.current = lineIndex;
      prevNumber.current = number;
      return;
    }
    dir.value = lineIndex > prevIndex.current ? 1 : -1;
    setOutNumber(prevNumber.current);
    anim.value = 0;
    anim.value = withTiming(1, { duration: reducedMotion ? 160 : 220 }, (finished) => {
      if (finished) runOnJS(setOutNumber)(null);
    });
    prevIndex.current = lineIndex;
    prevNumber.current = number;
  }, [lineIndex, lineCount, number, reducedMotion, anim, dir]);

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
    <View style={[styles.wrap, hidden ? styles.hidden : null]}>
      <Text ref={titleRef} style={styles.title} numberOfLines={1} onLayout={reportTitleRect}>
        {title}
      </Text>
      <View style={[styles.lineRow, writing.row, lineCount > 0 || placeholder ? null : styles.waiting]}>
        <Text style={styles.line}>{t('player.lineLabel')}</Text>
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
        <Text style={styles.line}>{t('player.ofLabel')}</Text>
        {/* At least the pill's width, so a count of up to three digits
            replaces it without moving the row. */}
        <View style={[styles.countBox, writing.rtl && styles.countBoxRtl]}>
          {lineCount > 0 ? <Text style={styles.line}>{lineCount}</Text> : <View style={styles.countPill} />}
        </View>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { alignItems: 'center' },
  hidden: { opacity: 0 },
  title: { fontFamily: fonts.uiMedium, fontWeight: '500', fontSize: 14, color: tide.text },
  lineRow: { flexDirection: 'row', alignItems: 'center' },
  // Keeps the row's height while the island loads, so the title does not move.
  waiting: { opacity: 0 },
  numberClip: { height: ROLL_HEIGHT, overflow: 'hidden', marginHorizontal: NUMBER_GAP },
  numberLayer: { position: 'absolute', left: 0, right: 0, top: 0, bottom: 0, justifyContent: 'center' },
  measure: { position: 'absolute', left: 0, top: 0, opacity: 0 },
  // No minWidth: the box sizes to its one child (pill or count text) so the
  // gap after "OF" is always exactly NUMBER_GAP, the same as every other gap
  // in the row, instead of centering a narrow count inside a wider box.
  countBox: { height: ROLL_HEIGHT, marginLeft: NUMBER_GAP, alignItems: 'center', justifyContent: 'center' },
  countBoxRtl: { marginLeft: 0, marginRight: NUMBER_GAP },
  countPill: { width: 22, height: 10, borderRadius: 5, backgroundColor: tide.textDim, opacity: 0.35 },
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
