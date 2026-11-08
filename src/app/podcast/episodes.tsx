import { Stack, useLocalSearchParams, useRouter } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { useEffect, useState } from 'react';
import { FlatList, StyleSheet, Text } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { GlassCard } from '@/components/glass-card';
import { ErrorState, LoadingBlock } from '@/components/state-blocks';
import { confirmSheet } from '@/lib/confirm-sheet';
import { formatClock } from '@/lib/format';

import { fonts } from '@/constants/fonts';
import { useDir, useT } from '@/lib/i18n';
import { Spacing, tide } from '@/constants/theme';
import * as api from '@/lib/api';

const SIDE = 16;

function duration(seconds: number | null): string | null {
  if (seconds == null || !Number.isFinite(seconds)) return null;
  return formatClock(seconds);
}

function published(value: string | null, locale: string): string | null {
  if (!value) return null;
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return null;
  return d.toLocaleDateString(locale);
}

export default function PodcastEpisodesScreen() {
  const router = useRouter();
  const { t, locale } = useT();
  const dir = useDir();
  const { feedUrl, title } = useLocalSearchParams<{ feedUrl: string; title?: string }>();

  const [episodes, setEpisodes] = useState<api.PodcastEpisode[] | null>(null);
  const [feedTitle, setFeedTitle] = useState(title ?? '');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    if (!feedUrl) return;
    let cancelled = false;
    setLoading(true);
    setError('');
    api
      .podcastEpisodes(feedUrl)
      .then((result) => {
        if (cancelled) return;
        setFeedTitle(result.title || title || '');
        setEpisodes(result.episodes);
      })
      .catch((e) => {
        if (cancelled) return;
        setError(e instanceof Error ? e.message : t('home.episodesFeedError'));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [feedUrl, title, t, attempt]);

  async function buildFrom(episode: api.PodcastEpisode) {
    const pick = await confirmSheet({
      title: t('home.episodeConfirmTitle'),
      message: t('home.episodeConfirmBody'),
      actions: [
        { label: t('common.cancel'), verb: 'tools' },
        { label: t('home.episodeConfirmAction'), verb: 'listen' },
      ],
    });
    if (pick !== 1) return;
    router.push({
      pathname: '/podcast/build',
      params: { audioUrl: episode.audio_url, title: episode.title || feedTitle || t('home.episodeFallbackTitle') },
    });
  }

  return (
    <SafeAreaView edges={['bottom']} style={StyleSheet.flatten([styles.fill, { backgroundColor: tide.sky[0] }])}>
      <StatusBar style="light" />
      <Stack.Screen
        options={{
          title: feedTitle || t('home.episodesTitle'),
        }}
      />

      {loading ? (
        <LoadingBlock />
      ) : error ? (
        <ErrorState message={error} onRetry={() => setAttempt((n) => n + 1)} />
      ) : (
        <FlatList
          style={styles.fill}
          contentContainerStyle={styles.list}
          data={episodes ?? []}
          keyExtractor={(item, i) => `${item.audio_url}-${i}`}
          renderItem={({ item }) => {
            const dur = duration(item.duration_s);
            const pub = published(item.published, locale);
            const meta = [dur, pub].filter(Boolean).join(' · ');
            return (
              <GlassCard onPress={() => void buildFrom(item)} style={styles.episode}>
                <Text style={[styles.episodeTitle, dir.content]} numberOfLines={2}>
                  {item.title || t('home.untitledEpisode')}
                </Text>
                {meta ? <Text style={[styles.episodeMeta, dir.text]}>{meta}</Text> : null}
              </GlassCard>
            );
          }}
        />
      )}
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1 },
  list: { paddingHorizontal: SIDE, paddingTop: Spacing.md, paddingBottom: Spacing.xl, gap: Spacing.sm },
  episode: {
    padding: Spacing.md,
    gap: Spacing.xs,
  },
  episodeTitle: { fontSize: 15, lineHeight: 20, color: tide.text, fontFamily: fonts.uiMedium, fontWeight: '500' },
  episodeMeta: { fontSize: 13, lineHeight: 18, color: tide.textDim, fontFamily: fonts.ui },
});
