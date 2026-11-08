/**
 * Home's stat row (variant E of the compact mocks): three 34pt chips, the
 * streak flame and count (tap opens the Streak sheet), today's
 * minutes against the daily goal, and what is due. Today's minutes and the due
 * count roll like an odometer when they go up and show instantly on first
 * mount. `dueCount` null means still loading: the chip shows a dim dot.
 */

import { useEffect, useState, type ReactNode } from 'react';
import { StyleSheet, Text, useWindowDimensions, View } from 'react-native';
import { useReducedMotion } from 'react-native-reanimated';

import { Odometer } from '@/components/home/odometer';
import { WeekRow } from '@/components/home/week-row';
import { PressScale } from '@/components/press-scale';
import { StreakFlame } from '@/components/home/streak-flame';
import { fonts } from '@/constants/fonts';
import { useDir, useT } from '@/lib/i18n';
import { dayKey, minutesOn, streakDays, type PracticeLog } from '@/lib/practice';
import { useBetaFeatures } from '@/lib/beta';
import { getSettingsSync, subscribeSettings } from '@/lib/settings';

const CHIP_H = 34;
const NUM = { fontSize: 16, fontWeight: '700', fontFamily: fonts.ui, color: '#FFFFFF' } as const;

function Chip({ children, onPress, label }: { children: ReactNode; onPress?: () => void; label?: string }) {
  const dir = useDir();
  const body = <View style={[styles.chip, dir.row]}>{children}</View>;
  if (!onPress) return body;
  return (
    <PressScale onPress={onPress} accessibilityRole="button" accessibilityLabel={label}>
      {body}
    </PressScale>
  );
}

/** Without `onStreak` the gem chip is not drawn. */
export function StatsChips({ log, dueCount, onStreak }: { log: PracticeLog; dueCount: number | null; onStreak?: () => void }) {
  const { t } = useT();
  const dir = useDir();
  const { width } = useWindowDimensions();
  const reducedMotion = useReducedMotion();
  const beta = useBetaFeatures().beta;
  // The goal is read here so Home does not thread it through: the
  // subscription picks up a change made while Home is mounted.
  const [goal, setGoal] = useState(() => getSettingsSync().dailyGoalMinutes);
  useEffect(() => subscribeSettings(() => setGoal(getSettingsSync().dailyGoalMinutes)), []);
  const today = new Date();
  const streak = streakDays(log, today);
  const minutes = minutesOn(log, dayKey(today));
  // Below 340pt the labels give way to the numbers.
  const labels = width >= 340;
  const label = (key: 'home.practiceToday' | 'home.dueShort') =>
    labels ? (
      <Text style={styles.label} numberOfLines={1}>
        {t(key)}
      </Text>
    ) : null;

  return (
    <View style={[styles.row, !beta && styles.rowFirst, dir.row]}>
      {onStreak ? (
        <Chip onPress={onStreak} label={t('home.streakDays', { n: streak })}>
          <StreakFlame streak={streak} />
          <Text style={NUM}>{streak}</Text>
        </Chip>
      ) : null}
      <Chip>
        <View style={[styles.inner, dir.row]}>
          {label('home.practiceToday')}
          {/* Not `dir.row`: "1/10" is one number pair and keeps its order in every language. */}
          <View style={styles.pair}>
            <Odometer value={minutes} reducedMotion={reducedMotion} textStyle={NUM} h={20} />
            <Text style={styles.goal}>{t('home.practiceGoal', { goal })}</Text>
          </View>
        </View>
      </Chip>
      <Chip>
        <View style={[styles.inner, dir.row]}>
          {label('home.dueShort')}
          {dueCount == null ? (
            <Text style={[NUM, styles.dimText]}>·</Text>
          ) : (
            <Odometer value={dueCount} reducedMotion={reducedMotion} textStyle={NUM} h={20} />
          )}
        </View>
      </Chip>
      {/* Non-beta (variant H): the seven-dot week at the far end, nothing to open. */}
      {beta ? null : (
        <View style={[styles.strip, dir.row]}>
          <WeekRow log={log} dots />
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  // Under the profile pill (beta) Home's column gap sets the spacing; first
  // in the column (non-beta) the row keeps its own 10pt top margin.
  row: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  rowFirst: { marginTop: 10 },
  chip: {
    flexShrink: 1,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    height: CHIP_H,
    paddingHorizontal: 12,
    borderRadius: CHIP_H / 2,
    backgroundColor: 'rgba(255,255,255,0.08)',
    // The prism edge at chip weight: pink left, blue right, a pale top lip.
    borderLeftWidth: 1,
    borderRightWidth: 1,
    borderTopWidth: 1,
    borderLeftColor: 'rgba(255,70,110,0.22)',
    borderRightColor: 'rgba(70,170,255,0.28)',
    borderTopColor: 'rgba(255,255,255,0.22)',
    borderBottomColor: 'transparent',
  },
  strip: { flex: 1, flexDirection: 'row', justifyContent: 'flex-end' },
  inner: { flexShrink: 1, flexDirection: 'row', alignItems: 'center', gap: 6 },
  label: { flexShrink: 1, fontSize: 13, color: '#CFD8DE', fontFamily: fonts.ui },
  pair: { flexDirection: 'row', alignItems: 'flex-end' },
  goal: { fontSize: 11, color: '#9AA6B0', fontFamily: fonts.ui, paddingBottom: 2 },
  dimText: { opacity: 0.5, height: 20, lineHeight: 20 },
});
