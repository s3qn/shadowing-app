import { Stack, useRouter } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { SymbolView } from 'expo-symbols';
import { type ReactNode, useCallback, useEffect, useRef, useState } from 'react';
import { FlatList, Pressable, StyleSheet, Text, View } from 'react-native';
import { Canvas, LinearGradient, Rect, vec } from '@shopify/react-native-skia';
import { SafeAreaView } from 'react-native-safe-area-context';

import { CatConstellation } from '@/components/cat-constellation';
import { PressScale } from '@/components/press-scale';
import { PrismButton } from '@/components/prism';

import { fonts } from '@/constants/fonts';
import { Spacing, tide } from '@/constants/theme';
import * as api from '@/lib/api';
import { useDir, useT } from '@/lib/i18n';
import { getSettingsSync, subscribeSettings, toIslandLanguage } from '@/lib/settings';

const SIDE = 16;
const MIC_SIZE = 44;
const TILE_H = 120;
const TILE_RADIUS = 20;

type Look = { emoji: string; from: string; to: string };
// Per-topic emoji and 135deg gradient, from the approved PH2-v1 design.
const FALLBACK_LOOK: Look = { emoji: '💬', from: '#34445a', to: '#4a5a70' };
const TOPIC_LOOK: Record<string, Look> = {
  greetings: { emoji: '👋', from: '#27405c', to: '#3c5a7a' },
  'eating-out': { emoji: '🍜', from: '#4a3b52', to: '#6b4a45' },
  'getting-around': { emoji: '🚃', from: '#1f4a52', to: '#2c6a6a' },
  'about-me': { emoji: '🙋', from: '#3a3f66', to: '#5a4f7e' },
  shopping: { emoji: '🛍️', from: '#5a3f4a', to: '#7a4f5a' },
  help: { emoji: '🆘', from: '#523a3a', to: '#6e4a3a' },
  'small-talk': { emoji: '☕', from: '#2c4a66', to: '#3a6a86' },
  questions: { emoji: '❓', from: '#34445a', to: '#4a5a70' },
};

function TopicTile({ look, children }: { look: Look; children: ReactNode }) {
  const [size, setSize] = useState({ w: 0, h: TILE_H });
  return (
    <View
      style={styles.card}
      onLayout={(e) => setSize({ w: e.nativeEvent.layout.width || 0, h: e.nativeEvent.layout.height || TILE_H })}>
      <Canvas style={StyleSheet.absoluteFill} pointerEvents="none">
        <Rect x={0} y={0} width={size.w} height={size.h} opacity={0.9}>
          <LinearGradient start={vec(0, 0)} end={vec(size.w, size.h)} colors={[look.from, look.to]} />
        </Rect>
      </Canvas>
      {children}
    </View>
  );
}

