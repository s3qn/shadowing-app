/**
 * The Home screen's practice summary: today's minutes, the current streak,
 * and the last 7 days as a row of weekday letters over their minutes.
 *
 * The two headline numbers (today's minutes, the streak) roll like an
 * odometer when they go up, and today's cell in the week row lights up in
 * the Japanese accent with a soft one-time glow the moment today's practice
 * first counts. Both skip animation on first mount, showing the value
 * instantly, and crossfade instead of rolling or sliding under reduced
 * motion.
 */

import { useEffect, useMemo, useRef } from 'react';
import { StyleSheet, Text, View, type StyleProp, type TextStyle } from 'react-native';
import Animated, { useAnimatedStyle, useReducedMotion, useSharedValue, withSequence, withTiming } from 'react-native-reanimated';

import { fonts } from '@/constants/fonts';
import { useDir, useT } from '@/lib/i18n';
import { Radius, Spacing, tide } from '@/constants/theme';
import { dayKey, lastSevenDays, minutesOn, streakDays, type PracticeLog } from '@/lib/practice';

const DIGIT_HEIGHT = 34;
const ROLL_DURATION = 450;

function digitsOf(value: number): number[] {
  return Math.trunc(Math.abs(value)).toString().split('').map(Number);
}

type DigitOrigin = 'static' | 'roll' | 'new';

type DigitColumn = { key: number; digit: number; prevDigit: number | null; origin: DigitOrigin };

/** One digit of an Odometer: rolls from `prevDigit` to `digit` when `origin` is 'roll',
 * slides in when it is 'new' (the number just gained a digit), or renders at rest for
 * 'static' (unchanged digit, or a change that should not animate, like a decrease). */
function OdometerDigit({ digit, prevDigit, origin, reducedMotion, textStyle }: DigitColumn & {
  reducedMotion: boolean;
  textStyle: StyleProp<TextStyle>;
}) {
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
    translateY.value = withTiming(-DIGIT_HEIGHT, { duration: ROLL_DURATION });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [digit, origin]);

  const rollStyle = useAnimatedStyle(() => ({ transform: [{ translateY: translateY.value }] }));
  const enterStyle = useAnimatedStyle(() => ({
    opacity: entrance.value,
    transform: [{ translateX: origin === 'new' && !reducedMotion ? (1 - entrance.value) * -10 : 0 }],
  }));

  if (origin === 'roll' && prevDigit !== null && !reducedMotion) {
    return (
      <View style={styles.digitClip}>
        <Animated.View style={rollStyle}>
          <Text style={[textStyle, styles.digitText]}>{prevDigit}</Text>
          <Text style={[textStyle, styles.digitText]}>{digit}</Text>
        </Animated.View>
      </View>
    );
  }

  if (origin === 'static') {
    return <Text style={[textStyle, styles.digitText]}>{digit}</Text>;
  }

  return (
    <Animated.View style={enterStyle}>
      <Text style={[textStyle, styles.digitText]}>{digit}</Text>
    </Animated.View>
  );
}

/** A number that rolls digit by digit toward a higher value, and appears instantly
 * otherwise (first mount, or a value that went down). */
function Odometer({ value, reducedMotion, textStyle }: { value: number; reducedMotion: boolean; textStyle: StyleProp<TextStyle> }) {
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
        <OdometerDigit key={key} {...col} reducedMotion={reducedMotion} textStyle={textStyle} />
      ))}
    </View>
  );
}

/** One weekday cell in the 7-day row. Today's cell lights up in the Japanese accent
 * once it holds minutes, with a soft one-time glow the moment it first crosses from
 * zero, not on mount. */
