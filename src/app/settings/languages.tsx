import { useFocusEffect } from 'expo-router';
import { useCallback, useState } from 'react';
import { ScrollView, StyleSheet, Text } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { LanguagePicker } from '@/components/language-picker';
import { fonts } from '@/constants/fonts';
import { Spacing, tide } from '@/constants/theme';
import { useDir, useT } from '@/lib/i18n';
import { applyUnderstoodLanguage } from '@/lib/language-sync';
import { LANGUAGES } from '@/lib/languages';
import {
  getSettings,
  type LearningLanguage,
  setLearningLanguage,
  setUnderstoodLanguage,
  type UnderstoodLanguage,
} from '@/lib/settings';

/**
 * The two language pickers, same disabled-pair rule as onboarding's
 * languages step: understanding a language cannot pair with learning the
 * same one. Writes each pick straight to settings, no confirm step. Each
 * picker is `inline` (plain rows, the catalogue is short) and the page
 * scrolls as one: two fixed halves, each its own list, cut the learn list's
 * Coming soon rows off flush against the understand section (ET-12).
 */
export default function LanguagesSettingsScreen() {
  const { t } = useT();
  const dir = useDir();
  const [learning, setLearningState] = useState<LearningLanguage>('ja');
  const [understand, setUnderstandState] = useState<UnderstoodLanguage>('en');

  useFocusEffect(
    useCallback(() => {
      let alive = true;
      void getSettings().then((s) => {
        if (!alive) return;
        setLearningState(s.learningLanguage);
        setUnderstandState(s.understoodLanguage);
      });
      return () => {
        alive = false;
      };
    }, []),
  );

  function pickLearning(next: LearningLanguage) {
    setLearningState(next);
    void setLearningLanguage(next);
    // The understand picker hides whatever is picked here, so a collision
    // would leave it with nothing ticked: move it to another understandable
    // language rather than let that happen.
    if (next === understand) {
      const fallback = LANGUAGES.find((l) => l.understandable && l.id !== next);
      if (fallback) {
        setUnderstandState(fallback.id);
        // The plain setter, not `applyUnderstoodLanguage`: this move is the
        // pair rule's, not the learner's, and a question about a language
        // they did not just tap would come out of nowhere.
        void setUnderstoodLanguage(fallback.id);
      }
    }
  }

  function pickUnderstand(next: UnderstoodLanguage) {
    setUnderstandState(next);
    // Writes the pick, then asks about the interface language if this is the
    // moment the two part (see `applyUnderstoodLanguage`).
    void applyUnderstoodLanguage(next);
  }

  return (
    <SafeAreaView edges={['bottom']} style={StyleSheet.flatten([styles.fill, { backgroundColor: tide.sky[0] }])}>
      <ScrollView style={styles.fill} keyboardShouldPersistTaps="handled">
        <Text style={[styles.label, dir.text, dir.rtl && styles.labelRtl]}>{t('settings.languages.learn')}</Text>
        <LanguagePicker inline mode="learn" value={learning} onChange={pickLearning} exclude={understand} />
        <Text style={[styles.label, dir.text, dir.rtl && styles.labelRtl]}>{t('settings.languages.understand')}</Text>
        <LanguagePicker inline mode="understand" value={understand} onChange={pickUnderstand} exclude={learning} />
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1 },
  label: {
    fontSize: 12,
    fontFamily: fonts.uiMedium,
    fontWeight: '500',
    textTransform: 'uppercase',
    letterSpacing: 0.5,
    color: tide.textDim,
    marginLeft: Spacing.lg + Spacing.sm,
    marginTop: Spacing.sm,
    marginBottom: Spacing.xs,
  },
  labelRtl: { marginLeft: 0, marginRight: Spacing.lg + Spacing.sm },
});
