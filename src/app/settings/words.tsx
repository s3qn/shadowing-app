import { router } from 'expo-router';
import { useAudioPlayer } from 'expo-audio';
import { useMemo, useState } from 'react';
import { ScrollView, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { CatConstellation } from '@/components/cat-constellation';
import { PrismButton } from '@/components/prism/prism-button';
import { Segmented } from '@/components/segmented';
import { BottomSheet } from '@/components/sheet/bottom-sheet';
import { SettingsRow, SettingsSection } from '@/components/tide/settings-row';
import { fonts } from '@/constants/fonts';
import { Spacing, tide } from '@/constants/theme';
import { useKnownWords } from '@/hooks/use-known-words';
import * as api from '@/lib/api';
import { useDir, useT } from '@/lib/i18n';
import { DEFAULT_VOICE_BY_LANGUAGE, getSettingsSync } from '@/lib/settings';

type Filter = 'all' | 'learning' | 'known';

/** My words: a read-only list of the words caught in Catch the word. Grading stays in the game. */
export default function WordsScreen() {
  const { t } = useT();
  const dir = useDir();
  const { data, loading, failed, reload } = useKnownWords();
  const [filter, setFilter] = useState<Filter>('all');
  const [open, setOpen] = useState<api.CatchCollectionWord | null>(null);
  const [sheetOpen, setSheetOpen] = useState(false);
  const player = useAudioPlayer(null);

  const language = getSettingsSync().learningLanguage;
  const speaker = getSettingsSync().voices[language] ?? DEFAULT_VOICE_BY_LANGUAGE[language];

  const shown = useMemo(
    () => (data?.words ?? []).filter((w) => filter === 'all' || w.state === filter),
    [data, filter],
  );
  const options = useMemo(
    () => [
      { value: 'all' as const, label: t('settings.words.all') },
      { value: 'learning' as const, label: t('settings.words.learning') },
      { value: 'known' as const, label: t('settings.words.known') },
    ],
    [t],
  );

  function hear(word: string) {
    player.replace({ uri: api.wordAudioUrl(word, speaker) });
    player.play();
  }

  function centered(children: React.ReactNode) {
    return <View style={styles.center}>{children}</View>;
  }

  let body;
  if (!data && loading) {
    body = centered(<CatConstellation size={120} />);
  } else if (!data && failed) {
    body = centered(
      <>
        <Text style={[styles.line, { color: tide.textDim }]}>{t('settings.words.failed')}</Text>
        <PrismButton shape="pill" verb="listen" label={t('common.retry')} onPress={reload} />
      </>,
    );
  } else if (!data || data.total === 0) {
    body = centered(
      <>
        <Text style={[styles.line, { color: tide.textDim }]}>{t('settings.words.empty')}</Text>
        <PrismButton shape="pill" verb="listen" label={t('settings.words.play')} onPress={() => router.navigate('/(tabs)')} />
      </>,
    );
  } else {
    body = (
      <ScrollView contentContainerStyle={styles.list}>
        <SettingsSection title={t('settings.words.stats')}>
          <SettingsRow label={t('settings.words.known')} value={String(data.known)} />
          <SettingsRow label={t('settings.words.learning')} value={String(data.learning)} last />
        </SettingsSection>
        <Segmented options={options} value={filter} onChange={setFilter} />
        <SettingsSection title={t('settings.words.list')}>
          {shown.length === 0 ? (
            <SettingsRow label={t('settings.words.none')} last />
          ) : (
            shown.map((w, i) => (
              <SettingsRow
                key={w.word}
                label={w.meaning ? `${w.word}  ${w.meaning}` : w.word}
                value={t(w.state === 'known' ? 'settings.words.known' : 'settings.words.learning')}
                last={i === shown.length - 1}
                onPress={() => {
                  setOpen(w);
                  setSheetOpen(true);
                }}
              />
            ))
          )}
        </SettingsSection>
      </ScrollView>
    );
  }

  return (
    <SafeAreaView edges={['bottom']} style={StyleSheet.flatten([styles.fill, { backgroundColor: tide.sky[0] }])}>
      {body}
      <BottomSheet open={sheetOpen} onClose={() => setSheetOpen(false)} onDismissed={() => setOpen(null)} title={open?.word} contentTitle>
        {open ? (
          <View style={styles.sheet}>
            {open.meaning ? <Text style={[styles.meaning, { color: tide.text }, dir.text]}>{open.meaning}</Text> : null}
            {open.sentence ? <Text style={[styles.sentence, { color: tide.textDim }]}>{open.sentence}</Text> : null}
            <Text style={[styles.counts, { color: tide.textDim }, dir.text]}>
              {t('settings.words.counts', { caught: open.caught, missed: open.missed })}
            </Text>
            <PrismButton shape="pill" verb="listen" label={t('settings.words.hear')} onPress={() => hear(open.word)} />
          </View>
        ) : null}
      </BottomSheet>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1 },
  list: { padding: Spacing.lg, gap: Spacing.lg, paddingBottom: 170 },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: Spacing.lg, padding: Spacing.lg },
  line: { fontFamily: fonts.ui, fontSize: 16, textAlign: 'center' },
  sheet: { gap: Spacing.md, paddingHorizontal: Spacing.lg, paddingBottom: Spacing.lg, alignItems: 'center' },
  meaning: { fontFamily: fonts.uiMedium, fontSize: 20 },
  sentence: { fontFamily: fonts.ui, fontSize: 16, textAlign: 'center' },
  counts: { fontFamily: fonts.ui, fontSize: 14 },
});
