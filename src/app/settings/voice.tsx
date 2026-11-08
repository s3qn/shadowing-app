import { useAudioPlayer, useAudioPlayerStatus } from 'expo-audio';
import { useFocusEffect } from 'expo-router';
import { useCallback, useEffect, useRef, useState } from 'react';
import { FlatList, Image, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { LanguageCard } from '@/components/language-card';
import { Segmented } from '@/components/segmented';
import { ErrorState, LoadingBlock } from '@/components/state-blocks';
import { Spacing, tide } from '@/constants/theme';
import * as api from '@/lib/api';
import { applyPlaybackMode, scheduleAudioSessionRelease, startPlayback, useSessionPlayer } from '@/lib/audio-mode';
import { midSentence, useDir, useT } from '@/lib/i18n';
import { localizeVoicePart } from '@/lib/voice-label';
import { getLanguage, type LanguageId } from '@/lib/languages';
import { getSettingsSync, getVoice, setVoice, subscribeSettings, toIslandLanguage } from '@/lib/settings';
import { type Key } from '@/locales/en';

/** The name shown for a catalogue language id, translated (the picker's
 * `english` field is only a fallback key for a language `language.<id>`
 * has never covered, which should not happen for anything read back out of
 * settings). */
function languageName(t: (key: Key) => string, id: LanguageId): string {
  const key = `language.${id}` as Key;
  return getLanguage(id) ? t(key) : id;
}

export default function VoiceScreen() {
  const { t, lang: appLang } = useT();
  const dir = useDir();
  const [speakers, setSpeakers] = useState<api.Speaker[]>([]);
  const [chosen, setChosen] = useState<number | null>(null);
  const [error, setError] = useState('');
  const [attempt, setAttempt] = useState(0);
  const player = useAudioPlayer(null);
  const status = useAudioPlayerStatus(player);
  useSessionPlayer(player);

  const [learningLanguage, setLearningLanguageState] = useState(() => getSettingsSync().learningLanguage);
  useEffect(() => subscribeSettings(() => setLearningLanguageState(getSettingsSync().learningLanguage)), []);
  // The language the voice list and the saved pick actually belong to: a
  // "coming soon" pick from the catalogue (French, Korean and so on) falls
  // back to Japanese, since that is the only one islands are built in today.
  const island = toIslandLanguage(learningLanguage);
  const comingSoonName = island !== learningLanguage ? languageName(t, learningLanguage) : null;

  useEffect(() => {
    void applyPlaybackMode();
  }, []);

  // A voice preview also gives the music back once it finishes. The release
  // is skipped while any other mounted player (a loop on the island screen
  // underneath) is playing or starting, see `scheduleAudioSessionRelease`.
  const wasPlaying = useRef(false);
  useEffect(() => {
    if (wasPlaying.current && !status.playing) scheduleAudioSessionRelease();
    wasPlaying.current = status.playing;
  }, [status.playing]);

  useFocusEffect(
    useCallback(() => {
      let alive = true;
      (async () => {
        try {
          const [list, current] = await Promise.all([
            api.listSpeakers(island),
            getVoice(island),
          ]);
          if (!alive) return;
          setSpeakers(list);
          setChosen(current);
        } catch (e) {
          if (alive) setError(e instanceof Error ? e.message : t('settings.voice.loadError'));
        }
      })();
      return () => {
        alive = false;
      };
    }, [island, t, attempt]),
  );

  // Tapping a style both previews it and makes it the voice for new islands.
  async function pick(styleId: number) {
    setChosen(styleId);
    await setVoice(styleId, island);
    player.replace({ uri: api.voicePreviewUrl(styleId) });
    startPlayback(player);
  }

  const chosenSpeaker = speakers.find((sp) => sp.styles.some((st) => st.id === chosen));
  const islandName = midSentence(appLang, languageName(t, island));

  return (
    <SafeAreaView edges={['bottom']} style={StyleSheet.flatten([styles.fill, { backgroundColor: tide.sky[0] }])}>
      <FlatList
        data={speakers}
        keyExtractor={(sp) => sp.uuid}
        contentContainerStyle={styles.list}
        ListHeaderComponent={
          <View style={styles.header}>
            {comingSoonName ? (
              <Text style={[styles.hint, { color: tide.textDim }, dir.text]}>
                {t('settings.voice.comingSoonNote', { name: comingSoonName, lang: islandName })}
              </Text>
            ) : null}
            <Text style={[styles.hint, { color: tide.textDim }, dir.text]}>
              {t('settings.voice.availableFor', { lang: islandName })}
            </Text>
          </View>
        }
        ListEmptyComponent={
          error ? (
            <ErrorState
              message={error}
              onRetry={() => {
                setError('');
                setAttempt((n) => n + 1);
              }}
            />
          ) : (
            <LoadingBlock />
          )
        }
        ListFooterComponent={
          chosenSpeaker && chosenSpeaker.policy ? (
            <Text style={[styles.credit, { color: tide.textDim }]}>
              {t('settings.voice.credit', { name: chosenSpeaker.name })}
            </Text>
          ) : null
        }
        renderItem={({ item: sp }) => {
          const active = sp.styles.find((st) => st.id === chosen) ?? sp.styles[0];
          const name = localizeVoicePart(t, sp.name);
          return (
            <LanguageCard
              // A voice's own name (Japanese for VOICEVOX) reads by its own script, not the interface's.
              avatar={
                active?.icon ? (
                  <Image source={{ uri: api.iconUrl(active.icon) }} style={styles.icon} />
                ) : (
                  (active?.name ?? sp.name).charAt(0).toUpperCase()
                )
              }
              title={name}
              subtitle={sp.kind === 'hosted' ? t('settings.voice.hostedNote', { n: sp.limit ?? 60 }) : undefined}
              selected={sp.styles.some((st) => st.id === chosen)}
              onPress={() => {
                if (sp.styles[0]) void pick(sp.styles[0].id);
              }}>
              <Segmented
                scrollable
                options={sp.styles.map((st) => ({ value: String(st.id), label: localizeVoicePart(t, st.name) }))}
                value={String(chosen)}
                onChange={(v) => void pick(Number(v))}
              />
            </LanguageCard>
          );
        }}
      />
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1 },
  list: { padding: Spacing.lg, paddingBottom: 170 },
  header: { gap: Spacing.xs, marginBottom: Spacing.sm },
  icon: { width: 40, height: 40 },
  hint: { fontSize: 14, lineHeight: 20 },
  credit: { fontSize: 12, lineHeight: 18, marginTop: Spacing.lg, textAlign: 'center' },
});
