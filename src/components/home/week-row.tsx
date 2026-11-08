/**
 * The last seven days as a row of weekday letters over their minutes. Home no
 * longer shows it; the Streak sheet does. Today's cell lights up in the
 * accent once it holds minutes, with a soft one-time glow the moment it first
 * crosses from zero, not on mount.
 */

import { useEffect, useRef } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import Animated, { useAnimatedStyle, useReducedMotion, useSharedValue, withSequence, withTiming } from 'react-native-reanimated';

import { fonts } from '@/constants/fonts';
import { Radius, tide } from '@/constants/theme';
import { useDir, useT } from '@/lib/i18n';
import { type Key } from '@/locales/en';
import { dayKey, lastSevenDays, minutesOn, type PracticeLog } from '@/lib/practice';

/** Indexed by `Date.getDay()`, Sunday first. The letters come from the
 * catalogue rather than `toLocaleDateString(locale, { weekday: 'narrow' })`:
 * Hermes hands back a Latin letter for he-IL. */
export const WEEKDAY_KEY: Key[] = [
  'home.weekdaySun',
  'home.weekdayMon',
  'home.weekdayTue',
  'home.weekdayWed',
  'home.weekdayThu',
  'home.weekdayFri',
  'home.weekdaySat',
];

function DayCell({ letter, minutes, isToday, reducedMotion }: {
  letter: string;
  minutes: number;
  isToday: boolean;
  reducedMotion: boolean;
}) {
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

/** `dots` is the non-beta Home strip: seven small dots, today first and lit, nothing to open. */
export function WeekRow({ log, dots }: { log: PracticeLog; dots?: boolean }) {
  const { t } = useT();
  const dir = useDir();
  const reducedMotion = useReducedMotion();
  const today = new Date();
  const todayKey = dayKey(today);
  if (dots) {
    return (
      <View style={[styles.dots, dir.row]} accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
        {lastSevenDays(today)
          .reverse()
          .map((key) => (
            <View key={key} style={[styles.dot, key === todayKey && styles.dotOn]} />
          ))}
      </View>
    );
  }
  return (
    <View style={[styles.week, dir.row]}>
      {lastSevenDays(today).map((key) => (
        <DayCell
          key={key}
          letter={t(WEEKDAY_KEY[new Date(`${key}T12:00:00`).getDay()])}
          minutes={minutesOn(log, key)}
          isToday={key === todayKey}
          reducedMotion={reducedMotion}
        />
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  week: { flexDirection: 'row', justifyContent: 'space-between' },
  dots: { flexDirection: 'row', alignItems: 'center', gap: 5 },
  dot: { width: 7, height: 7, borderRadius: 3.5, backgroundColor: '#33434D' },
  dotOn: { backgroundColor: '#F09878' },
  day: { alignItems: 'center', gap: 2, minWidth: 20, position: 'relative' },
  dayGlow: { position: 'absolute', top: -4, bottom: -4, left: -6, right: -6, borderRadius: Radius.md, backgroundColor: tide.lang.ja },
  dayLetter: { fontSize: 12, fontWeight: '600', fontFamily: fonts.ui },
  dayValue: { fontSize: 13, fontFamily: fonts.ui },
});
