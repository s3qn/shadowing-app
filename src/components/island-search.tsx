import { useEffect, useRef, useState } from 'react';
import { Keyboard, Pressable, StyleSheet, TextInput, View } from 'react-native';
import Animated, {
  Extrapolation,
  interpolate,
  runOnJS,
  useAnimatedReaction,
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
  withSpring,
  withTiming,
  type SharedValue,
} from 'react-native-reanimated';
import Svg, { Line } from 'react-native-svg';

import { SearchIcon } from '@/components/tide/toolbar-icons';
import { fonts } from '@/constants/fonts';
import { Radius, Spacing, tide } from '@/constants/theme';

// The pill starts as a circle the size of the header's search button.
const PILL_H = 40;
// Space between the header and the pill once the row is open.
const ROW_TOP = Spacing.sm;
const ROW_H = PILL_H + ROW_TOP;
// Slightly over critical damping for this stiffness (2 * sqrt(300) is about
// 34.6), so the pill and the list settle without a wobble.
const SPRING = { stiffness: 300, damping: 38, mass: 1 } as const;
const FADE_MS = 200;
// The field takes focus once the pill is this far grown, just as the
// placeholder finishes fading in.
const FOCUS_AT = 0.9;

type Props = {
  open: boolean;
  query: string;
  onChangeQuery: (q: string) => void;
  /** The X at the right of the pill. The parent flips `open` and clears the query. */
  onClose: () => void;
  /** 0 closed, 1 open. The parent fades its header search button with it. */
  grow: SharedValue<number>;
};

/**
 * The Home search field. It sits above the list, so opening it pushes the
 * list down instead of covering it. One spring drives the whole motion: the
 * row's height opens first, a circle fades in under the header's magnifier,
 * the circle stretches into a full-width pill with the magnifier held at its
 * left, and the placeholder, cursor and X fade in last. Closing plays the
 * same spring backwards. Reduced motion keeps the layout still and only fades.
 */
export function IslandSearch({ open, query, onChangeQuery, onClose, grow }: Props) {
  const reducedMotion = useReducedMotion();
  const [mounted, setMounted] = useState(open);
  const fade = useSharedValue(open ? 1 : 0);
  const trackWidth = useSharedValue(0);
  const input = useRef<TextInput>(null);
  const openRef = useRef(open);

  function focusInput() {
    if (openRef.current) input.current?.focus();
  }

  useEffect(() => {
    openRef.current = open;
    if (open) {
      // The field has to exist before the animation that reveals it.
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setMounted(true);
      if (reducedMotion) {
        grow.set(1);
        fade.set(withTiming(1, { duration: FADE_MS }));
      } else {
        fade.set(1);
        grow.set(withSpring(1, SPRING));
      }
      // Reopened before the close finished: the reaction below will not see a
      // fresh crossing, so focus here.
      if (grow.value >= FOCUS_AT) input.current?.focus();
    } else {
      input.current?.blur();
      Keyboard.dismiss();
      const unmount = (finished?: boolean) => {
        'worklet';
        if (finished) runOnJS(setMounted)(false);
      };
      if (reducedMotion) {
        fade.set(withTiming(0, { duration: FADE_MS }, (finished) => {
          'worklet';
          if (!finished) return;
          grow.set(0);
          runOnJS(setMounted)(false);
        }));
      } else {
        grow.set(withSpring(0, SPRING, unmount));
      }
    }
    // Only `open` drives this; the shared values are stable refs.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  useAnimatedReaction(
    () => grow.value >= FOCUS_AT,
    (now, before) => {
      if (now && before === false) runOnJS(focusInput)();
    },
  );

  const rowStyle = useAnimatedStyle(() => ({
    height: interpolate(grow.value, [0, 0.45], [0, ROW_H], Extrapolation.CLAMP),
  }));
  const pillStyle = useAnimatedStyle(() => ({
    opacity: fade.value * interpolate(grow.value, [0.15, 0.45], [0, 1], Extrapolation.CLAMP),
    width: interpolate(
      grow.value,
      [0.25, 1],
      [PILL_H, Math.max(PILL_H, trackWidth.value)],
      Extrapolation.CLAMP,
    ),
  }));
  const contentStyle = useAnimatedStyle(() => ({
    opacity: interpolate(grow.value, [0.8, 1], [0, 1], Extrapolation.CLAMP),
  }));

  return (
    <Animated.View style={[styles.row, rowStyle]}>
      <View
        style={styles.track}
        onLayout={(e) => {
          trackWidth.value = e.nativeEvent.layout.width;
        }}
      />
      {mounted ? (
        <Animated.View style={[styles.pill, pillStyle]}>
          <View style={styles.icon} pointerEvents="none">
            <SearchIcon color={tide.text} size={18} />
          </View>
          <Animated.View style={[styles.content, contentStyle]}>
            <TextInput
              ref={input}
              // Reduced motion jumps straight to open, before this field has
              // mounted, so the reaction's focus would find no field.
              autoFocus={reducedMotion}
              value={query}
              onChangeText={onChangeQuery}
              placeholder="Search islands"
              placeholderTextColor={tide.textDim}
              autoCorrect={false}
              returnKeyType="search"
              style={styles.input}
            />
            <Pressable onPress={onClose} hitSlop={10} accessibilityLabel="Close search" style={styles.close}>
              <Svg width={16} height={16} viewBox="0 0 24 24" fill="none">
                <Line x1={6} y1={6} x2={18} y2={18} stroke={tide.textDim} strokeWidth={2.2} strokeLinecap="round" />
                <Line x1={18} y1={6} x2={6} y2={18} stroke={tide.textDim} strokeWidth={2.2} strokeLinecap="round" />
              </Svg>
            </Pressable>
          </Animated.View>
        </Animated.View>
      ) : null}
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  row: { overflow: 'hidden', marginHorizontal: Spacing.lg },
  // Invisible full-width strut, measured for the pill's open width.
  track: { position: 'absolute', left: 0, right: 0, top: 0, height: 1 },
  pill: {
    position: 'absolute',
    left: 0,
    top: ROW_TOP,
    height: PILL_H,
    borderRadius: Radius.pill,
    borderWidth: 1,
    borderColor: tide.waterline,
    backgroundColor: tide.water,
    flexDirection: 'row',
    alignItems: 'center',
    overflow: 'hidden',
  },
  icon: { width: PILL_H - 2, height: PILL_H - 2, alignItems: 'center', justifyContent: 'center' },
  content: { flex: 1, flexDirection: 'row', alignItems: 'center', paddingRight: Spacing.md },
  input: {
    flex: 1,
    height: PILL_H - 2,
    paddingVertical: 0,
    fontSize: 15,
    fontFamily: fonts.uiMedium,
    fontWeight: '500',
    color: tide.text,
  },
  close: { width: 24, height: 24, alignItems: 'center', justifyContent: 'center' },
});
