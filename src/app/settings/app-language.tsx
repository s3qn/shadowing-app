import { useFocusEffect } from 'expo-router';
import { useCallback, useState } from 'react';
import { StyleSheet, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { PrismButton } from '@/components/prism';
import { SettingsSection } from '@/components/tide/settings-row';
import { Spacing, tide } from '@/constants/theme';
import { LOCALES, useT } from '@/lib/i18n';
import { applyAppLanguage } from '@/lib/language-sync';
import { type AppLanguage, getSettings } from '@/lib/settings';

/**
 * Three pills: follow the understood language, or pin English or Hebrew.
 * Native names are always shown in their own script (never translated), and
 * a tap writes straight to settings, no confirm step: the whole app
 * re-renders through `useT()` as soon as it does. A pick that would split
 * the interface from the understood language asks about that afterwards
 * (see `applyAppLanguage`); the pick itself is never held up by the question.
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

  return (
    <SafeAreaView edges={['bottom']} style={StyleSheet.flatten([styles.fill, { backgroundColor: tide.sky[0] }])}>
      <View style={styles.list}>
        <SettingsSection title={t('settings.appLanguage')}>
          <View style={styles.pills}>
            <PrismButton shape="pill" verb="read" flat on={current === 'auto'} label={t('settings.appLanguageAuto')} onPress={() => pick('auto')} />
            <PrismButton shape="pill" verb="read" flat on={current === 'en'} label={LOCALES.en.native} onPress={() => pick('en')} />
            <PrismButton shape="pill" verb="read" flat on={current === 'he'} label={LOCALES.he.native} onPress={() => pick('he')} />
          </View>
        </SettingsSection>
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1 },
  list: { padding: Spacing.lg },
  pills: { gap: Spacing.sm },
});
