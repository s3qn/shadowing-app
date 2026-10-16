import { Stack, useFocusEffect, useRouter } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { useCallback, useMemo, useState } from 'react';
import { FlatList, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { CatConstellation } from '@/components/cat-constellation';
import { PrismButton } from '@/components/prism';
import { SheetAction } from '@/components/sheet/sheet-rows';
import { fonts } from '@/constants/fonts';
import { Spacing, tide, verb } from '@/constants/theme';
import * as api from '@/lib/api';
import { useT } from '@/lib/i18n';

/** Saved sentences grouped by video or podcast. A project opens in its own player in review mode. */
export default function ReviewScreen() {
  const { t } = useT();
  const router = useRouter();
  const [cards, setCards] = useState<api.ReviewCard[] | null>(null);
  const [loadError, setLoadError] = useState('');

  useFocusEffect(
    useCallback(() => {
      let alive = true;
      api
        .listLiveReviewCards()
        .then((c) => {
          if (!alive) return;
          setLoadError('');
          setCards(c);
        })
        .catch((e) => alive && (setLoadError(e instanceof Error ? e.message : t('review.loadFailed')), setCards([])));
      return () => {
        alive = false;
      };
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []),
  );
  const projects = useMemo(() => api.reviewProjects(cards ?? []), [cards]);

  return (
    <SafeAreaView edges={['bottom']} style={[styles.fill, { backgroundColor: tide.sky[0] }]}>
      <StatusBar style="light" />
      <Stack.Screen options={{ title: t('review.title') }} />
      {!cards ? (
        <View style={styles.center}>
          <CatConstellation size={120} />
        </View>
      ) : loadError ? (
        <View style={styles.center}>
          <Text style={styles.hint}>{loadError}</Text>
        </View>
      ) : !projects.length ? (
        <View style={styles.center}>
          <Text style={styles.title}>{t('review.emptyTitle')}</Text>
          <Text style={styles.hint}>{t('review.emptyHint')}</Text>
          <PrismButton shape="pill" verb="listen" label={t('review.openPodcasts')} onPress={() => router.navigate('/podcast')} />
        </View>
      ) : (
        <FlatList
          data={projects}
          keyExtractor={(p) => p.islandId}
          renderItem={({ item: p }) => (
            <SheetAction
              label={p.title}
              hint={t('review.projectMeta', { saved: p.saved, due: p.due })}
              icon={p.source === 'podcast' ? { ios: 'waveform', android: 'graphic_eq' } : { ios: 'play.rectangle.fill', android: 'smart_display' }}
              discColor={p.due > 0 ? verb.read.c1 : undefined}
              onPress={() => router.push({ pathname: p.source === 'podcast' ? '/podcast/[id]' : '/video/[id]', params: { id: p.islandId, review: '1' } })}
            />
          )}
        />
      )}
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1 },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: Spacing.lg, paddingHorizontal: 16 },
  title: { fontSize: 20, fontWeight: '700', color: tide.text, fontFamily: fonts.ui, textAlign: 'center' },
  hint: { fontSize: 14, lineHeight: 20, color: tide.textDim, fontFamily: fonts.ui, textAlign: 'center' },
});
