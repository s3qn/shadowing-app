import { useFocusEffect } from 'expo-router';
import { useCallback, useState } from 'react';
import { ScrollView, StyleSheet, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { PrismButton } from '@/components/prism';
import { SettingsSection } from '@/components/tide/settings-row';
import { Spacing, tide } from '@/constants/theme';
import {
  getSettings,
  LEARNING_LANGUAGE_OPTIONS,
  type LearningLanguage,
  setLearningLanguage,
  setUnderstoodLanguage,
  UNDERSTOOD_LANGUAGE_OPTIONS,
  type UnderstoodLanguage,
} from '@/lib/settings';

const LEARN_LABEL: Record<LearningLanguage, string> = { ja: 'Japanese', es: 'Spanish', en: 'English' };
const UNDERSTAND_LABEL: Record<UnderstoodLanguage, string> = { he: 'Hebrew', en: 'English' };

/**
 * The two language pickers, same disabled-pair rule as onboarding's
 * languages step: understanding English cannot pair with learning English.
 * Writes each pick straight to settings, no confirm step.
 */
export default function LanguagesSettingsScreen() {
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
    // English can only pair with Hebrew as the understood language: force it
    // rather than let the invalid pair happen and error later.
    if (next === 'en' && understand === 'en') {
      setUnderstandState('he');
      void setUnderstoodLanguage('he');
    }
  }

  function pickUnderstand(next: UnderstoodLanguage) {
    if (learning === 'en' && next === 'en') return;
    setUnderstandState(next);
    void setUnderstoodLanguage(next);
  }

  return (
    <SafeAreaView edges={['bottom']} style={StyleSheet.flatten([styles.fill, { backgroundColor: tide.sky[0] }])}>
      <ScrollView contentContainerStyle={styles.list}>
        <SettingsSection title="I want to learn">
          <View style={styles.row}>
            {LEARNING_LANGUAGE_OPTIONS.map((opt) => (
              <PrismButton
                key={opt}
                shape="pill"
                verb="read"
                flat
                label={LEARN_LABEL[opt]}
                on={learning === opt}
                onPress={() => pickLearning(opt)}
              />
            ))}
          </View>
        </SettingsSection>

        <SettingsSection title="I understand">
          <View style={styles.row}>
            {UNDERSTOOD_LANGUAGE_OPTIONS.map((opt) => (
              <PrismButton
                key={opt}
                shape="pill"
                verb="read"
                flat
                label={UNDERSTAND_LABEL[opt]}
                on={understand === opt}
                disabled={learning === 'en' && opt === 'en'}
                onPress={() => pickUnderstand(opt)}
              />
            ))}
          </View>
        </SettingsSection>
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1 },
  list: { padding: Spacing.lg, gap: Spacing.lg },
  row: { flexDirection: 'row', flexWrap: 'wrap', gap: Spacing.sm, padding: Spacing.md },
});
