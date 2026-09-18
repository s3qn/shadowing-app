/**
 * The daily goal step's three rows (artifact `s4`): a minute count on the
 * leading side, a grey hint on the trailing side, one of them lit. The pick
 * is stored as `dailyGoalMinutes` and Home shows it as today's target.
 */

import { StyleSheet, Text, View } from 'react-native';

import { PressScale } from '@/components/press-scale';
import { fonts } from '@/constants/fonts';
import { Radius, Spacing, tide, withAlpha } from '@/constants/theme';
import { useDir, useT } from '@/lib/i18n';
import { DAILY_GOAL_OPTIONS, type DailyGoalMinutes } from '@/lib/settings';
import { type Key } from '@/locales/en';

const HINT_KEY: Record<DailyGoalMinutes, Key> = {
  5: 'settings.onboarding.goalHint5',
  10: 'settings.onboarding.goalHint10',
  20: 'settings.onboarding.goalHint20',
};

export function GoalOptions({
  value,
  onChange,
}: {
  value: DailyGoalMinutes;
  onChange: (minutes: DailyGoalMinutes) => void;
}) {
  const { t } = useT();
  const dir = useDir();

  return (
    <View style={styles.group}>
      {DAILY_GOAL_OPTIONS.map((minutes) => {
        const on = minutes === value;
        return (
          <PressScale
            key={minutes}
            onPress={() => onChange(minutes)}
            style={[styles.option, dir.row, on ? styles.optionOn : null]}
          >
            <Text style={[styles.title, dir.text, on ? styles.titleOn : null]}>
              {t('settings.onboarding.goalMinutes', { n: minutes })}
            </Text>
            <Text style={[styles.hint, on ? styles.hintOn : null]}>{t(HINT_KEY[minutes])}</Text>
          </PressScale>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  group: { gap: Spacing.sm },
  option: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: Spacing.md,
    paddingVertical: 13,
    paddingHorizontal: Spacing.lg,
    borderRadius: Radius.lg,
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.10)',
    backgroundColor: 'rgba(255,255,255,0.05)',
  },
  optionOn: {
    borderColor: withAlpha(tide.listen, 0.65),
    backgroundColor: withAlpha(tide.listen, 0.22),
  },
  title: {
    flex: 1,
    fontSize: 16,
    fontWeight: '600',
    color: tide.text,
    fontFamily: fonts.uiMedium,
  },
  titleOn: { color: tide.text },
  hint: { fontSize: 13, color: tide.textDim, fontFamily: fonts.ui },
  hintOn: { color: withAlpha(tide.listen, 0.9) },
});
