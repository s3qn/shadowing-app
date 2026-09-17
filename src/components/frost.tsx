import { type ReactNode, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { type LayoutChangeEvent, Platform, type StyleProp, StyleSheet, View, type ViewStyle } from 'react-native';
import Animated, { useAnimatedStyle, useReducedMotion, useSharedValue, withTiming } from 'react-native-reanimated';

import { tide } from '@/constants/theme';

/** How long the glyphs take to settle into or out of focus. */
const FROST_MS = 220;
/** Room the soft glyphs get past the children's own box before the clip, so
 * the clip never shows as an edge. */
const PAD = 12;
/** Android's view blur needs API 31. Below it the glyphs only fade. */
const ANDROID_BLUR = Platform.OS === 'android' && typeof Platform.Version === 'number' && Platform.Version >= 31;

type Props = {
  /** Frosted: the children stay in place, at their own size, softly out of focus. */
  frosted: boolean;
  children: ReactNode;
  style?: StyleProp<ViewStyle>;
  /** The colour the soft glyphs take on iOS; pass the text's own colour. */
  ink?: string;
  /** Blur radius in points. */
  blur?: number;
};

/**
 * Text that should be there but not readable: Blind's Japanese and the hidden
 * English. The children keep their layout either way, so frosting never moves
 * anything, and there is no pane or box: only the glyphs go out of focus.
 *
 * iOS has no view blur in React Native, so the frost is the children's own
 * layer shadow. The shadow is traced from the glyphs' alpha, so it is a soft
 * copy of the text in `ink`. The sharp children are moved one width to the
 * left, the shadow is offset back by the same amount, and a clip `PAD` wider
 * than the children hides the sharp copy. Android blurs the children view
 * itself. Either way the moved copy takes no touches: put any gesture or
 * Pressable outside the Frost, not inside it.
 */
export function Frost({ frosted, children, style, ink = tide.text, blur = 4 }: Props) {
  const reducedMotion = useReducedMotion();
  // The children's width, kept in a ref: only a frosted row draws from it, so
  // a clear row's first layout (every transcript row on open) never renders.
  const widthRef = useRef(0);
  const [width, setWidth] = useState(0);
  // A row that measured while clear and then frosts: the state catches up
  // with the ref before paint, so the frosted copy never shows at width 0.
  useLayoutEffect(() => {
    if (frosted && widthRef.current > 0 && widthRef.current !== width) setWidth(widthRef.current);
  }, [frosted, width]);
  const fade = useSharedValue(1);
  // Only a change fades: a row that mounts frosted is simply frosted.
  const shownFrosted = useRef(frosted);

  useEffect(() => {
    if (shownFrosted.current === frosted) return;
    shownFrosted.current = frosted;
    if (reducedMotion) return;
    fade.value = 0.2;
    fade.value = withTiming(1, { duration: FROST_MS });
  }, [frosted, reducedMotion, fade]);

  const fadeStyle = useAnimatedStyle(() => ({ opacity: fade.value }));

  const onLayout = (e: LayoutChangeEvent) => {
    const w = e.nativeEvent.layout.width;
    if (!Number.isFinite(w)) return;
    widthRef.current = w;
    if (frosted && w !== width) setWidth(w);
  };

  let inner: ViewStyle | null = null;
  if (frosted && Platform.OS === 'ios') {
    const shift = width + 2 * PAD + 8;
    inner =
      width > 0
        ? {
            transform: [{ translateX: -shift }],
            shadowColor: ink,
            shadowOpacity: 0.85,
            shadowRadius: blur,
            shadowOffset: { width: shift, height: 0 },
          }
        : { opacity: 0 };
  } else if (frosted && Platform.OS === 'android') {
    inner = ANDROID_BLUR ? { filter: [{ blur: blur * 1.5 }] } : { opacity: 0.12 };
  }

  return (
    <View style={style}>
      <Animated.View style={[styles.clip, fadeStyle]} pointerEvents="box-none">
        <View
          collapsable={false}
          onLayout={onLayout}
          style={inner}
          pointerEvents={frosted ? 'none' : 'auto'}
          accessibilityElementsHidden={frosted}
          importantForAccessibility={frosted ? 'no-hide-descendants' : 'auto'}>
          {children}
        </View>
      </Animated.View>
    </View>
  );
}

const styles = StyleSheet.create({
  // Same box as the children (the margin undoes the padding), but the clip
  // sits PAD past every edge so the soft glyphs are never cut.
  clip: { margin: -PAD, padding: PAD, overflow: Platform.OS === 'ios' ? 'hidden' : 'visible' },
});
