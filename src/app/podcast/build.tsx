import { Stack, useLocalSearchParams, useRouter } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { useEffect, useRef, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { CatConstellation } from '@/components/cat-constellation';

import { fonts } from '@/constants/fonts';
import { Spacing, tide } from '@/constants/theme';
import * as api from '@/lib/api';
import { getSettings, getVoice } from '@/lib/settings';

const SIDE = 16;

const STAGE_LABEL: Record<string, string> = {
  queued: 'Queued…',
  downloading: 'Downloading the episode…',
  transcribing: 'Transcribing…',
  writing: 'Writing the lines…',
  speaking: 'Recording the voice…',
  ready: 'Ready.',
};

/** How long the finished island sits on screen, glowing, before the screen
 * navigates away. */
const READY_HOLD_MS = 900;

export default function PodcastBuildScreen() {
  const router = useRouter();
  const { audioUrl, title } = useLocalSearchParams<{ audioUrl: string; title?: string }>();

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
    if (started.current || !audioUrl) return;
    started.current = true;
    setError('');
    getSettings().then(async (settings) => {
      const { learningLanguage, understoodLanguage } = settings;
      const voice = await getVoice(learningLanguage);
      api
        .importPodcastEpisode(audioUrl, title || 'Podcast episode', voice, learningLanguage, understoodLanguage)
        .then(({ id }) => {
          pollRef.current = setInterval(async () => {
            try {
              const island = await api.getIsland(id);
              setStage(island.stage || island.status);
              if (island.status === 'ready') {
                if (pollRef.current) clearInterval(pollRef.current);
                setStage('ready');
                readyTimerRef.current = setTimeout(() => {
                  router.replace({ pathname: '/island/[id]', params: { id } });
                }, READY_HOLD_MS);
              } else if (island.status === 'failed') {
                if (pollRef.current) clearInterval(pollRef.current);
                setError(island.error || 'That island could not be built.');
              }
            } catch {
              // A dropped poll is not fatal, the next tick retries.
            }
          }, 2000);
        })
        .catch((e) => {
          setError(e instanceof Error ? e.message : 'The episode could not be downloaded.');
        });
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [audioUrl]);

  function cancel() {
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
          headerLeft: () => (
            <Pressable onPress={cancel} hitSlop={12}>
              <Text style={{ color: tide.text, fontSize: 16, fontWeight: '600', fontFamily: fonts.ui }}>Close</Text>
            </Pressable>
          ),
        }}
      />
      <View style={styles.center}>
        <CatConstellation size={120} label={(STAGE_LABEL[stage] ?? 'Working…').replace(/…$/, '')} />
        <Text style={[styles.hint, styles.centerText]}>
          This takes a few minutes. Close this screen if you like, the island keeps
          building and appears in the list when it is ready.
        </Text>
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
