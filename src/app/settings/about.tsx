import * as Clipboard from 'expo-clipboard';
import Constants from 'expo-constants';
import { useEffect, useRef, useState } from 'react';
import { ScrollView, StyleSheet } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { SettingsRow, SettingsSection } from '@/components/tide/settings-row';
import { Spacing, tide } from '@/constants/theme';
import { deviceIdSync } from '@/lib/device';

/** Row that copies the device id on tap and shows the full value in place
 * for two seconds before reverting to the short form. */
function DeviceIdRow() {
  const id = deviceIdSync();
  const short = id ? id.slice(0, 8) : 'Unknown';
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
      label="Device ID"
      value={copied ? id : short}
      singleLineValue
      onPress={onPress}
      last
      icon={{ ios: 'number', android: 'tag' }}
    />
  );
}

export default function AboutSettingsScreen() {
  const version = Constants.expoConfig?.version ?? 'Unknown';

  return (
    <SafeAreaView edges={['bottom']} style={StyleSheet.flatten([styles.fill, { backgroundColor: tide.sky[0] }])}>
      <ScrollView contentContainerStyle={styles.list}>
        <SettingsSection
          title="App"
          footnote="Islands belong to this phone. Sean needs this id once to keep his own islands.">
          <SettingsRow label="Version" value={version} icon={{ ios: 'info.circle', android: 'info' }} />
          <DeviceIdRow />
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
