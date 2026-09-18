import { useFocusEffect, useRouter } from 'expo-router';
import { useCallback, useState } from 'react';
import { ScrollView, StyleSheet } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { PILL_TAB_BAR_REACH } from '@/components/pill-tab-bar';
import { SettingsRow, SettingsSection } from '@/components/tide/settings-row';
import { Spacing, prism, tide } from '@/constants/theme';
import * as api from '@/lib/api';
import { LOCALES, type Lang, useT } from '@/lib/i18n';
import { type AppLanguage, getSettings, getVoice, setHaptics, setShowAllLanguages, setSkyAlwaysNight, toIslandLanguage } from '@/lib/settings';

export default function SettingsScreen() {
  const router = useRouter();
  const { t } = useT();
  const [voiceName, setVoiceName] = useState('');
  const [haptics, setHapticsState] = useState(true);
  const [skyAlwaysNight, setSkyAlwaysNightState] = useState(false);
  // languages: Home's show-all toggle, default off.
  const [showAllLanguages, setShowAllLanguagesState] = useState(false);
  const [appLanguage, setAppLanguageState] = useState<AppLanguage>('auto');

  useFocusEffect(
    useCallback(() => {
      let alive = true;
      (async () => {
        // Read independently of the speaker list: that call needs the
        // backend and can fail or hang offline, and coupling it to
        // Promise.all used to leave the switches showing defaults (so a tap
        // saved the wrong flip) whenever it did.
        const settings = await getSettings();
        if (!alive) return;
        setHapticsState(settings.hapticsEnabled);
        setSkyAlwaysNightState(settings.skyAlwaysNight);
        setShowAllLanguagesState(settings.showAllLanguages);
        setAppLanguageState(settings.appLanguage);

        try {
          const [speakers, voiceId] = await Promise.all([
            api.listSpeakers(toIslandLanguage(settings.learningLanguage)),
            getVoice(settings.learningLanguage),
          ]);
          if (!alive) return;
          const speaker = speakers.find((sp) => sp.styles.some((st) => st.id === voiceId));
          const style = speaker?.styles.find((st) => st.id === voiceId);
          setVoiceName(speaker && style ? `${speaker.name} ${style.name}` : '');
        } catch {
          // Voice list needs the backend; the row still works without a name shown.
        }
      })();
      return () => {
        alive = false;
      };
    }, []),
  );

  return (
    <SafeAreaView edges={['bottom']} style={StyleSheet.flatten([styles.fill, { backgroundColor: tide.sky[0] }])}>
      <ScrollView contentContainerStyle={styles.list}>
        <SettingsSection title={t('settings.section.practice')}>
          <SettingsRow
            label={t('settings.row.practice')}
            last
            icon={{ ios: 'book.closed', android: 'menu_book' }}
            onPress={() => router.push('/settings/practice')}
          />
        </SettingsSection>

        <SettingsSection title={t('settings.section.playback')}>
          <SettingsRow
            label={t('settings.row.playback')}
            last
            icon={{ ios: 'gauge', android: 'speed' }}
            onPress={() => router.push('/settings/playback')}
          />
        </SettingsSection>

        <SettingsSection title={t('settings.section.voice')}>
          <SettingsRow
            label={t('settings.row.voice')}
            value={voiceName}
            last
            icon={{ ios: 'person.wave.2', android: 'record_voice_over' }}
            onPress={() => router.push('/settings/voice')}
          />
        </SettingsSection>

        <SettingsSection title={t('settings.section.language')}>
          <SettingsRow
            label={t('settings.row.languages')}
            icon={{ ios: 'globe', android: 'language' }}
            onPress={() => router.push('/settings/languages')}
          />
          {/* languages: Home shows every language's islands when on. */}
          <SettingsRow
            label={t('settings.row.showAllLanguages')}
            icon={{ ios: 'globe', android: 'language' }}
            switchValue={showAllLanguages}
            onSwitchChange={(next) => {
              setShowAllLanguagesState(next);
              void setShowAllLanguages(next);
            }}
          />
          <SettingsRow
            label={t('settings.appLanguage')}
            value={appLanguage === 'auto' ? t('settings.appLanguageAuto') : (LOCALES[appLanguage as Lang]?.native ?? t('settings.appLanguageAuto'))}
            last
            icon={{ ios: 'textformat', android: 'translate' }}
            onPress={() => router.push('/settings/app-language')}
          />
        </SettingsSection>

        <SettingsSection title={t('settings.section.appearance')}>
          <SettingsRow
            label={t('settings.row.haptics')}
            icon={{ ios: 'iphone.radiowaves.left.and.right', android: 'vibration' }}
            switchValue={haptics}
            onSwitchChange={(next) => {
              setHapticsState(next);
              void setHaptics(next);
            }}
          />
          <SettingsRow
            label={t('settings.row.alwaysNightSky')}
            last
            icon={{ ios: 'moon.stars', android: 'nightlight' }}
            switchValue={skyAlwaysNight}
            onSwitchChange={(next) => {
              setSkyAlwaysNightState(next);
              void setSkyAlwaysNight(next);
            }}
          />
        </SettingsSection>

        <SettingsSection title={t('settings.section.data')}>
          <SettingsRow
            label={t('settings.row.data')}
            last
            icon={{ ios: 'internaldrive', android: 'storage' }}
            onPress={() => router.push('/settings/data')}
          />
        </SettingsSection>

        <SettingsSection title={t('settings.section.about')}>
          <SettingsRow
            label={t('settings.row.about')}
            icon={{ ios: 'info.circle', android: 'info' }}
            onPress={() => router.push('/settings/about')}
          />
          <SettingsRow
            label={t('settings.row.replayOnboarding')}
            last={!__DEV__}
            icon={{ ios: 'arrow.counterclockwise', android: 'replay' }}
            onPress={() => router.push('/onboarding')}
          />
          {/* Dev-only row, excluded from the app-language inventory. */}
          {__DEV__ ? (
            <SettingsRow
              label="Prism lab"
              last
              icon={{ ios: 'sparkles', android: 'auto_awesome' }}
              onPress={() => router.push('/prism-lab')}
            />
          ) : null}
        </SettingsSection>

        <SettingsSection title={t('settings.section.feedback')}>
          <SettingsRow
            label={t('settings.row.suggest')}
            last
            icon={{ ios: 'lightbulb', android: 'lightbulb' }}
            onPress={() => router.push('/settings/suggest')}
          />
        </SettingsSection>
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1 },
  // paddingBottom leaves room for the floating pill tab bar and the offset
  // pane that peeks out past its bottom edge, so the last row never hides
  // under it.
  list: { padding: Spacing.lg, gap: Spacing.lg, paddingBottom: Spacing.lg + PILL_TAB_BAR_REACH + prism.tray.pane.dy },
});
