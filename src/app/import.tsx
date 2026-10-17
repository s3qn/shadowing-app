import * as DocumentPicker from 'expo-document-picker';
import { Stack, useRouter } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { CatConstellation } from '@/components/cat-constellation';
import { PrismButton } from '@/components/prism';
import { PressScale } from '@/components/press-scale';

import { HeaderClosePill } from '@/components/header-close-pill';
import { fonts } from '@/constants/fonts';
import { Radius, Spacing, tide } from '@/constants/theme';
import { useFollowBuild } from '@/hooks/use-follow-build';
import * as api from '@/lib/api';
import { useT } from '@/lib/i18n';
import { getSettings, getVoice, toIslandLanguage, toNativeLanguage } from '@/lib/settings';

const SIDE = 16;

type Phase = 'pick' | 'building';

/** The stem of a file name, the same default title the backend applies. */
function stem(name: string): string {
  const i = name.lastIndexOf('.');
  return i > 0 ? name.slice(0, i) : name;
}

export default function ImportScreen() {
  const { t } = useT();
  const router = useRouter();

  const [phase, setPhase] = useState<Phase>('pick');
  const [audio, setAudio] = useState<DocumentPicker.DocumentPickerAsset | null>(null);
  const [srt, setSrt] = useState<DocumentPicker.DocumentPickerAsset | null>(null);
  const [error, setError] = useState('');
  const { stage, follow, stop } = useFollowBuild('/island/[id]', (message) => {
    setError(message);
    setPhase('pick');
  });

  async function pickAudio() {
    setError('');
    const result = await DocumentPicker.getDocumentAsync({ type: 'audio/*', copyToCacheDirectory: true });
    if (result.canceled || !result.assets?.[0]) return;
    setAudio(result.assets[0]);
  }

  async function pickSubtitles() {
    setError('');
    const result = await DocumentPicker.getDocumentAsync({ type: '*/*', copyToCacheDirectory: true });
    if (result.canceled || !result.assets?.[0]) return;
    const asset = result.assets[0];
    if (!asset.name.toLowerCase().endsWith('.srt')) {
      setError(t('import.notSrt'));
      return;
    }
    setSrt(asset);
  }

  function cancel() {
    stop();
    router.back();
  }

  async function build() {
    if (!audio) return;
    setPhase('building');
    setError('');
    try {
      const settings = await getSettings();
      const { learningLanguage, understoodLanguage } = settings;
      const voice = await getVoice(learningLanguage);
      const { id } = await api.importIsland(
        audio.uri,
        srt?.uri ?? null,
        stem(audio.name),
        voice,
        toIslandLanguage(learningLanguage),
        toNativeLanguage(understoodLanguage),
      );
      follow(id);
    } catch (e) {
      setError(e instanceof Error ? e.message : t('import.uploadFailed'));
      setPhase('pick');
    }
  }

  return (
    <SafeAreaView edges={['bottom']} style={StyleSheet.flatten([styles.fill, { backgroundColor: tide.sky[0] }])}>
      <StatusBar style="light" />
      <Stack.Screen
        options={{
          headerStyle: { backgroundColor: tide.sky[0] },
          headerTintColor: tide.text,
          headerShadowVisible: false,
          headerLeft: () => <HeaderClosePill label={phase === 'building' ? t('record.close') : t('common.cancel')} onPress={cancel} />,
        }}
      />

      {phase === 'building' ? (
        <View style={styles.center}>
          <CatConstellation size={120} label={api.stageLabel(stage).replace(/…$/, '')} />
          <Text style={[styles.hint, styles.centerText]}>{t('import.buildHint')}</Text>
        </View>
      ) : (
        <>
          <ScrollView style={styles.fill} contentContainerStyle={styles.content}>
            <View style={styles.header}>
              <Text style={styles.title}>{t('import.title')}</Text>
              <Text style={styles.hint}>{t('import.hint')}</Text>
            </View>

            <PressScale onPress={pickAudio} accessibilityRole="button" style={styles.pickRow}>
              <Text style={styles.pickLabel}>{t('import.audio')}</Text>
              <Text style={styles.pickValue} numberOfLines={1}>
                {audio ? audio.name : t('import.choose')}
              </Text>
            </PressScale>

            <PressScale onPress={pickSubtitles} accessibilityRole="button" style={styles.pickRow}>
              <Text style={styles.pickLabel}>{t('import.subtitles')}</Text>
              <Text style={styles.pickValue} numberOfLines={1}>
                {srt ? srt.name : t('import.choose')}
              </Text>
            </PressScale>

            {error ? <Text style={styles.error}>{error}</Text> : null}
          </ScrollView>

          <View style={styles.actions}>
            <PrismButton
              shape="pill"
              verb="listen"
              on
              label={t('import.build')}
              disabled={!audio}
              onPress={build}
              accessibilityRole="button"
              containerStyle={styles.primary}
            />
          </View>
        </>
      )}
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1 },
  content: {
    flexGrow: 1,
    paddingHorizontal: SIDE,
    paddingTop: Spacing.lg,
    paddingBottom: Spacing.xl,
    gap: Spacing.lg,
  },
  center: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    gap: Spacing.lg,
    paddingHorizontal: SIDE,
  },
  centerText: { textAlign: 'center' },
  header: { gap: Spacing.sm },
  title: { fontSize: 20, lineHeight: 26, color: tide.text, fontFamily: fonts.uiMedium, fontWeight: '500' },
  hint: { fontSize: 14, lineHeight: 20, color: tide.textDim, fontFamily: fonts.ui },
  pickRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: Spacing.md,
    padding: Spacing.md,
    borderRadius: Radius.md,
    backgroundColor: 'rgba(255,255,255,0.06)',
  },
  pickLabel: { fontSize: 15, color: tide.text, fontFamily: fonts.uiMedium, fontWeight: '500' },
  pickValue: { flex: 1, textAlign: 'right', fontSize: 14, color: tide.textDim, fontFamily: fonts.ui },
  error: { fontSize: 14, lineHeight: 20, color: tide.record, fontFamily: fonts.ui },
  actions: { paddingHorizontal: SIDE, paddingTop: Spacing.md, paddingBottom: Spacing.sm, gap: Spacing.xs },
  primary: { alignSelf: 'center' },
});
