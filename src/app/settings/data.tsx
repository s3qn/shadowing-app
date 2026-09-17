import { useFocusEffect } from 'expo-router';
import { useCallback, useEffect, useState } from 'react';
import { Alert, ScrollView, StyleSheet } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { SettingsRow, SettingsSection } from '@/components/tide/settings-row';
import { Spacing, tide } from '@/constants/theme';
import * as api from '@/lib/api';
import { useT } from '@/lib/i18n';
import { deleteAllTakes, takesStorageBytes } from '@/lib/takes';

const BACKEND_URL = process.env.EXPO_PUBLIC_SHADOW_API_URL;
const CONNECTED_COLOR = '#4ADE80';
const HEALTH_POLL_MS = 10_000;

function humanBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const mb = bytes / (1024 * 1024);
  if (mb < 1) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  return `${mb.toFixed(1)} MB`;
}

export default function DataSettingsScreen() {
  const { t } = useT();
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
    Alert.alert(t('settings.data.deleteAllTitle'), t('settings.data.deleteAllBody'), [
      { text: t('common.cancel'), style: 'cancel' },
      {
        text: t('settings.data.deleteAllConfirm'),
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
        <SettingsSection title={t('settings.data.storage')} footnote={t('settings.data.storageFootnote')}>
          <SettingsRow
            label={t('settings.data.takesOnDevice')}
            value={humanBytes(storageBytes)}
            last
            icon={{ ios: 'internaldrive', android: 'storage' }}
          />
        </SettingsSection>

        <SettingsSection title={t('settings.data.takes')}>
          <SettingsRow
            label={t('settings.data.deleteAllTakes')}
            destructive
            last
            icon={{ ios: 'trash', android: 'delete' }}
            onPress={confirmDeleteAll}
          />
        </SettingsSection>

        <SettingsSection title={t('settings.data.backend')}>
          <SettingsRow
            label={t('settings.data.server')}
            value={BACKEND_URL ?? t('settings.data.notSet')}
            icon={{ ios: 'server.rack', android: 'dns' }}
          />
          <SettingsRow
            label={t('settings.data.connection')}
            last
            icon={{ ios: 'wifi', android: 'wifi' }}
            value={connected === null ? t('settings.data.checking') : connected ? t('settings.data.connected') : t('settings.data.offline')}
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
