import { Stack, useLocalSearchParams, useRouter } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { useEffect, useRef, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { CatConstellation } from '@/components/cat-constellation';

import { HeaderClosePill } from '@/components/header-close-pill';
import { fonts } from '@/constants/fonts';
import { Spacing, tide } from '@/constants/theme';
import * as api from '@/lib/api';
import { useT } from '@/lib/i18n';
import { CaptionsError, fetchCaptions } from '@/lib/youtube-captions';
import { parseYouTubeId } from '@/lib/youtube';
import { getSettings, getVoice, toIslandLanguage, toNativeLanguage } from '@/lib/settings';

const SIDE = 16;

/** How long the finished island sits on screen, glowing, before the screen
 * navigates away. */
const READY_HOLD_MS = 900;

/** With `url` this starts the build; with `id` it only follows one already running. */
export default function VideoBuildScreen() {
  const { t } = useT();
  const router = useRouter();
  const { url, title, id: existingId } = useLocalSearchParams<{ url?: string; title?: string; id?: string }>();

  const [error, setError] = useState('');
  const [stage, setStage] = useState('queued');
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const readyTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const started = useRef(false);

  useEffect(() => () => {
    if (pollRef.current) clearInterval(pollRef.current);
    if (readyTimerRef.current) clearTimeout(readyTimerRef.current);
  }, []);

  useEffect(() => {
    if (started.current || (!url && !existingId)) return;
    started.current = true;
    setError('');

    function follow(id: string) {
      pollRef.current = setInterval(async () => {
        try {
          const island = await api.getIsland(id);
          setStage(island.stage || island.status);
          if (island.status === 'ready') {
            if (pollRef.current) clearInterval(pollRef.current);
            setStage('ready');
            readyTimerRef.current = setTimeout(() => {
              router.replace({ pathname: '/video/[id]', params: { id } });
            }, READY_HOLD_MS);
          } else if (island.status === 'failed') {
            if (pollRef.current) clearInterval(pollRef.current);
            setError(api.islandErrorText(island));
          }
        } catch {
          // A dropped poll is not fatal, the next tick retries.
        }
      }, 2000);
    }

    if (existingId) {
      follow(existingId);
      return;
    }
    getSettings().then(async (settings) => {
      const { learningLanguage, understoodLanguage } = settings;
      const voice = await getVoice(learningLanguage);
      const language = toIslandLanguage(learningLanguage);
      try {
        const videoId = parseYouTubeId(url!);
        if (!videoId) throw new Error(t('video.lookupFailed'));
        setStage('reading');
        const { events } = await fetchCaptions(videoId, language);
        const { id } = await api.importYouTubeCaptions(
          url!, title || t('video.title'), voice, language, toNativeLanguage(understoodLanguage), events,
        );
        follow(id);
      } catch (e) {
        if (e instanceof CaptionsError) setError(t(`video.err.${e.code}` as const));
        else setError(e instanceof Error ? e.message : t('video.lookupFailed'));
      }
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [url, existingId]);

  function close() {
    if (pollRef.current) clearInterval(pollRef.current);
    if (readyTimerRef.current) clearTimeout(readyTimerRef.current);
    router.back();
  }

  return (
    <SafeAreaView edges={['bottom']} style={StyleSheet.flatten([styles.fill, { backgroundColor: tide.sky[0] }])}>
      <StatusBar style="light" />
      <Stack.Screen
        options={{
          headerStyle: { backgroundColor: tide.sky[0] },
          headerTintColor: tide.text,
          headerShadowVisible: false,
          headerLeft: () => <HeaderClosePill label={t('record.close')} onPress={close} />,
        }}
      />
      <View style={styles.center}>
        <CatConstellation size={120} label={(stage === 'reading' ? t('video.stageReading') : api.stageLabel(stage)).replace(/…$/, '')} />
        <Text style={[styles.hint, styles.centerText]}>{t('video.buildHint')}</Text>
        {error ? <Text style={[styles.error, styles.centerText]}>{error}</Text> : null}
      </View>
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
  error: { fontSize: 14, lineHeight: 20, color: tide.record, fontFamily: fonts.ui },
});
