import { useFocusEffect } from 'expo-router';
import { useCallback, useEffect, useState } from 'react';
import { Alert, ScrollView, StyleSheet } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { SettingsRow, SettingsSection } from '@/components/tide/settings-row';
import { Spacing, tide } from '@/constants/theme';
import * as api from '@/lib/api';
import { deleteAllTakes, takesStorageBytes } from '@/lib/takes';

const BACKEND_URL = process.env.EXPO_PUBLIC_SHADOW_API_URL ?? 'Not set';
const CONNECTED_COLOR = '#4ADE80';
const HEALTH_POLL_MS = 10_000;

function humanBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const mb = bytes / (1024 * 1024);
  if (mb < 1) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  return `${mb.toFixed(1)} MB`;
}

export default function DataSettingsScreen() {
  const [storageBytes, setStorageBytes] = useState(0);
  const [connected, setConnected] = useState<boolean | null>(null);

  const refreshStorage = useCallback(() => {
    void takesStorageBytes().then(setStorageBytes);
  }, []);

  useFocusEffect(
    useCallback(() => {
      refreshStorage();
    }, [refreshStorage]),
  );

  // Polls the backend health check while this screen is focused, so the
  // dot reflects a backend that was just started or stopped.
  useEffect(() => {
    let alive = true;
    function check() {
      void api
        .health()
        .then((ok) => {
          if (alive) setConnected(ok);
        })
        .catch(() => {
          if (alive) setConnected(false);
        });
    }
    check();
    const interval = setInterval(check, HEALTH_POLL_MS);
    return () => {
      alive = false;
      clearInterval(interval);
    };
  }, []);

  function confirmDeleteAll() {
    Alert.alert('Delete all takes?', 'This removes every recording on this device. Islands themselves are not affected.', [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Delete all',
        style: 'destructive',
        onPress: () => {
          void deleteAllTakes().then(refreshStorage);
        },
      },
    ]);
  }

  return (
    <SafeAreaView edges={['bottom']} style={StyleSheet.flatten([styles.fill, { backgroundColor: tide.sky[0] }])}>
      <ScrollView contentContainerStyle={styles.list}>
        <SettingsSection title="Storage" footnote="Every recording made while shadowing, across every island.">
          <SettingsRow label="Takes on this device" value={humanBytes(storageBytes)} last />
        </SettingsSection>

        <SettingsSection title="Takes">
          <SettingsRow label="Delete all takes" destructive last onPress={confirmDeleteAll} />
        </SettingsSection>

        <SettingsSection title="Backend">
          <SettingsRow label="Server" value={BACKEND_URL} />
          <SettingsRow
            label="Connection"
            last
            value={connected === null ? 'Checking…' : connected ? 'Connected' : 'Offline'}
            dotColor={connected === null ? undefined : connected ? CONNECTED_COLOR : tide.record}
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
