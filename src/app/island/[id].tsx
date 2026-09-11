import { useAudioPlayer, useAudioPlayerStatus, setAudioModeAsync } from 'expo-audio';
import { Stack, useLocalSearchParams } from 'expo-router';
import { useEffect, useMemo, useState } from 'react';
import {
  ActivityIndicator,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { Radius, SPEEDS, Spacing } from '@/constants/theme';
import { useTheme } from '@/hooks/use-theme';
import * as api from '@/lib/api';
import { getVoice } from '@/lib/settings';

export default function IslandScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const { palette } = useTheme();

  const [island, setIsland] = useState<api.Island | null>(null);
  const [error, setError] = useState('');
  const [idx, setIdx] = useState(0);
  const [speed, setSpeed] = useState<number>(0.7);
  const [loop, setLoop] = useState(true);
  const [showEnglish, setShowEnglish] = useState(false);
  const [voice, setVoice] = useState<number | null>(null);
  const [voiceName, setVoiceName] = useState('');
  const [revoicing, setRevoicing] = useState(false);

  const line = island?.lines[idx];
  const source = useMemo(
    () => (island && line ? { uri: api.lineAudioUrl(island.id, line.idx) } : null),
    [island, line],
  );
  const player = useAudioPlayer(source);
  const status = useAudioPlayerStatus(player);

  useEffect(() => {
    void setAudioModeAsync({ playsInSilentMode: true });
  }, []);

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const data = await api.getIsland(id);
        if (alive) setIsland(data);
      } catch (e) {
        if (alive) setError(e instanceof Error ? e.message : 'Could not load this island');
      }
    })();
    return () => {
      alive = false;
    };
  }, [id]);

  // The chosen voice, and its display name, so the re-voice offer can say
  // which voice it would switch to.
  useEffect(() => {
    let alive = true;
    (async () => {
      const chosen = await getVoice();
      if (!alive) return;
      setVoice(chosen);
      try {
        const speakers = await api.listSpeakers();
        for (const sp of speakers) {
          const st = sp.styles.find((s) => s.id === chosen);
          if (st) {
            if (alive) setVoiceName(`${sp.name} ${st.name}`);
            break;
          }
        }
      } catch {
        // Name is decorative; the button still works without it.
      }
    })();
    return () => {
      alive = false;
    };
  }, []);

  async function doRevoice() {
    if (!island || voice === null || revoicing) return;
    setRevoicing(true);
    player.pause();
    try {
      await api.revoice(island.id, voice);
      for (let i = 0; i < 60; i += 1) {
        await new Promise((r) => setTimeout(r, 1000));
        const data = await api.getIsland(island.id);
        if (data.status === 'ready') {
          setIsland(data);
          setIdx(0);
          break;
        }
        if (data.status === 'failed') {
          setError(data.error || 'Re-voicing failed');
          break;
        }
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Re-voicing failed');
    } finally {
      setRevoicing(false);
    }
  }

  // Rate and loop are player properties, so they have to be pushed on every
  // change and again whenever the source swaps to a new line.
  useEffect(() => {
    player.shouldCorrectPitch = true;
    player.setPlaybackRate(speed, 'high');
    player.loop = loop;
  }, [player, speed, loop, idx]);

  useEffect(() => {
    if (status.didJustFinish && !loop) next();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status.didJustFinish]);

  function go(target: number) {
    if (!island) return;
    const clamped = Math.max(0, Math.min(island.lines.length - 1, target));
    setIdx(clamped);
  }
  const next = () => go(idx + 1);
  const prev = () => go(idx - 1);

  function toggle() {
    if (status.playing) player.pause();
    else {
      // Replaying from the top is what you want when a line has run to its end.
      if (status.duration > 0 && status.currentTime >= status.duration - 0.05) {
        void player.seekTo(0);
      }
      player.play();
    }
  }

  if (error) {
    return (
      <SafeAreaView style={StyleSheet.flatten([styles.fill, styles.center, { backgroundColor: palette.bg }])}>
        <Text style={[styles.body, { color: palette.danger }]}>{error}</Text>
      </SafeAreaView>
    );
  }
  if (!island || !line) {
    return (
      <SafeAreaView style={StyleSheet.flatten([styles.fill, styles.center, { backgroundColor: palette.bg }])}>
        <ActivityIndicator color={palette.accent} />
      </SafeAreaView>
    );
  }

  // currentTime is a position in the source audio, not wall clock, so it maps
  // straight onto the mora timeline no matter what the playback rate is.
  const activeMora = line.timeline.findIndex(
    (m) => status.currentTime >= m.start && status.currentTime < m.end,
  );
  const progress = status.duration > 0 ? status.currentTime / status.duration : 0;

  return (
    <SafeAreaView edges={['bottom']} style={StyleSheet.flatten([styles.fill, { backgroundColor: palette.bg }])}>
      <Stack.Screen options={{ title: island.title || 'Island' }} />

      <ScrollView contentContainerStyle={styles.scroll}>
        <Text style={[styles.counter, { color: palette.muted }]}>
          {idx + 1} of {island.lines.length}
        </Text>

        <Text style={[styles.ja, { color: palette.ink }]}>{line.ja}</Text>

        <View style={styles.reading}>
          {line.timeline.map((m, i) => (
            <Text
              key={i}
              style={[
                styles.mora,
                {
                  color: i === activeMora ? palette.accentInk : palette.muted,
                  backgroundColor: i === activeMora ? palette.accent : 'transparent',
                },
              ]}>
              {m.kana}
            </Text>
          ))}
        </View>

        <Pressable onPress={() => setShowEnglish((v) => !v)}>
          <Text style={[styles.en, { color: showEnglish ? palette.ink : palette.muted }]}>
            {showEnglish ? line.en : 'Tap to show the English'}
          </Text>
        </Pressable>
      </ScrollView>

      <View style={[styles.controls, { borderTopColor: palette.line }]}>
        <View style={[styles.track, { backgroundColor: palette.surfaceAlt }]}>
          <View
            style={[
              styles.trackFill,
              { backgroundColor: palette.accent, width: `${Math.round(progress * 100)}%` },
            ]}
          />
        </View>

        <View style={styles.speedRow}>
          {SPEEDS.map((s) => {
            const on = s === speed;
            return (
              <Pressable
                key={s}
                onPress={() => setSpeed(s)}
                style={[
                  styles.speed,
                  {
                    backgroundColor: on ? palette.accent : palette.surface,
                    borderColor: on ? palette.accent : palette.line,
                  },
                ]}>
                <Text style={[styles.speedText, { color: on ? palette.accentInk : palette.ink }]}>
                  {s}x
                </Text>
              </Pressable>
            );
          })}
          <Pressable
            onPress={() => setLoop((v) => !v)}
            style={[
              styles.speed,
              {
                backgroundColor: loop ? palette.accent : palette.surface,
                borderColor: loop ? palette.accent : palette.line,
              },
            ]}>
            <Text style={[styles.speedText, { color: loop ? palette.accentInk : palette.ink }]}>
              Loop
            </Text>
          </Pressable>
        </View>

        {voice !== null && island.speaker !== voice ? (
          <Pressable onPress={doRevoice} disabled={revoicing} style={styles.revoice}>
            <Text style={[styles.revoiceText, { color: revoicing ? palette.muted : palette.accent }]}>
              {revoicing ? 'Re-voicing…' : `Re-voice in ${voiceName || 'the chosen voice'}`}
            </Text>
          </Pressable>
        ) : null}

        <View style={styles.transport}>
          <Pressable onPress={prev} disabled={idx === 0} style={styles.side}>
            <Text style={[styles.sideText, { color: idx === 0 ? palette.line : palette.ink }]}>
              Back
            </Text>
          </Pressable>

          <Pressable onPress={toggle} style={[styles.play, { backgroundColor: palette.accent }]}>
            <Text style={[styles.playText, { color: palette.accentInk }]}>
              {status.playing ? 'Pause' : 'Play'}
            </Text>
          </Pressable>

          <Pressable
            onPress={next}
            disabled={idx >= island.lines.length - 1}
            style={styles.side}>
            <Text
              style={[
                styles.sideText,
                { color: idx >= island.lines.length - 1 ? palette.line : palette.ink },
              ]}>
              Next
            </Text>
          </Pressable>
        </View>
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1 },
  center: { alignItems: 'center', justifyContent: 'center' },
  scroll: { padding: Spacing.xl, gap: Spacing.lg, flexGrow: 1, justifyContent: 'center' },
  counter: { fontSize: 13, fontWeight: '600', textAlign: 'center' },
  ja: { fontSize: 32, lineHeight: 48, fontWeight: '600', textAlign: 'center' },
  reading: { flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'center' },
  mora: { fontSize: 20, lineHeight: 30, borderRadius: Radius.sm, overflow: 'hidden' },
  en: { fontSize: 15, lineHeight: 22, textAlign: 'center', marginTop: Spacing.sm },
  body: { fontSize: 15, lineHeight: 22, textAlign: 'center', padding: Spacing.xl },
  controls: { borderTopWidth: 1, padding: Spacing.lg, gap: Spacing.lg },
  track: { height: 4, borderRadius: 2, overflow: 'hidden' },
  trackFill: { height: 4, borderRadius: 2 },
  speedRow: { flexDirection: 'row', gap: Spacing.sm, justifyContent: 'center' },
  speed: {
    borderWidth: 1,
    borderRadius: Radius.pill,
    paddingVertical: Spacing.sm,
    paddingHorizontal: Spacing.md,
  },
  speedText: { fontSize: 13, fontWeight: '700' },
  revoice: { alignItems: 'center', paddingVertical: Spacing.xs },
  revoiceText: { fontSize: 14, fontWeight: '600' },
  transport: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  side: { paddingVertical: Spacing.md, paddingHorizontal: Spacing.lg },
  sideText: { fontSize: 16, fontWeight: '600' },
  play: {
    paddingVertical: Spacing.lg,
    paddingHorizontal: Spacing.xxl,
    borderRadius: Radius.pill,
    minWidth: 140,
    alignItems: 'center',
  },
  playText: { fontSize: 17, fontWeight: '700' },
});
