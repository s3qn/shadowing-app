import { Stack, useLocalSearchParams, useRouter } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { useEffect, useState } from 'react';
import { FlatList, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { CatConstellation } from '@/components/cat-constellation';
import { PressScale } from '@/components/press-scale';

import { fonts } from '@/constants/fonts';
import { useDir, useT } from '@/lib/i18n';
import { Radius, Spacing, tide } from '@/constants/theme';
import * as api from '@/lib/api';

const SIDE = 16;

function duration(seconds: number | null): string | null {
  if (seconds == null || !Number.isFinite(seconds)) return null;
  const s = Math.max(0, Math.floor(seconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const rem = s % 60;
  if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(rem).padStart(2, '0')}`;
  return `${m}:${String(rem).padStart(2, '0')}`;
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
  }, [feedUrl, title, t]);

  function buildFrom(episode: api.PodcastEpisode) {
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
          headerStyle: { backgroundColor: tide.sky[0] },
          headerTintColor: tide.text,
          headerShadowVisible: false,
        }}
      />

      {loading ? (
        <View style={styles.center}>
          <CatConstellation size={120} label={t('common.loading')} />
        </View>
      ) : error ? (
        <View style={styles.center}>
          <Text style={[styles.hint, styles.centerText]}>{error}</Text>
        </View>
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
              <PressScale onPress={() => buildFrom(item)} accessibilityRole="button" style={styles.episode}>
                <Text style={[styles.episodeTitle, dir.content]} numberOfLines={2}>
                  {item.title || t('home.untitledEpisode')}
                </Text>
                {meta ? <Text style={[styles.episodeMeta, dir.text]}>{meta}</Text> : null}
              </PressScale>
            );
          }}
        />
      )}
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1 },
  center: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    gap: Spacing.lg,
    paddingHorizontal: SIDE,
  },
  centerText: { textAlign: 'center' },
  hint: { fontSize: 14, lineHeight: 20, color: tide.textDim, fontFamily: fonts.ui },
  list: { paddingHorizontal: SIDE, paddingTop: Spacing.md, paddingBottom: Spacing.xl, gap: Spacing.sm },
  episode: {
    padding: Spacing.md,
    borderRadius: Radius.md,
    backgroundColor: 'rgba(255,255,255,0.06)',
    gap: Spacing.xs,
  },
  episodeTitle: { fontSize: 15, lineHeight: 20, color: tide.text, fontFamily: fonts.uiMedium, fontWeight: '500' },
  episodeMeta: { fontSize: 13, lineHeight: 18, color: tide.textDim, fontFamily: fonts.ui },
});
