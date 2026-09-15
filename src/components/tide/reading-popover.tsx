import { useEffect } from 'react';
import { StyleSheet, Text } from 'react-native';
import Animated, { useAnimatedStyle, useReducedMotion, useSharedValue, withSpring } from 'react-native-reanimated';

import { PressScale } from '@/components/press-scale';
import { PopoverBubble } from '@/components/tide/popover-bubble';
import { fonts } from '@/constants/fonts';
import { tide } from '@/constants/theme';
import { READING_OPTIONS, type ReadingMode } from '@/lib/settings';

const BUTTON = 44;
const GAP = 10;
const BODY_PAD = 8;
const STEP = BUTTON + GAP;
const READING_POP_W = READING_OPTIONS.length * BUTTON + (READING_OPTIONS.length - 1) * GAP + 2 * BODY_PAD;
const BODY_H = BUTTON + 2 * BODY_PAD;

/** Heavily overdamped: the pill slides to its new icon without a wobble. */
const PILL_SPRING = { damping: 40, stiffness: 300, mass: 1 } as const;

export const READING_LABEL: Record<ReadingMode, string> = {
  off: 'Off',
  furigana: 'Furigana',
  kana: 'Kana',
  romaji: 'Romaji',
};
const READING_GLYPH: Record<ReadingMode, string> = { off: '⊘', furigana: 'ふ', kana: 'あ', romaji: 'A' };

type Props = {
  /** The Reading tile's horizontal centre and top edge, in the parent's coordinates. */
  anchorX: number;
  anchorTop: number;
  /** The parent's width, to keep the bubble on screen. */
  width: number;
  value: ReadingMode;
  onChange: (mode: ReadingMode) => void;
  onClose: () => void;
};

/**
 * The Reading tile's popover: three round glyphs in a row, Furigana, Kana
 * and Romaji, with an accent pill that slides behind the picked one. The
 * selected glyph turns dark over the pill; the others stay light. A tap
 * anywhere outside closes it.
 */
export function ReadingPopover({ anchorX, anchorTop, width, value, onChange, onClose }: Props) {
  const reducedMotion = useReducedMotion();
  const pillX = useSharedValue(READING_OPTIONS.indexOf(value) * STEP);

  useEffect(() => {
    const target = READING_OPTIONS.indexOf(value) * STEP;
    if (reducedMotion) {
      pillX.value = target;
      return;
    }
    pillX.value = withSpring(target, PILL_SPRING);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value, reducedMotion]);

  const pillStyle = useAnimatedStyle(() => ({ transform: [{ translateX: pillX.value }] }));

  return (
    <PopoverBubble
      anchorX={anchorX}
      anchorTop={anchorTop}
      parentWidth={width}
      width={READING_POP_W}
      height={BODY_H}
      radius={BODY_H / 2}
      bodyStyle={styles.body}
      onClose={onClose}>
      <Animated.View style={[styles.pill, pillStyle]} pointerEvents="none" />
      {READING_OPTIONS.map((mode) => {
        const selected = mode === value;
        return (
          <PressScale
            key={mode}
            onPress={() => onChange(mode)}
            accessibilityRole="radio"
            accessibilityLabel={READING_LABEL[mode]}
            accessibilityState={{ selected }}
            style={styles.button}>
            <Text
              style={[
                styles.glyph,
                (mode === 'romaji' || mode === 'off') && styles.glyphLatin,
                { color: selected ? tide.sky[0] : tide.text },
              ]}>
              {READING_GLYPH[mode]}
            </Text>
          </PressScale>
        );
      })}
    </PopoverBubble>
  );
}

const styles = StyleSheet.create({
  body: { flexDirection: 'row', gap: GAP, padding: BODY_PAD },
  pill: {
    position: 'absolute',
    left: BODY_PAD,
    top: BODY_PAD,
    width: BUTTON,
    height: BUTTON,
    borderRadius: BUTTON / 2,
    backgroundColor: tide.lang.ja,
  },
  button: { width: BUTTON, height: BUTTON, alignItems: 'center', justifyContent: 'center' },
  glyph: { fontFamily: fonts.serifJp, fontSize: 20 },
  glyphLatin: { fontFamily: fonts.uiMedium, fontWeight: '500', fontSize: 18 },
});