function DayCell({ dayKey: key, minutes, isToday, reducedMotion, locale }: {
  dayKey: string;
  minutes: number;
  isToday: boolean;
  reducedMotion: boolean;
  locale: string;
}) {
  const letter = new Date(`${key}T12:00:00`).toLocaleDateString(locale, { weekday: 'narrow' });
  const lit = isToday && minutes > 0;

  const mounted = useRef(false);
  const prevMinutes = useRef(minutes);
  const glow = useSharedValue(0);

  useEffect(() => {
    if (!isToday) return;
    const wasZero = prevMinutes.current === 0;
    prevMinutes.current = minutes;
    const justCounted = mounted.current && wasZero && minutes > 0;
    mounted.current = true;
    if (!justCounted) return;

    if (reducedMotion) {
      glow.value = withSequence(withTiming(1, { duration: 200 }), withTiming(0, { duration: 300 }));
      return;
    }
    glow.value = withSequence(withTiming(1, { duration: 300 }), withTiming(0, { duration: 600 }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [minutes, isToday]);

  const glowStyle = useAnimatedStyle(() => ({ opacity: glow.value }));

  return (
    <View style={styles.day}>
      <Animated.View pointerEvents="none" style={[styles.dayGlow, glowStyle]} />
      <Text style={[styles.dayLetter, { color: lit ? tide.lang.ja : tide.textDim }]}>{letter}</Text>
      <Text style={[styles.dayValue, { color: lit ? tide.lang.ja : tide.text }]}>{minutes > 0 ? minutes : '·'}</Text>
    </View>
  );
}

export function PracticeCard({ log, dueCount }: { log: PracticeLog; dueCount: number }) {
  const { t, locale } = useT();
  const dir = useDir();
  const reducedMotion = useReducedMotion();
  const today = new Date();
  const todayKey = dayKey(today);
  const todayMinutes = minutesOn(log, todayKey);
  const streak = streakDays(log, today);
  const week = lastSevenDays(today);

  return (
    <View style={StyleSheet.flatten([styles.card, { backgroundColor: tide.water, borderColor: tide.waterline }])}>
      <View style={styles.numbers}>
        <View style={styles.stat}>
          <Odometer value={todayMinutes} reducedMotion={reducedMotion} textStyle={[styles.value, { color: tide.text }]} />
          <Text style={[styles.label, { color: tide.textDim }]}>{t('home.practiceToday')}</Text>
        </View>
        <View style={styles.stat}>
          <Odometer value={streak} reducedMotion={reducedMotion} textStyle={[styles.value, { color: tide.text }]} />
          <Text style={[styles.label, { color: tide.textDim }]}>{t('home.practiceStreak')}</Text>
        </View>
        <View style={styles.stat}>
          <Odometer value={dueCount} reducedMotion={reducedMotion} textStyle={[styles.value, { color: tide.text }]} />
          <Text style={[styles.label, { color: tide.textDim }]}>{t('home.dueToday')}</Text>
        </View>
      </View>
      <View style={[styles.week, dir.row]}>
        {week.map((key) => (
          <DayCell key={key} dayKey={key} minutes={minutesOn(log, key)} isToday={key === todayKey} reducedMotion={reducedMotion} locale={locale} />
        ))}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  card: { borderWidth: 1, borderRadius: Radius.md, padding: Spacing.lg, gap: Spacing.md },
  numbers: { flexDirection: 'row' },
  stat: { alignItems: 'center', flex: 1 },
  value: { fontSize: 28, fontWeight: '700', fontFamily: fonts.ui },
  label: { fontSize: 13, fontWeight: '600', fontFamily: fonts.ui },
  odometerRow: { flexDirection: 'row' },
  digitClip: { height: DIGIT_HEIGHT, overflow: 'hidden' },
  digitText: { height: DIGIT_HEIGHT, lineHeight: DIGIT_HEIGHT },
  week: { flexDirection: 'row', justifyContent: 'space-between' },
  day: { alignItems: 'center', gap: 2, minWidth: 20, position: 'relative' },
  dayGlow: { position: 'absolute', top: -4, bottom: -4, left: -6, right: -6, borderRadius: Radius.md, backgroundColor: tide.lang.ja },
  dayLetter: { fontSize: 12, fontWeight: '600', fontFamily: fonts.ui },
  dayValue: { fontSize: 13, fontFamily: fonts.ui },
});
