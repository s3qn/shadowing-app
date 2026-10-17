import { useFocusEffect } from 'expo-router';
import { useCallback, useState } from 'react';
import { ScrollView, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { Segmented } from '@/components/segmented';
import { SettingsRow, SettingsSection } from '@/components/tide/settings-row';
import { Spacing, tide } from '@/constants/theme';
import { useT } from '@/lib/i18n';
import { type Key } from '@/locales/en';
import {
  getSettings,
  READING_OPTIONS,
  setBlind,
  setHideEnglish,
  setPitch,
  setReading,
  toIslandLanguage,
  type ReadingMode,
} from '@/lib/settings';

const READING_LABEL_KEY: Record<ReadingMode, Key> = {
  off: 'settings.practice.readingOff',
  furigana: 'settings.practice.readingFurigana',
  kana: 'settings.practice.readingKana',
  romaji: 'settings.practice.readingRomaji',
};

export default function PracticeSettingsScreen() {
  const { t } = useT();
  const [reading, setReadingState] = useState<ReadingMode>('furigana');
  const [pitch, setPitchState] = useState(true);
  const [hideEnglish, setHideEnglishState] = useState(false);
  const [blind, setBlindState] = useState(false);
  // Furigana, Kana, Romaji and pitch marks are Japanese-only concepts: hidden
  // for any other learning language, same as the Style row in record.tsx.
  const [isJapanese, setIsJapanese] = useState(true);

  useFocusEffect(
    useCallback(() => {
      let alive = true;
      void getSettings().then((s) => {
        if (!alive) return;
        setReadingState(s.reading);
        setPitchState(s.pitch);
        setHideEnglishState(s.hideEnglish);
        setBlindState(s.blind);
        setIsJapanese(toIslandLanguage(s.learningLanguage) === 'ja');
      });
      return () => {
        alive = false;
      };
    }, []),
  );

  const readingChoices = READING_OPTIONS.map((opt) => ({ value: opt, label: t(READING_LABEL_KEY[opt]) }));

  async function pickReading(next: ReadingMode) {
    setReadingState(next);
    await setReading(next);
  }

  return (
    <SafeAreaView edges={['bottom']} style={StyleSheet.flatten([styles.fill, { backgroundColor: tide.sky[0] }])}>
      <ScrollView contentContainerStyle={styles.list}>
        {isJapanese ? (
          <SettingsSection title={t('settings.practice.reading')} footnote={t('settings.playback.defaultFootnote')}>
            <View style={styles.segBox}>
              <Segmented
                options={readingChoices}
                value={reading}
                onChange={(next) => void pickReading(next)}
              />
            </View>
          </SettingsSection>
        ) : null}

        <SettingsSection title={t('settings.practice.defaults')} footnote={t('settings.playback.defaultFootnote')}>
          {isJapanese ? (
            <SettingsRow
              label={t('settings.practice.pitchMarks')}
              icon={{ ios: 'textformat', android: 'text_fields' }}
              switchValue={pitch}
              onSwitchChange={(next) => {
                setPitchState(next);
                void setPitch(next);
              }}
            />
          ) : null}
          <SettingsRow
            label={t('settings.practice.hideEnglish')}
            icon={{ ios: 'text.badge.xmark', android: 'subtitles_off' }}
            switchValue={hideEnglish}
            onSwitchChange={(next) => {
              setHideEnglishState(next);
              void setHideEnglish(next);
            }}
          />
          <SettingsRow
            label={t('settings.practice.blindByDefault')}
            last
            icon={{ ios: 'eye.slash', android: 'visibility_off' }}
            switchValue={blind}
            onSwitchChange={(next) => {
              setBlindState(next);
              void setBlind(next);
            }}
          />
        </SettingsSection>
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1 },
  list: { padding: Spacing.lg, gap: Spacing.lg, paddingBottom: 170 },
  segBox: { padding: Spacing.md },
});
