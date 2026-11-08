/**
 * A number that rolls digit by digit toward a higher value, and appears
 * instantly otherwise (first mount, or a value that went down). Under reduced
 * motion it crossfades instead of rolling. Used by Home's stat chips.
 */

import { useEffect, useMemo, useRef } from 'react';
import { StyleSheet, Text, View, type StyleProp, type TextStyle } from 'react-native';
import Animated, { useAnimatedStyle, useSharedValue, withTiming } from 'react-native-reanimated';

const ROLL_DURATION = 450;

function digitsOf(value: number): number[] {
  return Math.trunc(Math.abs(value)).toString().split('').map(Number);
}

type DigitOrigin = 'static' | 'roll' | 'new';

type DigitColumn = { key: number; digit: number; prevDigit: number | null; origin: DigitOrigin };

/** One digit of an Odometer: rolls from `prevDigit` to `digit` when `origin` is 'roll',
 * slides in when it is 'new' (the number just gained a digit), or renders at rest for
 * 'static' (unchanged digit, or a change that should not animate, like a decrease). */
function OdometerDigit({ digit, prevDigit, origin, reducedMotion, textStyle, h }: DigitColumn & {
  reducedMotion: boolean;
  textStyle: StyleProp<TextStyle>;
  h: number;
}) {
  const cell = { height: h, lineHeight: h };
  const translateY = useSharedValue(0);
  const entrance = useSharedValue(origin === 'new' ? 0 : 1);

  useEffect(() => {
    if (origin === 'static') return;

    if (origin === 'new') {
      entrance.value = 0;
      entrance.value = withTiming(1, { duration: reducedMotion ? 300 : ROLL_DURATION });
      return;
    }

    // origin === 'roll'
    if (reducedMotion) {
      entrance.value = 0;
      entrance.value = withTiming(1, { duration: 300 });
      return;
    }
    translateY.value = 0;
    translateY.value = withTiming(-h, { duration: ROLL_DURATION });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [digit, origin]);

  const rollStyle = useAnimatedStyle(() => ({ transform: [{ translateY: translateY.value }] }));
  const enterStyle = useAnimatedStyle(() => ({
    opacity: entrance.value,
    transform: [{ translateX: origin === 'new' && !reducedMotion ? (1 - entrance.value) * -10 : 0 }],
  }));

  if (origin === 'roll' && prevDigit !== null && !reducedMotion) {
    return (
      <View style={[styles.digitClip, { height: h }]}>
        <Animated.View style={rollStyle}>
          <Text style={[textStyle, cell]}>{prevDigit}</Text>
          <Text style={[textStyle, cell]}>{digit}</Text>
        </Animated.View>
      </View>
    );
  }

  if (origin === 'static') {
    return <Text style={[textStyle, cell]}>{digit}</Text>;
  }

  return (
    <Animated.View style={enterStyle}>
      <Text style={[textStyle, cell]}>{digit}</Text>
    </Animated.View>
  );
}

export function Odometer({ value, reducedMotion, textStyle, h = 34 }: { value: number; reducedMotion: boolean; textStyle: StyleProp<TextStyle>; h?: number }) {
  const mounted = useRef(false);
  const prevValue = useRef(value);
  const prevDigits = useRef<number[] | null>(null);

  // Frozen to `value`: a re-render mid-roll (anything upstream, not just a
  // new value) must not recompute this from the refs below, since the ref
  // update effect already lands as soon as this value's first render
  // commits, well before the 450ms roll finishes. Recomputing on every
  // render would flip a rolling column back to 'static' partway through
  // and snap it to rest instead of finishing the animation.
  const columns: DigitColumn[] = useMemo(() => {
    const digits = digitsOf(value);
    const priorDigits = prevDigits.current;
    const isIncrease = mounted.current && value > prevValue.current;

    return digits.map((digit, i) => {
      const posFromRight = digits.length - 1 - i;
      if (priorDigits === null) return { key: posFromRight, digit, prevDigit: null, origin: 'static' };
      const priorIndex = priorDigits.length - 1 - posFromRight;
      const priorDigit = priorIndex >= 0 ? priorDigits[priorIndex] : null;
      if (priorDigit === null) return { key: posFromRight, digit, prevDigit: null, origin: 'new' };
      if (priorDigit !== digit && isIncrease) return { key: posFromRight, digit, prevDigit: priorDigit, origin: 'roll' };
      return { key: posFromRight, digit, prevDigit: null, origin: 'static' };
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value]);

  useEffect(() => {
    prevDigits.current = digitsOf(value);
    prevValue.current = value;
    mounted.current = true;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value]);

  return (
    <View style={styles.odometerRow}>
      {columns.map(({ key, ...col }) => (
        <OdometerDigit key={key} {...col} reducedMotion={reducedMotion} textStyle={textStyle} h={h} />
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  odometerRow: { flexDirection: 'row' },
  digitClip: { overflow: 'hidden' },
});