export default function PhrasesScreen() {
  const router = useRouter();
  const { t, lang } = useT();
  const dir = useDir();

  const [topics, setTopics] = useState<api.PhraseTopic[] | null>(null);
  const [error, setError] = useState('');
  const [attempt, setAttempt] = useState(0);
  const [learningLanguage, setLearningLanguage] = useState(() => getSettingsSync().learningLanguage);
  useEffect(() => subscribeSettings(() => setLearningLanguage(getSettingsSync().learningLanguage)), []);
  const requestId = useRef(0);

  useEffect(() => {
    const id = ++requestId.current;
    setTopics(null);
    setError('');
    api
      .phraseCatalog(toIslandLanguage(learningLanguage), lang)
      .then((res) => {
        if (id === requestId.current) setTopics(res.topics);
      })
      .catch(() => {
        if (id === requestId.current) setError(t('home.phrasesError'));
      });
  }, [learningLanguage, lang, t, attempt]);

  const retry = useCallback(() => setAttempt((n) => n + 1), []);

  return (
    <SafeAreaView edges={['bottom']} style={StyleSheet.flatten([styles.fill, { backgroundColor: tide.sky[0] }])}>
      <StatusBar style="light" />
      <Stack.Screen
        options={{
          title: t('home.phrasesTitle'),
          headerStyle: { backgroundColor: tide.sky[0] },
          headerTintColor: tide.text,
          headerShadowVisible: false,
          headerRight: () => (
            <PrismButton
              shape="round"
              size={MIC_SIZE}
              verb="speak"
              onPress={() => router.push({ pathname: '/record', params: { mode: 'topic' } })}
              accessibilityRole="button"
              accessibilityLabel={t('phrases.micLabel')}>
              <View style={styles.recordDot} />
            </PrismButton>
          ),
        }}
      />
      <View style={styles.promptWrap}>
        <Text style={[styles.prompt, dir.text]}>{t('phrases.prompt')}</Text>
        <Text style={[styles.hint, dir.text]}>{t('phrases.promptHint')}</Text>
      </View>
      {error ? (
        <Pressable style={styles.center} onPress={retry} accessibilityRole="button">
          <Text style={[styles.hint, styles.centerText]}>{error}</Text>
        </Pressable>
      ) : !topics ? (
        <View style={styles.center}>
          <CatConstellation size={120} label={t('common.loading')} />
        </View>
      ) : (
        <View style={styles.fill}>
        <FlatList
          style={styles.fill}
          contentContainerStyle={styles.list}
          columnWrapperStyle={styles.row}
          numColumns={2}
          data={topics}
          keyExtractor={(topic) => topic.id}
          renderItem={({ item }) => {
            const title = lang === 'he' ? (item.titleHe ?? item.title) : item.title;
            const he = lang !== 'he' && !!item.titleHe && item.titleHe !== item.title ? `${item.titleHe} · ` : '';
            const look = TOPIC_LOOK[item.id] ?? FALLBACK_LOOK;
            return (
              <PressScale
                style={styles.tile}
                accessibilityRole="button"
                onPress={() => router.push({ pathname: '/phrases/build', params: { topic: item.id } })}>
                <TopicTile look={look}>
                  <Text style={styles.glyph}>{look.emoji}</Text>
                  {item.added ? (
                    <View style={styles.added} accessibilityLabel={t('phrases.added')}>
                      <SymbolView name={{ ios: 'checkmark', android: 'check' }} size={11} weight="bold" tintColor={tide.text} />
                    </View>
                  ) : null}
                  <View style={styles.tx}>
                    <Text style={[styles.title, dir.text]} numberOfLines={2}>
                      {title}
                    </Text>
                    <Text style={[styles.count, dir.text]} numberOfLines={1}>
                      {he}
                      {t('home.phrasesCount', { count: item.count })}
                    </Text>
                  </View>
                </TopicTile>
              </PressScale>
            );
          }}
        />
        </View>
      )}
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1 },
  recordDot: { width: 13, height: 13, borderRadius: 7, backgroundColor: tide.record },
  promptWrap: { paddingHorizontal: SIDE, paddingTop: Spacing.sm, gap: 4 },
  prompt: { fontSize: 20, lineHeight: 26, color: tide.text, fontFamily: fonts.uiMedium, fontWeight: '500' },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: Spacing.lg, paddingHorizontal: SIDE },
  centerText: { textAlign: 'center' },
  hint: { fontSize: 14, lineHeight: 20, color: tide.textDim, fontFamily: fonts.ui },
  list: { paddingHorizontal: SIDE, paddingVertical: Spacing.md, gap: 12 },
  row: { gap: 12 },
  tile: { flex: 1 },
  card: {
    height: TILE_H,
    borderRadius: TILE_RADIUS,
    overflow: 'hidden',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.14)',
    backgroundColor: 'rgba(20,28,44,0.72)',
  },
  glyph: { position: 'absolute', right: 10, top: 4, fontSize: 40, lineHeight: 50, opacity: 0.9 },
  added: {
    position: 'absolute',
    left: 10,
    top: 10,
    width: 20,
    height: 20,
    borderRadius: 10,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(255,255,255,0.18)',
  },
  tx: { position: 'absolute', left: 12, right: 12, bottom: 10, gap: 2 },
  title: { fontSize: 15, lineHeight: 20, color: '#fff', fontFamily: fonts.uiMedium, fontWeight: '600' },
  count: { fontSize: 11.5, lineHeight: 16, color: tide.textDim, fontFamily: fonts.ui },
});
