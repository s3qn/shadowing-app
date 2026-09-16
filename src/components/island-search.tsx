import { useEffect, useRef, useState } from 'react';
import { Keyboard, Pressable, StyleSheet, TextInput, View } from 'react-native';
import Animated, {
  Easing,
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
/** The search row's full height. */
export const SEARCH_ROW_H = PILL_H + ROW_TOP;
// Slightly over critical damping for this stiffness (2 * sqrt(300) is about
// 34.6), so the pill settles without a wobble.
const SPRING = { stiffness: 300, damping: 38, mass: 1 } as const;
// The row's height has its own timing, so it starts moving on the tap in
// both directions instead of waiting on the spring.
const ROW_OPEN = { duration: 240, easing: Easing.out(Easing.cubic) };
const ROW_CLOSE = { duration: 220, easing: Easing.inOut(Easing.quad) };
const FADE_MS = 200;
// On close the placeholder, cursor and X are gone before the row has shrunk
// much.
const CONTENT_OUT_MS = 120;
// The field takes focus once the pill is this far grown, just as the
// placeholder finishes fading in.
const FOCUS_AT = 0.9;

/**
 * Starts the open motion. Home calls it from the search button's press, in
 * the same call that flips `open`, so nothing waits on a render.
 */
export function startSearchOpen(grow: SharedValue<number>, rowH: SharedValue<number>, reducedMotion: boolean) {
  if (reducedMotion) {
    grow.set(1);
    rowH.set(SEARCH_ROW_H);
  } else {
    grow.set(withSpring(1, SPRING));
    rowH.set(withTiming(SEARCH_ROW_H, ROW_OPEN));
  }
}

type Props = {
  open: boolean;
  query: string;
  onChangeQuery: (q: string) => void;
  /** The X at the right of the pill. The close motion has already started;
   * the parent flips `open` and clears the query. */
  onClose: () => void;
  /** 0 closed, 1 open. The parent fades its header search button with it. */
  grow: SharedValue<number>;
  /** The row's height, 0 to SEARCH_ROW_H. */
  rowH: SharedValue<number>;
};

/**
 * The Home search field. It sits above the list, so opening it pushes the
 * list down instead of covering it. The row's height runs on its own timing
 * from the tap. A spring drives the rest: a circle fades in under the
 * header's magnifier, stretches into a full-width pill with the magnifier
 * held at its left, and the placeholder, cursor and X fade in last. Closing
 * shrinks the row at once, fades the pill's content out quickly and plays the
 * spring backwards. Reduced motion jumps the height and only fades.
 */
export function IslandSearch({ open, query, onChangeQuery, onClose, grow, rowH }: Props) {
  const reducedMotion = useReducedMotion();
  const [mounted, setMounted] = useState(open);
  const fade = useSharedValue(open ? 1 : 0);
  const content = useSharedValue(open ? 1 : 0);
  const trackWidth = useSharedValue(0);
  const input = useRef<TextInput>(null);
  const openRef = useRef(open);
  // Each close gets a number; the pill unmounts once every animation of the
  // latest close has finished, and never after a reopen.
  const closeGen = useRef(0);
  const pending = useRef(0);

  function focusInput() {
    if (openRef.current) input.current?.focus();
  }

  function partDone(gen: number) {
    if (gen !== closeGen.current || openRef.current) return;
    pending.current -= 1;
    if (pending.current <= 0) setMounted(false);
  }

  function handleClose() {
    if (!openRef.current) return;
    closeGen.current += 1;
    const gen = closeGen.current;
    const done = (finished?: boolean) => {
      'worklet';
      if (finished) runOnJS(partDone)(gen);
    };
    if (reducedMotion) {
      pending.current = 1;
      rowH.set(0);
      fade.set(withTiming(0, { duration: FADE_MS }, (finished) => {
        'worklet';
        if (!finished) return;
        grow.set(0);
        runOnJS(partDone)(gen);
      }));
    } else {
      pending.current = 2;
      rowH.set(withTiming(0, ROW_CLOSE, done));
      content.set(withTiming(0, { duration: CONTENT_OUT_MS }));
      grow.set(withSpring(0, SPRING, done));
    }
    openRef.current = false;
    onClose();
    input.current?.blur();
    Keyboard.dismiss();
  }

  useEffect(() => {
    openRef.current = open;
    if (!open) return;
    closeGen.current += 1;
    // The field has to exist before the animation that reveals it.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setMounted(true);
    content.set(1);
    if (reducedMotion) fade.set(withTiming(1, { duration: FADE_MS }));
    else fade.set(1);
    // Reopened before the close finished: the reaction below will not see a
    // fresh crossing, so focus here.
    if (grow.value >= FOCUS_AT) input.current?.focus();
    // Only `open` drives this; the shared values are stable refs.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  useAnimatedReaction(
    () => grow.value >= FOCUS_AT,
    (now, before) => {
      if (now && before === false) runOnJS(focusInput)();
    },
  );

  const rowStyle = useAnimatedStyle(() => {
    const h = rowH.value;
    return { height: Number.isFinite(h) ? Math.max(0, h) : 0 };
  });
  const pillStyle = useAnimatedStyle(() => {
    const g = Number.isFinite(grow.value) ? grow.value : 0;
    const f = Number.isFinite(fade.value) ? fade.value : 0;
    const w = Number.isFinite(trackWidth.value) ? trackWidth.value : 0;
    return {
      opacity: f * interpolate(g, [0.15, 0.45], [0, 1], Extrapolation.CLAMP),
      width: interpolate(g, [0.25, 1], [PILL_H, Math.max(PILL_H, w)], Extrapolation.CLAMP),
    };
  });
  const contentStyle = useAnimatedStyle(() => {
    const g = Number.isFinite(grow.value) ? grow.value : 0;
    const c = Number.isFinite(content.value) ? content.value : 0;
    return { opacity: c * interpolate(g, [0.8, 1], [0, 1], Extrapolation.CLAMP) };
  });

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
            <Pressable onPress={handleClose} hitSlop={10} accessibilityLabel="Close search" style={styles.close}>
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
