import * as Clipboard from 'expo-clipboard';
import Constants from 'expo-constants';
import { useEffect, useRef, useState } from 'react';
import { ScrollView, StyleSheet } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { SettingsRow, SettingsSection } from '@/components/tide/settings-row';
import { Spacing, tide } from '@/constants/theme';
import { deviceIdSync } from '@/lib/device';
import { useT } from '@/lib/i18n';

/** Row that copies the device id on tap and shows the full value in place
 * for two seconds before reverting to the short form. */
function DeviceIdRow() {
  const { t } = useT();
  const id = deviceIdSync();
  const short = id ? id.slice(0, 8) : t('settings.about.unknown');
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    return () => {
      if (timer.current) clearTimeout(timer.current);
    };
  }, []);

  async function onPress() {
    if (!id) return;
    await Clipboard.setStringAsync(id);
    setCopied(true);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setCopied(false), 2000);
  }

  return (
    <SettingsRow
      label={t('settings.about.deviceId')}
      value={copied ? id : short}
      singleLineValue
      onPress={onPress}
      last
      icon={{ ios: 'number', android: 'tag' }}
    />
  );
}

export default function AboutSettingsScreen() {
  const { t } = useT();
  const version = Constants.expoConfig?.version ?? t('settings.about.unknown');

  return (
    <SafeAreaView edges={['bottom']} style={StyleSheet.flatten([styles.fill, { backgroundColor: tide.sky[0] }])}>
      <ScrollView contentContainerStyle={styles.list}>
        <SettingsSection title={t('settings.about.app')} footnote={t('settings.about.appFootnote')}>
          <SettingsRow label={t('settings.about.version')} value={version} icon={{ ios: 'info.circle', android: 'info' }} />
          <DeviceIdRow />
        </SettingsSection>

        <SettingsSection title={t('settings.about.credits')} footnote={t('settings.about.creditsFootnote')}>
          <SettingsRow
            label={t('settings.about.voiceSynthesis')}
            value="VOICEVOX"
            icon={{ ios: 'speaker.wave.2', android: 'volume_up' }}
          />
          <SettingsRow
            label={t('settings.about.speechRecognition')}
            value="faster-whisper"
            last
            icon={{ ios: 'mic', android: 'mic' }}
          />
        </SettingsSection>

        <SettingsSection
          title={t('settings.about.artwork')}
          footnote={t('settings.about.artworkFootnote')}>
          <SettingsRow
            label={t('settings.about.animatedEmoji')}
            value="Noto Emoji"
            last
            icon={{ ios: 'face.smiling', android: 'mood' }}
          />
        </SettingsSection>

        <SettingsSection title={t('settings.about.licences')} footnote={t('settings.about.licencesFootnote')}>
          <SettingsRow
            label={t('settings.about.openSourceLicences')}
            value={t('settings.about.seePackageJson')}
            last
            icon={{ ios: 'doc.text', android: 'description' }}
          />
        </SettingsSection>
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1 },
  list: { padding: Spacing.lg, gap: Spacing.lg, paddingBottom: 170 },
});
