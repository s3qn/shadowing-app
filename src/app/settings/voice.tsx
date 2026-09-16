import { useAudioPlayer, useAudioPlayerStatus } from 'expo-audio';
import { useFocusEffect } from 'expo-router';
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  FlatList,
  Image,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { CatConstellation } from '@/components/cat-constellation';
import { PressScale } from '@/components/press-scale';
import { Radius, Spacing, tide } from '@/constants/theme';
import * as api from '@/lib/api';
import { applyPlaybackMode, scheduleAudioSessionRelease, startPlayback, useSessionPlayer } from '@/lib/audio-mode';
import { getVoice, setVoice } from '@/lib/settings';

export default function VoiceScreen() {
  const [speakers, setSpeakers] = useState<api.Speaker[]>([]);
  const [chosen, setChosen] = useState<number | null>(null);
  const [error, setError] = useState('');
  const player = useAudioPlayer(null);
  const status = useAudioPlayerStatus(player);
  useSessionPlayer(player);

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
          const [list, current] = await Promise.all([api.listSpeakers(), getVoice()]);
          if (!alive) return;
          setSpeakers(list);
          setChosen(current);
        } catch (e) {
          if (alive) setError(e instanceof Error ? e.message : 'Could not load voices');
        }
      })();
      return () => {
        alive = false;
      };
    }, []),
  );

  // Tapping a style both previews it and makes it the voice for new islands.
  async function pick(styleId: number) {
    setChosen(styleId);
    await setVoice(styleId);
    player.replace({ uri: api.voicePreviewUrl(styleId) });
    startPlayback(player);
  }

  const chosenSpeaker = speakers.find((sp) => sp.styles.some((st) => st.id === chosen));

  return (
    <SafeAreaView edges={['bottom']} style={StyleSheet.flatten([styles.fill, { backgroundColor: tide.sky[0] }])}>
      <FlatList
        data={speakers}
        keyExtractor={(sp) => sp.uuid}
        contentContainerStyle={styles.list}
        ListHeaderComponent={
          <View style={styles.header}>
            <Text style={[styles.title, { color: tide.text }]}>Voice</Text>
            <Text style={[styles.hint, { color: tide.textDim }]}>
              Tap a style to hear it. The one you pick is used for new islands.
            </Text>
          </View>
        }
        ListEmptyComponent={
          error ? (
            <Text style={[styles.hint, { color: tide.record }]}>{error}</Text>
          ) : (
            <View style={{ marginTop: Spacing.xl, alignItems: 'center' }}>
              <CatConstellation size={110} />
            </View>
          )
        }
        ListFooterComponent={
          chosenSpeaker ? (
            <Text style={[styles.credit, { color: tide.textDim }]}>
              Audio made with this voice is credited as VOICEVOX:{chosenSpeaker.name}
            </Text>
          ) : null
        }
        renderItem={({ item: sp }) => {
          const active = sp.styles.find((st) => st.id === chosen) ?? sp.styles[0];
          return (
            <View style={[styles.row, { backgroundColor: tide.water, borderColor: tide.waterline }]}>
              <View style={styles.rowTop}>
                {active ? (
                  <Image source={{ uri: api.iconUrl(active.icon) }} style={styles.icon} />
                ) : null}
                <Text style={[styles.name, { color: tide.text }]}>{sp.name}</Text>
              </View>
              <View style={styles.chips}>
                {sp.styles.map((st) => {
                  const on = st.id === chosen;
                  return (
                    <PressScale
                      key={st.id}
                      onPress={() => pick(st.id)}
                      style={[
                        styles.chip,
                        {
                          backgroundColor: on ? tide.lang.ja : 'rgba(255,255,255,0.08)',
                          borderColor: on ? tide.lang.ja : 'rgba(255,255,255,0.14)',
                        },
                      ]}>
                      <Text style={[styles.chipText, { color: on ? tide.sky[0] : tide.text }]}>
                        {st.name}
                      </Text>
                    </PressScale>
                  );
                })}
              </View>
            </View>
          );
        }}
      />
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1 },
  list: { padding: Spacing.lg, gap: Spacing.md, paddingBottom: 170 },
  header: { gap: Spacing.xs, marginBottom: Spacing.sm },
  title: { fontSize: 22, fontWeight: '700' },
  hint: { fontSize: 14, lineHeight: 20 },
  credit: { fontSize: 12, lineHeight: 18, marginTop: Spacing.lg, textAlign: 'center' },
  row: { borderWidth: 1, borderRadius: Radius.md, padding: Spacing.md, gap: Spacing.sm },
  rowTop: { flexDirection: 'row', alignItems: 'center', gap: Spacing.md },
  icon: { width: 44, height: 44, borderRadius: 22 },
  name: { fontSize: 17, fontWeight: '600' },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: Spacing.sm },
  chip: {
    borderWidth: 1,
    borderRadius: Radius.pill,
    paddingVertical: Spacing.xs + 2,
    paddingHorizontal: Spacing.md,
  },
  chipText: { fontSize: 13, fontWeight: '600' },
});
