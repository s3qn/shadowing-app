import { Stack, useFocusEffect, useRouter } from 'expo-router';
import { useCallback, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  FlatList,
  Pressable,
  RefreshControl,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { Radius, Spacing } from '@/constants/theme';
import { useTheme } from '@/hooks/use-theme';
import * as api from '@/lib/api';
import { deleteTakes } from '@/lib/takes';

export default function IslandsScreen() {
  const { palette } = useTheme();
  const router = useRouter();
  const [islands, setIslands] = useState<api.IslandSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  // A list request that started before a delete can still answer with the
  // deleted row, which would put it back on screen. Ids deleted here stay out.
  const removed = useRef<Set<string>>(new Set());

  const load = useCallback(async () => {
    try {
      const rows = await api.listIslands();
      setIslands(rows.filter((i) => !removed.current.has(i.id)));
      setError('');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not reach the server');
    } finally {
      setLoading(false);
    }
  }, []);

  async function remove(id: string) {
    try {
      await api.deleteIsland(id);
      // Phone keeps the takes; the server never saw them.
      deleteTakes(id);
      removed.current.add(id);
      setIslands((prev) => prev.filter((i) => i.id !== id));
    } catch (e) {
      Alert.alert('Could not delete', e instanceof Error ? e.message : 'The server did not answer.');
    }
  }

  function confirmDelete(item: api.IslandSummary) {
    Alert.alert(
      `Delete "${item.title || 'Untitled island'}"?`,
      'The recording, its lines and their audio are removed. This cannot be undone.',
      [
        { text: 'Cancel', style: 'cancel' },
        { text: 'Delete', style: 'destructive', onPress: () => void remove(item.id) },
      ],
    );
  }

  // Re-poll whenever the screen comes back into focus, and keep polling while
  // anything is still building so the row flips to ready on its own.
  useFocusEffect(
    useCallback(() => {
      let alive = true;
      const tick = async () => {
        if (!alive) return;
        await load();
      };
      tick();
      const timer = setInterval(tick, 3000);
      return () => {
        alive = false;
        clearInterval(timer);
      };
    }, [load]),
  );

  if (!api.configured()) {
    return (
      <SafeAreaView style={StyleSheet.flatten([styles.fill, styles.center, { backgroundColor: palette.bg }])}>
        <Text style={[styles.empty, { color: palette.ink }]}>
          Set EXPO_PUBLIC_SHADOW_API_URL and EXPO_PUBLIC_SHADOW_TOKEN in .env, then restart
          the dev server.
        </Text>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView edges={['bottom']} style={StyleSheet.flatten([styles.fill, { backgroundColor: palette.bg }])}>
      <Stack.Screen
        options={{
          headerRight: () => (
            <Pressable onPress={() => router.push('/settings')} hitSlop={12}>
              <Text style={{ color: palette.accent, fontSize: 16, fontWeight: '600' }}>Settings</Text>
            </Pressable>
          ),
        }}
      />
      <FlatList
        data={islands}
        keyExtractor={(item) => item.id}
        contentContainerStyle={styles.list}
        refreshControl={
          <RefreshControl refreshing={loading} onRefresh={load} tintColor={palette.muted} />
        }
        ListEmptyComponent={
          loading ? (
            <ActivityIndicator style={{ marginTop: Spacing.xxl }} color={palette.accent} />
          ) : (
            <View style={styles.center}>
              <Text style={[styles.empty, { color: palette.muted }]}>
                {error
                  ? error
                  : 'No islands yet. Record a minute about your day and one gets built from it.'}
              </Text>
            </View>
          )
        }
        renderItem={({ item }) => {
          const busy = item.status === 'pending' || item.status === 'working';
          return (
            // Long press deletes, after a confirmation. Building islands are disabled, so they cannot be deleted until they land.
            <Pressable
              disabled={busy}
              onPress={() => router.push({ pathname: '/island/[id]', params: { id: item.id } })}
              onLongPress={() => confirmDelete(item)}
              style={StyleSheet.flatten([
                styles.card,
                { backgroundColor: palette.surface, borderColor: palette.line },
              ])}>
              <View style={styles.cardTop}>
                <Text numberOfLines={2} style={[styles.cardTitle, { color: palette.ink }]}>
                  {item.title || 'Untitled island'}
                </Text>
                {busy ? <ActivityIndicator size="small" color={palette.accent} /> : null}
              </View>
              <Text style={[styles.cardMeta, { color: palette.muted }]}>
                {item.status === 'failed'
                  ? 'Failed'
                  : busy
                    ? (api.STAGE_LABEL[item.stage] ?? 'Working…')
                    : `${item.line_count} lines · ${item.complexity}`}
              </Text>
            </Pressable>
          );
        }}
      />
      <Pressable
        onPress={() => router.push('/record')}
        style={[styles.fab, { backgroundColor: palette.accent }]}>
        <Text style={[styles.fabText, { color: palette.accentInk }]}>Record an island</Text>
      </Pressable>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1 },
  center: { alignItems: 'center', justifyContent: 'center', paddingTop: Spacing.xxl },
  list: { padding: Spacing.lg, paddingBottom: 120, gap: Spacing.md },
  empty: { fontSize: 15, lineHeight: 22, textAlign: 'center', paddingHorizontal: Spacing.xl },
  card: { borderWidth: 1, borderRadius: Radius.md, padding: Spacing.lg, gap: Spacing.xs },
  cardTop: { flexDirection: 'row', alignItems: 'center', gap: Spacing.md },
  cardTitle: { flex: 1, fontSize: 17, fontWeight: '600' },
  cardMeta: { fontSize: 13 },
  fab: {
    position: 'absolute',
    left: Spacing.lg,
    right: Spacing.lg,
    bottom: Spacing.xl,
    paddingVertical: Spacing.lg,
    borderRadius: Radius.pill,
    alignItems: 'center',
  },
  fabText: { fontSize: 16, fontWeight: '700' },
});
