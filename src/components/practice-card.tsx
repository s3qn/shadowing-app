/**
 * The Home screen's practice summary: today's minutes against the daily
 * goal picked in onboarding, the streak flame (tap: the Streak sheet), and the last 7 days as a
 * row of weekday letters over their minutes.
 *
 * Today's minutes roll like an odometer when they go up, and today's cell
 * in the week row lights up in the Japanese accent with a soft one-time
 * glow the moment today's practice first counts. Both skip animation on
 * first mount, showing the value instantly, and crossfade instead of
 * rolling or sliding under reduced motion. The streak count sits inside the
 * gem (streak-gem.tsx) and does not roll.
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import { StyleSheet, Text, View, type StyleProp, type TextStyle } from 'react-native';
import Animated, { useAnimatedStyle, useReducedMotion, useSharedValue, withSequence, withTiming } from 'react-native-reanimated';
import { Canvas, Circle, RadialGradient, vec } from '@shopify/react-native-skia';

import { fonts } from '@/constants/fonts';
import { useDir, useT } from '@/lib/i18n';
import { type Key } from '@/locales/en';
import { Radius, Spacing, tide, verb } from '@/constants/theme';
import { SymbolView } from 'expo-symbols';
import { PrismButton } from '@/components/prism/prism-button';
import { PressScale } from '@/components/press-scale';
import { StreakGem } from '@/components/streak-gem';
import { MILESTONE_DAYS } from '@/lib/level-up-store';
import { dayKey, dayQualifies, lastSevenDays, minutesOn, streakDays, type PracticeLog } from '@/lib/practice';
import { getSettingsSync, subscribeSettings } from '@/lib/settings';

const DIGIT_HEIGHT = 34;
const ROLL_DURATION = 450;

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

/** A number that rolls digit by digit toward a higher value, and appears instantly
 * otherwise (first mount, or a value that went down). */
