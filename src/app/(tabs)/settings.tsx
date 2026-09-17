import { useFocusEffect, useRouter } from 'expo-router';
import { useCallback, useState } from 'react';
import { ScrollView, StyleSheet } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { PILL_TAB_BAR_REACH } from '@/components/pill-tab-bar';
import { SettingsRow, SettingsSection } from '@/components/tide/settings-row';
import { Spacing, prism, tide } from '@/constants/theme';
import * as api from '@/lib/api';
import { getSettings, setHaptics, setSkyAlwaysNight } from '@/lib/settings';

export default function SettingsScreen() {
  const router = useRouter();
  const [voiceName, setVoiceName] = useState('');
  const [haptics, setHapticsState] = useState(true);
  const [skyAlwaysNight, setSkyAlwaysNightState] = useState(false);

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

        try {
          const speakers = await api.listSpeakers();
          if (!alive) return;
          const speaker = speakers.find((sp) => sp.styles.some((st) => st.id === settings.voice));
          const style = speaker?.styles.find((st) => st.id === settings.voice);
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
        <SettingsSection title="Practice">
          <SettingsRow
            label="Reading, pitch, defaults"
            last
            icon={{ ios: 'book.closed', android: 'menu_book' }}
            onPress={() => router.push('/settings/practice')}
          />
        </SettingsSection>

        <SettingsSection title="Playback">
          <SettingsRow
            label="Speed, repeat, pause, Auto Echo"
            last
            icon={{ ios: 'gauge', android: 'speed' }}
            onPress={() => router.push('/settings/playback')}
          />
        </SettingsSection>

        <SettingsSection title="Voice">
          <SettingsRow
            label="Voice"
            value={voiceName}
            last
            icon={{ ios: 'person.wave.2', android: 'record_voice_over' }}
            onPress={() => router.push('/settings/voice')}
          />
        </SettingsSection>

        <SettingsSection title="Appearance">
          <SettingsRow
            label="Haptics"
            icon={{ ios: 'iphone.radiowaves.left.and.right', android: 'vibration' }}
            switchValue={haptics}
            onSwitchChange={(next) => {
              setHapticsState(next);
              void setHaptics(next);
            }}
          />
          <SettingsRow
            label="Always night sky"
            last
            icon={{ ios: 'moon.stars', android: 'nightlight' }}
            switchValue={skyAlwaysNight}
            onSwitchChange={(next) => {
              setSkyAlwaysNightState(next);
              void setSkyAlwaysNight(next);
            }}
          />
        </SettingsSection>

        <SettingsSection title="Data">
          <SettingsRow
            label="Storage, delete takes"
            last
            icon={{ ios: 'internaldrive', android: 'storage' }}
            onPress={() => router.push('/settings/data')}
          />
        </SettingsSection>

        <SettingsSection title="About">
          <SettingsRow
            label="Version, credits"
            last={!__DEV__}
            icon={{ ios: 'info.circle', android: 'info' }}
            onPress={() => router.push('/settings/about')}
          />
          {__DEV__ ? (
            <SettingsRow
              label="Prism lab"
              last
              icon={{ ios: 'sparkles', android: 'auto_awesome' }}
              onPress={() => router.push('/prism-lab')}
            />
          ) : null}
        </SettingsSection>

        <SettingsSection title="Feedback">
          <SettingsRow
            label="Suggest a feature"
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
