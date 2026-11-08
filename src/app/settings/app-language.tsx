import { useFocusEffect } from 'expo-router';
import { useCallback, useState } from 'react';
import { ScrollView, StyleSheet, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { LanguageCard } from '@/components/language-card';
import { SettingsSection } from '@/components/tide/settings-row';
import { Spacing, tide } from '@/constants/theme';
import { APP_LANGUAGE_REGIONS, COMPLETE_LANGS } from '@/lib/app-languages';
import { LOCALES, useT } from '@/lib/i18n';
import { getLanguage } from '@/lib/languages';
import { applyAppLanguage } from '@/lib/language-sync';
import { type AppLanguage, getSettings } from '@/lib/settings';

/**
 * One card to follow the understood language, then one per finished language
 * (variant F of research/app-language-picker). Native names are always shown
 * in their own script (never translated), and a tap writes straight to
 * settings, no confirm step: the whole app re-renders through `useT()` as soon
 * as it does. A pick that would split the interface from the understood
 * language asks about that afterwards (see `applyAppLanguage`); the pick
 * itself is never held up by the question.
 */
export default function AppLanguageScreen() {
  const { t } = useT();
  const [current, setCurrentState] = useState<AppLanguage>('auto');

  useFocusEffect(
    useCallback(() => {
      let alive = true;
      void getSettings().then((s) => {
        if (!alive) return;
        setCurrentState(s.appLanguage);
      });
      return () => {
        alive = false;
      };
    }, []),
  );

  function pick(next: AppLanguage) {
    setCurrentState(next);
    void applyAppLanguage(next);
  }

  const auto = t('settings.appLanguageAuto');

  return (
    <SafeAreaView edges={['bottom']} style={StyleSheet.flatten([styles.fill, { backgroundColor: tide.sky[0] }])}>
      <ScrollView contentContainerStyle={styles.list}>
        <SettingsSection title={t('settings.appLanguage')}>
          <View>
            <LanguageCard
              avatar="🌐"
              title={auto}
              selected={current === 'auto'}
              label={auto}
              onPress={() => pick('auto')}
            />
            {COMPLETE_LANGS.map((code) => {
              const english = getLanguage(code)?.english ?? code;
              return (
                <LanguageCard
                  key={code}
                  avatar={getLanguage(code)?.flag ?? ''}
                  title={LOCALES[code].native}
                  subtitle={english}
                  chips={APP_LANGUAGE_REGIONS[code]}
                  selected={current === code}
                  label={`${LOCALES[code].native}, ${english}`}
                  onPress={() => pick(code)}
                />
              );
            })}
          </View>
        </SettingsSection>
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1 },
  list: { padding: Spacing.lg },
});