function Odometer({ value, reducedMotion, textStyle, h = DIGIT_HEIGHT }: { value: number; reducedMotion: boolean; textStyle: StyleProp<TextStyle>; h?: number }) {
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

/** One weekday cell in the 7-day row. Today's cell lights up in the Japanese accent
 * once it holds minutes, with a soft one-time glow the moment it first crosses from
 * zero, not on mount. */
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

/** First day of each streak tier: the gem's look changes for good once a streak reaches it. */
const TIER_FLOORS = [1, ...MILESTONE_DAYS];
/** The gem tier for a streak: 0 with no streak, 1 from day 1, up to 10 from day 1000. */
export function streakTier(days: number): number {
  return TIER_FLOORS.filter((floor) => days >= floor).length;
}
/** The gem's wings and glows reach the card's side: the column's 20 around the 100 box plus the card padding. */
const GEM_CLIP = 20 + Spacing.lg;
export const EMBER = '#FFB36B';

/** A radial ember fade: the mocks' blurred glow disc, drawn in Skia. */
export function EmberGlow({ size, colors, positions }: { size: number; colors: string[]; positions: number[] }) {
  const r = size / 2;
  return (
    <View pointerEvents="none" style={{ position: 'absolute', width: size, height: size }}>
      <Canvas style={{ width: size, height: size }}>
        <Circle cx={r} cy={r} r={r}>
          <RadialGradient c={vec(r, r)} r={r} colors={colors} positions={positions} />
        </Circle>
      </Canvas>
    </View>
  );
}

/** Home's streak column: the gem with the day count in it, the label (with a check once today counts) and the keep-it nudge. */
function StreakFlame({ log, onPress }: { log: PracticeLog; onPress?: () => void }) {
  const { t } = useT();
  const dir = useDir();
  const today = new Date();
  const streak = streakDays(log, today);
  const done = dayQualifies(log, dayKey(today));
  const lit = streak > 0;
  const label = lit ? t('home.streakDays', { n: streak }) : t('home.streakStart');
  const nudge = lit && !done ? t('home.streakKeep') : null;
  return (
    <PressScale
      onPress={onPress}
      style={styles.flameCol}
      accessibilityRole="button"
      accessibilityLabel={nudge ? `${label}. ${nudge}` : label}>
      <View style={styles.flameRow}>
        <StreakGem size={64} streak={streak} tier={streakTier(streak)} clipSides={GEM_CLIP} />
      </View>
      <View style={[styles.flameLabelRow, dir.row]}>
        <Text style={[styles.flameLabel, { color: tide.textDim }]}>{label}</Text>
        {lit && done ? (
          <View style={styles.check}>
            <Text style={styles.checkGlyph}>✓</Text>
          </View>
        ) : null}
      </View>
      {nudge ? <Text style={styles.nudge} numberOfLines={1}>{nudge}</Text> : null}
    </PressScale>
  );
}

export function PracticeCard({ log, dueCount, onPractice, onDrive, onStreak }: { log: PracticeLog; dueCount: number | null; onPractice: () => void; onDrive: () => void; onStreak?: () => void }) {
  const { t } = useT();
  const dir = useDir();
  const reducedMotion = useReducedMotion();
  // The goal is read here rather than passed down, so Home does not have to
  // thread it through: the subscription picks up a change made in onboarding
  // while this card is already mounted.
  const [goal, setGoal] = useState(() => getSettingsSync().dailyGoalMinutes);
  useEffect(() => subscribeSettings(() => setGoal(getSettingsSync().dailyGoalMinutes)), []);
  const today = new Date();
  const todayKey = dayKey(today);
  const todayMinutes = minutesOn(log, todayKey);
  const goalMet = todayMinutes >= goal;
  const week = lastSevenDays(today);

  return (
    <View style={StyleSheet.flatten([styles.card, { backgroundColor: tide.water, borderColor: tide.waterline }])}>
      <View style={[styles.numbers, dir.row]}>
        <StreakFlame log={log} onPress={onStreak} />
        <View style={styles.divider} />
        <View style={styles.stat}>
          {/* Not `dir.row`: "1/10" is one number pair and keeps its order in
              every language, the way a clock or a score does. */}
          <View style={styles.todayValue}>
            <Odometer
              value={todayMinutes}
              reducedMotion={reducedMotion}
              textStyle={[styles.value, { color: goalMet ? tide.lang.ja : tide.text }]}
            />
            <Text style={[styles.target, { color: goalMet ? tide.lang.ja : tide.textDim }]}>
              {t('home.practiceGoal', { goal })}
            </Text>
          </View>
          <Text style={[styles.label, { color: tide.textDim }]}>{t('home.practiceToday')}</Text>
        </View>
        <View style={styles.stat}>
          {dueCount == null ? (
            <Text style={[styles.value, styles.digitText, { color: tide.textDim }]}>·</Text>
          ) : (
            <Odometer value={dueCount} reducedMotion={reducedMotion} textStyle={[styles.value, { color: tide.text }]} />
          )}
          <Text style={[styles.label, { color: tide.textDim }]}>{t('home.dueToday')}</Text>
        </View>
      </View>
      <View style={[styles.week, dir.row]}>
        {week.map((key) => (
          <DayCell
            key={key}
            letter={t(WEEKDAY_KEY[new Date(`${key}T12:00:00`).getDay()])}
            minutes={minutesOn(log, key)}
            isToday={key === todayKey}
            reducedMotion={reducedMotion}
          />
        ))}
      </View>
      <View style={[styles.actions, dir.row]}>
        <PrismButton
          shape="pill"
          verb="speak"
          height={44}
          label={t('home.practiceNow')}
          onPress={onPractice}
          containerStyle={{ flex: 1 }}
          style={{ alignSelf: 'stretch', justifyContent: 'center' }}>
          <SymbolView name={{ ios: 'play.fill', android: 'play_arrow' }} size={16} weight="regular" tintColor={verb.speak.c1} />
        </PrismButton>
        <PrismButton shape="pill" verb="listen" height={44} label={t('home.drive')} onPress={onDrive} containerStyle={{ marginStart: Spacing.sm }}>
          <SymbolView name={{ ios: 'car.fill', android: 'directions_car' }} size={16} weight="regular" tintColor={verb.listen.c1} />
        </PrismButton>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  card: { borderWidth: 1, borderRadius: Radius.md, padding: Spacing.lg, gap: Spacing.md },
  numbers: { flexDirection: 'row', alignItems: 'center' },
  divider: { width: 1, alignSelf: 'stretch', backgroundColor: 'rgba(255,255,255,0.12)', marginVertical: 4, marginHorizontal: 8 },
  flameCol: { width: 140, alignItems: 'center', gap: 4 },
  flameRow: { alignItems: 'center', marginTop: 10, marginBottom: 6 },
  flameLabelRow: { flexDirection: 'row', alignItems: 'center', gap: 4 },
  flameLabel: { fontSize: 12, lineHeight: 14, fontWeight: '600', fontFamily: fonts.ui, textAlign: 'center' },
  check: { width: 18, height: 18, borderRadius: 9, backgroundColor: EMBER, alignItems: 'center', justifyContent: 'center' },
  checkGlyph: { color: '#08131C', fontSize: 12, fontWeight: '800', lineHeight: 14 },
  nudge: { fontSize: 11, lineHeight: 13, fontWeight: '600', fontFamily: fonts.ui, color: EMBER, textAlign: 'center' },
  actions: { flexDirection: 'row', alignItems: 'center' },
  stat: { alignItems: 'center', flex: 1 },
  value: { fontSize: 28, fontWeight: '700', fontFamily: fonts.ui },
  label: { fontSize: 13, fontWeight: '600', fontFamily: fonts.ui },
  odometerRow: { flexDirection: 'row' },
  // flex-end, not baseline: a rolling digit is a clipped View, so a baseline
  // row would shift the target text while the odometer animates.
  todayValue: { flexDirection: 'row', alignItems: 'flex-end' },
  target: { fontSize: 13, fontWeight: '600', fontFamily: fonts.ui, paddingBottom: 4 },
  digitClip: { overflow: 'hidden' },
  digitText: { height: DIGIT_HEIGHT, lineHeight: DIGIT_HEIGHT },
  week: { flexDirection: 'row', justifyContent: 'space-between' },
  day: { alignItems: 'center', gap: 2, minWidth: 20, position: 'relative' },
  dayGlow: { position: 'absolute', top: -4, bottom: -4, left: -6, right: -6, borderRadius: Radius.md, backgroundColor: tide.lang.ja },
  dayLetter: { fontSize: 12, fontWeight: '600', fontFamily: fonts.ui },
  dayValue: { fontSize: 13, fontFamily: fonts.ui },
});
