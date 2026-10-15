import { Stack, useRouter } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { useCallback, useEffect, useRef, useState } from 'react';
import { FlatList, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import Animated, { useAnimatedStyle, useSharedValue, withSpring, withTiming } from 'react-native-reanimated';
import { SafeAreaView } from 'react-native-safe-area-context';

import { CatConstellation } from '@/components/cat-constellation';
import { PressScale } from '@/components/press-scale';
import { GlassPanel } from '@/components/prism';
import { LitPillCover, LitPillRim, PILL_H, PILL_ICON_OFF, PILL_LABEL_SIZE, PILL_PAD_X, PillTrayShell } from '@/components/prism/pill-tray';

import { fonts } from '@/constants/fonts';
import { Spacing, prism, tide } from '@/constants/theme';
import * as api from '@/lib/api';
import { useDir, useT } from '@/lib/i18n';
import { getSettingsSync, subscribeSettings, toIslandLanguage } from '@/lib/settings';

const SIDE = 16;

const PILL_BORDER = 1;
const PILL_INNER_H = PILL_H - 2 * PILL_BORDER;

/** Preset situations: the label key and the search word the backend matches. */
const PRESETS = [
  { key: 'hello', q: 'hello' },
  { key: 'restaurant', q: 'restaurant' },
  { key: 'train', q: 'train' },
  { key: 'intro', q: 'introduce' },
  { key: 'shopping', q: 'shopping' },
  { key: 'help', q: 'help' },
  { key: 'chat', q: 'chat' },
  { key: 'weather', q: 'weather' },
] as const;

/** One chip in a pill tray: same look and lit crossfade as the Home sort row. */
function Chip({ on, label, onPress }: { on: boolean; label: string; onPress: () => void }) {
  const litOpacity = useSharedValue(on ? 1 : 0);
  const scale = useSharedValue(1);
  useEffect(() => {
    litOpacity.value = withTiming(on ? 1 : 0, { duration: 200 });
  }, [on, litOpacity]);
  const scaleStyle = useAnimatedStyle(() => ({ transform: [{ scale: scale.value }] }));
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ selected: on }}
      onPress={onPress}
      onPressIn={() => {
        scale.value = withTiming(0.96, { duration: 80 });
      }}
      onPressOut={() => {
        scale.value = withSpring(1, prism.press.spring);
      }}>
      <Animated.View style={[styles.pill, scaleStyle]}>
        <LitPillCover height={PILL_INNER_H} opacity={litOpacity} />
        <LitPillRim radius={PILL_INNER_H / 2} opacity={litOpacity} />
        <Text style={[styles.pillText, { color: on ? prism.tray.lit.label : PILL_ICON_OFF }]}>{label}</Text>
      </Animated.View>
    </Pressable>
  );
}

