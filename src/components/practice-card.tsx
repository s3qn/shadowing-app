/**
 * The Home screen's practice summary: today's minutes, the current streak,
 * and the last 7 days as a row of weekday letters over their minutes.
 */

import { StyleSheet, Text, View } from 'react-native';

import { fonts } from '@/constants/fonts';
import { Radius, Spacing, tide } from '@/constants/theme';
import { dayKey, lastSevenDays, minutesOn, streakDays, type PracticeLog } from '@/lib/practice';

export function PracticeCard({ log }: { log: PracticeLog }) {
  const today = new Date();
  const todayMinutes = minutesOn(log, dayKey(today));
  const streak = streakDays(log, today);
  const week = lastSevenDays(today);

  return (
    <View style={StyleSheet.flatten([styles.card, { backgroundColor: tide.water, borderColor: tide.waterline }])}>
      <View style={styles.numbers}>
        <View style={styles.stat}>
          <Text style={[styles.value, { color: tide.text }]}>{todayMinutes}</Text>
          <Text style={[styles.label, { color: tide.textDim }]}>Today</Text>
        </View>
        <View style={styles.stat}>
          <Text style={[styles.value, { color: tide.text }]}>{streak}</Text>
          <Text style={[styles.label, { color: tide.textDim }]}>Streak</Text>
        </View>
      </View>
      <View style={styles.week}>
        {week.map((key) => {
          const minutes = minutesOn(log, key);
          const letter = new Date(`${key}T12:00:00`).toLocaleDateString(undefined, { weekday: 'narrow' });
          return (
            <View key={key} style={styles.day}>
              <Text style={[styles.dayLetter, { color: tide.textDim }]}>{letter}</Text>
              <Text style={[styles.dayValue, { color: tide.text }]}>{minutes > 0 ? minutes : '·'}</Text>
            </View>
          );
        })}
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
  week: { flexDirection: 'row', justifyContent: 'space-between' },
  day: { alignItems: 'center', gap: 2, minWidth: 20 },
  dayLetter: { fontSize: 12, fontWeight: '600', fontFamily: fonts.ui },
  dayValue: { fontSize: 13, fontFamily: fonts.ui },
});
