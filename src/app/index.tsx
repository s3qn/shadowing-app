import { Stack, useFocusEffect, useRouter } from 'expo-router';
import { useCallback, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  FlatList,
  Pressable,
  RefreshControl,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { PracticeCard } from '@/components/practice-card';
import { Radius, Spacing } from '@/constants/theme';
import { useTheme } from '@/hooks/use-theme';
import * as api from '@/lib/api';
import { forgetIsland, getPracticeLog, minutesOn, type PracticeLog } from '@/lib/practice';
import { deleteTakes } from '@/lib/takes';

const SORTS = ['newest', 'least'] as const;
type Sort = (typeof SORTS)[number];
const SORT_LABEL: Record<Sort, string> = { newest: 'Newest', least: 'Least practiced' };
const EMPTY_LOG: PracticeLog = { days: {}, islands: {} };

export default function IslandsScreen() {
  const { palette } = useTheme();
  const router = useRouter();
  const [islands, setIslands] = useState<api.IslandSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [query, setQuery] = useState('');
  const [sort, setSort] = useState<Sort>('newest');
  const [log, setLog] = useState<PracticeLog>(EMPTY_LOG);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draftTitle, setDraftTitle] = useState('');
  const editingIdRef = useRef<string | null>(null);
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
      void forgetIsland(id);
      removed.current.add(id);
      setIslands((prev) => prev.filter((i) => i.id !== id));
    } catch (e) {
      Alert.alert('Could not delete', e instanceof Error ? e.message : 'The server did not answer.');
    }
  }

  async function rename(id: string, title: string) {
    // A single-line TextInput fires onSubmitEditing then onBlur for one return
    // press (submitBehavior defaults to 'blurAndSubmit'). editingIdRef closes
    // that window synchronously so the second call is a no-op.
    if (editingIdRef.current !== id) return;
    editingIdRef.current = null;
    const finalTitle = title.trim() || 'Untitled island';
    setEditingId(null);
    try {
      await api.renameIsland(id, finalTitle);
      setIslands((prev) => prev.map((i) => (i.id === id ? { ...i, title: finalTitle } : i)));
    } catch (e) {
      Alert.alert('Could not rename', e instanceof Error ? e.message : 'The server did not answer.');
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
  // anything is still building so the row flips to ready on its own. The
  // practice log only reloads once per focus: it changes on a shadowing
  // screen, never while sitting on this one.
  useFocusEffect(
    useCallback(() => {
      let alive = true;
      const tick = async () => {
        if (!alive) return;
        await load();
      };
      tick();
      void getPracticeLog().then((next) => {
        if (alive) setLog(next);
      });
      const timer = setInterval(tick, 3000);
      return () => {
        alive = false;
        clearInterval(timer);
      };
    }, [load]),
  );

  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    const filtered = q ? islands.filter((i) => i.title.toLowerCase().includes(q)) : islands;
    return [...filtered].sort((a, b) => {
      if (sort === 'least') {
        const diff = (log.islands[a.id]?.seconds ?? 0) - (log.islands[b.id]?.seconds ?? 0);
        if (diff !== 0) return diff;
      }
      // Newest first: the tie break above, and the "Newest" sort itself.
      return new Date(b.created_at).getTime() - new Date(a.created_at).getTime();
    });
  }, [islands, query, sort, log]);

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
        data={shown}
        keyExtractor={(item) => item.id}
        contentContainerStyle={styles.list}
        keyboardShouldPersistTaps="handled"
        refreshControl={
          <RefreshControl refreshing={loading} onRefresh={load} tintColor={palette.muted} />
        }
        ListHeaderComponent={
          <View style={styles.header}>
            <PracticeCard log={log} />
            <TextInput
              value={query}
              onChangeText={setQuery}
              placeholder="Search islands"
              placeholderTextColor={palette.muted}
              clearButtonMode="while-editing"
              autoCorrect={false}
              style={StyleSheet.flatten([
                styles.search,
                { backgroundColor: palette.surface, borderColor: palette.line, color: palette.ink },
              ])}
            />
            <View style={styles.sortRow}>
              {SORTS.map((s) => {
                const on = sort === s;
                return (
                  <Pressable
                    key={s}
                    onPress={() => setSort(s)}
                    style={[
                      styles.pill,
                      { backgroundColor: on ? palette.accent : palette.surface, borderColor: on ? palette.accent : palette.line },
                    ]}>
                    <Text style={[styles.pillText, { color: on ? palette.accentInk : palette.ink }]}>
                      {SORT_LABEL[s]}
                    </Text>
                  </Pressable>
                );
              })}
            </View>
          </View>
        }
        ListEmptyComponent={
          loading ? (
            <ActivityIndicator style={{ marginTop: Spacing.xxl }} color={palette.accent} />
          ) : (
            <View style={styles.center}>
              <Text style={[styles.empty, { color: palette.muted }]}>
                {error
                  ? error
                  : query.trim() && islands.length > 0
                    ? 'No island matches'
                    : 'No islands yet. Record a minute about your day and one gets built from it.'}
              </Text>
            </View>
          )
        }
        renderItem={({ item }) => {
          const busy = item.status === 'pending' || item.status === 'working';
          const minutes = minutesOn(log, item.id);
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
                {editingId === item.id ? (
                  <TextInput
                    autoFocus
                    value={draftTitle}
                    onChangeText={setDraftTitle}
                    onSubmitEditing={() => void rename(item.id, draftTitle)}
                    onBlur={() => void rename(item.id, draftTitle)}
                    style={[styles.cardTitle, styles.cardTitleInput, { color: palette.ink, borderColor: palette.line }]}
                  />
                ) : (
                  <Pressable
                    style={styles.cardTitleWrap}
                    onPress={() => {
                      setDraftTitle(item.title);
                      setEditingId(item.id);
                      editingIdRef.current = item.id;
                    }}>
                    <Text numberOfLines={2} style={[styles.cardTitle, { color: palette.ink }]}>
                      {item.title || 'Untitled island'}
                    </Text>
                  </Pressable>
                )}
                {busy ? <ActivityIndicator size="small" color={palette.accent} /> : null}
              </View>
              <Text style={[styles.cardMeta, { color: palette.muted }]}>
                {item.status === 'failed'
                  ? 'Failed'
                  : busy
                    ? (api.STAGE_LABEL[item.stage] ?? 'Working…')
                    : `${item.line_count} lines · ${item.complexity}${minutes >= 1 ? ` · ${minutes} min` : ''}`}
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
  cardTitleWrap: { flex: 1 },
  cardTitle: { flex: 1, fontSize: 17, fontWeight: '600' },
  cardTitleInput: { borderBottomWidth: 1, paddingVertical: 0 },
  cardMeta: { fontSize: 13 },
  header: { gap: Spacing.md, marginBottom: Spacing.md },
  search: { borderWidth: 1, borderRadius: Radius.md, paddingVertical: Spacing.sm, paddingHorizontal: Spacing.md, fontSize: 15 },
  sortRow: { flexDirection: 'row', gap: Spacing.sm },
  pill: { borderWidth: 1, borderRadius: Radius.pill, paddingVertical: Spacing.xs + 2, paddingHorizontal: Spacing.md },
  pillText: { fontSize: 13, fontWeight: '700' },
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