export default function PhrasesScreen() {
  const router = useRouter();
  const { t, lang } = useT();
  const dir = useDir();

  const [topics, setTopics] = useState<api.PhraseTopic[] | null>(null);
  const [categories, setCategories] = useState<api.PhraseCategory[]>([]);
  const [error, setError] = useState('');
  const [preset, setPreset] = useState('');
  const [category, setCategory] = useState('');
  const [attempt, setAttempt] = useState(0);
  const [learningLanguage, setLearningLanguage] = useState(() => getSettingsSync().learningLanguage);
  useEffect(() => subscribeSettings(() => setLearningLanguage(getSettingsSync().learningLanguage)), []);
  const requestId = useRef(0);

  useEffect(() => {
    const id = ++requestId.current;
    const q = PRESETS.find((p) => p.key === preset)?.q ?? '';
    setTopics(null);
    setError('');
    api
      .phraseSearch(toIslandLanguage(learningLanguage), lang, q, category)
      .then((res) => {
        if (id !== requestId.current) return;
        setTopics(res.topics);
        if (res.categories) setCategories(res.categories);
      })
      .catch(() => {
        if (id === requestId.current) setError(t('home.phrasesError'));
      });
  }, [learningLanguage, lang, t, preset, category, attempt]);

  const retry = useCallback(() => setAttempt((n) => n + 1), []);
  const trayWrap = [styles.trayWrap, dir.rtl && styles.trayWrapRtl];

  const chips = (
    <View style={styles.chips}>
      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.chipScroll}>
        <PillTrayShell wrapStyle={trayWrap} style={[styles.tray, dir.row]}>
          {PRESETS.map((p) => (
            <Chip
              key={p.key}
              on={preset === p.key}
              label={t(`phrases.preset.${p.key}`)}
              onPress={() => setPreset(preset === p.key ? '' : p.key)}
            />
          ))}
        </PillTrayShell>
      </ScrollView>
      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.chipScroll}>
        <PillTrayShell wrapStyle={trayWrap} style={[styles.tray, dir.row]}>
          <Chip on={category === ''} label={t('phrases.all')} onPress={() => setCategory('')} />
          {categories.map((c) => (
            <Chip
              key={c.id}
              on={category === c.id}
              label={lang === 'he' ? (c.titleHe ?? c.title) : c.title}
              onPress={() => setCategory(category === c.id ? '' : c.id)}
            />
          ))}
        </PillTrayShell>
      </ScrollView>
    </View>
  );

  return (
    <SafeAreaView edges={['bottom']} style={StyleSheet.flatten([styles.fill, { backgroundColor: tide.sky[0] }])}>
      <StatusBar style="light" />
      <Stack.Screen
        options={{
          title: t('home.phrasesTitle'),
          headerStyle: { backgroundColor: tide.sky[0] },
          headerTintColor: tide.text,
          headerShadowVisible: false,
        }}
      />
      {chips}
      {error ? (
        <Pressable style={styles.center} onPress={retry} accessibilityRole="button">
          <Text style={[styles.hint, styles.centerText]}>{error}</Text>
        </Pressable>
      ) : !topics ? (
        <View style={styles.center}>
          <CatConstellation size={120} label={t('common.loading')} />
        </View>
      ) : topics.length === 0 ? (
        <View style={styles.center}>
          <Text style={[styles.hint, styles.centerText]}>{t('phrases.noMatch')}</Text>
        </View>
      ) : (
        <FlatList
          style={styles.fill}
          contentContainerStyle={styles.list}
          data={topics}
          keyExtractor={(topic) => topic.id}
          renderItem={({ item }) => {
            const samples = item.samples?.length ? item.samples : [item.sample];
            const lines = item.matchedPhrase
              ? [item.matchedPhrase, ...samples.filter((x) => x !== item.matchedPhrase)].slice(0, 3)
              : samples;
            const title = lang === 'he' ? (item.titleHe ?? item.title) : item.title;
            const showHe = lang !== 'he' && !!item.titleHe && item.titleHe !== item.title;
            return (
              <PressScale
                accessibilityRole="button"
                onPress={() => router.push({ pathname: '/phrases/build', params: { topic: item.id } })}>
                <GlassPanel style={styles.card}>
                  <View style={[styles.titleRow, dir.row]}>
                    <Text style={[styles.title, dir.text]}>{title}</Text>
                    {item.added ? <Text style={styles.badge}>{t('phrases.added')}</Text> : null}
                  </View>
                  {showHe ? <Text style={[styles.count, styles.heTitle]}>{item.titleHe}</Text> : null}
                  <Text style={[styles.count, dir.text]}>{t('home.phrasesCount', { count: item.count })}</Text>
                  {lines.map((line, i) => (
                    <View key={`${i}-${line}`}>
                      {i === 0 && item.matchedPhrase ? (
                        <Text style={[styles.count, dir.text]}>{t('phrases.matched')}</Text>
                      ) : null}
                      <Text style={styles.sample} numberOfLines={2}>
                        {line}
                      </Text>
                    </View>
                  ))}
                </GlassPanel>
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
  chips: { gap: Spacing.sm, paddingVertical: Spacing.sm },
  chipScroll: { paddingHorizontal: SIDE },
  trayWrap: { alignSelf: 'flex-start' },
  trayWrapRtl: { alignSelf: 'flex-end' },
  tray: { flexDirection: 'row', gap: Spacing.sm },
  pill: {
    alignItems: 'center',
    justifyContent: 'center',
    height: PILL_H,
    borderRadius: PILL_H / 2,
    overflow: 'hidden',
    borderWidth: PILL_BORDER,
    borderColor: 'rgba(255,255,255,0.05)',
    backgroundColor: prism.tray.pillFill,
    paddingHorizontal: PILL_PAD_X,
  },
  pillText: { fontSize: PILL_LABEL_SIZE, fontWeight: '600', fontFamily: fonts.ui },
  titleRow: { alignItems: 'center', justifyContent: 'space-between', gap: Spacing.sm },
  badge: { fontSize: 12, lineHeight: 16, color: tide.textDim, fontFamily: fonts.ui },
  heTitle: { writingDirection: 'rtl', textAlign: 'left' },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: Spacing.lg, paddingHorizontal: SIDE },
  centerText: { textAlign: 'center' },
  hint: { fontSize: 14, lineHeight: 20, color: tide.textDim, fontFamily: fonts.ui },
  list: { paddingHorizontal: SIDE, paddingVertical: Spacing.md, gap: Spacing.sm },
  card: { padding: Spacing.md, gap: 4 },
  title: { fontSize: 17, lineHeight: 22, color: tide.text, fontFamily: fonts.uiMedium, fontWeight: '500' },
  count: { fontSize: 13, lineHeight: 18, color: tide.textDim, fontFamily: fonts.ui },
  sample: { marginTop: 4, fontSize: 15, lineHeight: 22, color: tide.text, fontFamily: fonts.ui, writingDirection: 'ltr', textAlign: 'left' },
});
