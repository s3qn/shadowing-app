import { Platform, StyleSheet } from 'react-native';
import Animated, { type SharedValue, useAnimatedStyle } from 'react-native-reanimated';

import type { Highlight, WordBox } from '@/components/word-highlight';
import { tide } from '@/constants/theme';

type Props = {
  /** The same highlight the word colours read (see word-highlight.ts). */
  highlight: Highlight;
  /** Each word's layout box, by word index, in this outline's parent. */
  boxes: SharedValue<(WordBox | null)[]>;
};

/**
 * A thin glowing underline under the lit word. It reads the same `level` the
 * word colours read, so it slides to the next word over exactly the handoff
 * that recolours it, and it can never sit under a word that is not lit. A
 * handoff to a word on another row fades out and back in rather than sliding
 * diagonally across the text. Nothing is lit: it is fully transparent.
 */
export function WordOutline({ highlight, boxes }: Props) {
  const style = useAnimatedStyle(() => {
    const h = highlight.value;
    const all = boxes.value;
    const m = Math.floor(h.level);
    const f = h.level - m;
    let a = -1;
    let b = -1;
    let opacity = 0;
    let t = 0;
    if (m === h.from) {
      a = h.from;
      opacity = f;
    } else if (m > h.from && m <= h.to) {
      a = m - 1;
      b = m;
      opacity = 1;
      t = f;
    } else if (m === h.to + 1) {
      a = h.to;
      opacity = 1 - f;
    }
    const boxA = a >= 0 ? all[a] : null;
    const boxB = b >= 0 ? all[b] : null;
    if (!boxA || h.on <= 0) return { opacity: 0 };
    let x = boxA.x;
    let y = boxA.y + boxA.height;
    let w = boxA.width;
    if (boxB && t > 0) {
      const yB = boxB.y + boxB.height;
      if (Math.abs(yB - y) < 2) {
        x += (boxB.x - x) * t;
        w += (boxB.width - w) * t;
      } else {
        if (t >= 0.5) {
          x = boxB.x;
          y = yB;
          w = boxB.width;
        }
        opacity *= Math.abs(1 - 2 * t);
      }
    }
    return {
      opacity: opacity * h.on,
      width: w + 6,
      transform: [{ translateX: x - 3 }, { translateY: y }],
    };
  });

  return <Animated.View pointerEvents="none" style={[styles.outline, style]} />;
}

const styles = StyleSheet.create({
  outline: {
    position: 'absolute',
    left: 0,
    top: 0,
    width: 0,
    height: 2.5,
    borderRadius: 2,
    opacity: 0,
    backgroundColor: tide.lang.ja,
    ...Platform.select({
      ios: { shadowColor: tide.lang.ja, shadowOpacity: 0.9, shadowRadius: 4, shadowOffset: { width: 0, height: 0 } },
      default: {},
    }),
  },
});
