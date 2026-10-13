import { Stack, useRouter } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { useEffect, useState } from 'react';
import { FlatList, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { CatConstellation } from '@/components/cat-constellation';
import { PressScale } from '@/components/press-scale';
import { GlassPanel } from '@/components/prism';

import { fonts } from '@/constants/fonts';
import { Spacing, tide } from '@/constants/theme';
import * as api from '@/lib/api';
import { useDir, useT } from '@/lib/i18n';
import { getSettingsSync, subscribeSettings, toIslandLanguage } from '@/lib/settings';

const SIDE = 16;

export default function PhrasesScreen() {
  const router = useRouter();
  const { t, lang } = useT();
  const dir = useDir();

  const [catalog, setCatalog] = useState<api.PhraseCatalog | null>(null);
  const [error, setError] = useState('');
  const [learningLanguage, setLearningLanguage] = useState(() => getSettingsSync().learningLanguage);
  useEffect(() => subscribeSettings(() => setLearningLanguage(getSettingsSync().learningLanguage)), []);

  useEffect(() => {
    setCatalog(null);
    setError('');
    api
      .phraseCatalog(toIslandLanguage(learningLanguage), lang)
      .then(setCatalog)
      .catch(() => setError(t('home.phrasesError')));
  }, [learningLanguage, lang, t]);

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
      {error ? (
        <View style={styles.center}>
          <Text style={[styles.hint, styles.centerText]}>{error}</Text>
        </View>
      ) : !catalog ? (
        <View style={styles.center}>
          <CatConstellation size={120} label={t('common.loading')} />
        </View>
      ) : (
        <FlatList
          style={styles.fill}
          contentContainerStyle={styles.list}
          data={catalog.topics}
          keyExtractor={(topic) => topic.id}
          renderItem={({ item }) => (
            <PressScale
              accessibilityRole="button"
              onPress={() => router.push({ pathname: '/phrases/build', params: { topic: item.id } })}>
              <GlassPanel style={styles.card}>
                <Text style={[styles.title, dir.text]}>{item.title}</Text>
                <Text style={[styles.count, dir.text]}>{t('home.phrasesCount', { count: item.count })}</Text>
                <Text style={styles.sample} numberOfLines={2}>
                  {item.sample}
                </Text>
              </GlassPanel>
            </PressScale>
          )}
        />
      )}
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1 },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: Spacing.lg, paddingHorizontal: SIDE },
  centerText: { textAlign: 'center' },
  hint: { fontSize: 14, lineHeight: 20, color: tide.textDim, fontFamily: fonts.ui },
  list: { paddingHorizontal: SIDE, paddingVertical: Spacing.md, gap: Spacing.sm },
  card: { padding: Spacing.md, gap: 4 },
  title: { fontSize: 17, lineHeight: 22, color: tide.text, fontFamily: fonts.uiMedium, fontWeight: '500' },
  count: { fontSize: 13, lineHeight: 18, color: tide.textDim, fontFamily: fonts.ui },
  sample: { marginTop: 4, fontSize: 15, lineHeight: 22, color: tide.text, fontFamily: fonts.ui, writingDirection: 'ltr', textAlign: 'left' },
});
