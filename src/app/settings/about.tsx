import Constants from 'expo-constants';
import { ScrollView, StyleSheet } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { SettingsRow, SettingsSection } from '@/components/tide/settings-row';
import { Spacing, tide } from '@/constants/theme';

export default function AboutSettingsScreen() {
  const version = Constants.expoConfig?.version ?? 'Unknown';

  return (
    <SafeAreaView edges={['bottom']} style={StyleSheet.flatten([styles.fill, { backgroundColor: tide.sky[0] }])}>
      <ScrollView contentContainerStyle={styles.list}>
        <SettingsSection title="App">
          <SettingsRow label="Version" value={version} last icon={{ ios: 'info.circle', android: 'info' }} />
        </SettingsSection>

        <SettingsSection
          title="Credits"
          footnote="Speech is generated with VOICEVOX and transcribed with faster-whisper, both open source and run on this device's own network.">
          <SettingsRow
            label="Voice synthesis"
            value="VOICEVOX"
            icon={{ ios: 'speaker.wave.2', android: 'volume_up' }}
          />
          <SettingsRow
            label="Speech recognition"
            value="faster-whisper"
            last
            icon={{ ios: 'mic', android: 'mic' }}
          />
        </SettingsSection>

        <SettingsSection title="Licences" footnote="Every open source dependency keeps its own licence, unmodified.">
          <SettingsRow
            label="Open source licences"
            value="See package.json"
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
