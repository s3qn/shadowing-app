import Slider from '@react-native-community/slider';
import { useAudioPlayer, useAudioPlayerStatus, setAudioModeAsync } from 'expo-audio';
import { Stack, useLocalSearchParams } from 'expo-router';
import { useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { Radius, SPEED_MAX, SPEED_MIN, Spacing } from '@/constants/theme';
import { useTheme } from '@/hooks/use-theme';
import * as api from '@/lib/api';
import { getVoice } from '@/lib/settings';

export default function IslandScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const { palette } = useTheme();

  const [island, setIsland] = useState<api.Island | null>(null);
  const [error, setError] = useState('');
  const [idx, setIdx] = useState(0);
  // `speed` is what the audio was rendered at; `dragging` follows the thumb
  // live so the label moves, and only a release re-renders the line.
  const [speed, setSpeed] = useState<number>(0.7);
  const [dragging, setDragging] = useState<number | null>(null);
  const [loop, setLoop] = useState(true);
  const [showEnglish, setShowEnglish] = useState(false);
  const [voice, setVoice] = useState<number | null>(null);
  const [voiceName, setVoiceName] = useState('');
  const [revoicing, setRevoicing] = useState(false);

  const line = island?.lines[idx];
  const source = useMemo(
    () =>
      island && line
        ? { uri: api.lineAudioUrl(island.id, line.idx, island.speaker, speed) }
        : null,
    [island, line, speed],
  );
  // Native status arrives every 50ms; particles can be shorter than that, so
  // the position shown to the highlighter is interpolated between updates.
  const player = useAudioPlayer(source, { updateInterval: 50 });
  const status = useAudioPlayerStatus(player);
  const [position, setPosition] = useState(0);
  const anchor = useRef({ time: 0, at: Date.now(), playing: false, rate: 1 });

  useEffect(() => {
    const a = anchor.current;
    const now = Date.now();
    const estimate = a.playing ? a.time + ((now - a.at) / 1000) * a.rate : a.time;
    const native = status.currentTime;
    // Native updates lag the estimate by a few ms. Snapping back for that
    // would flash the previous word again at every boundary, so a small
    // backward step is ignored; a large one is a seek or the loop restarting.
    // The estimate may also run ahead while the stream buffers, so it is
    // capped a little past the last native position.
    const time =
      !status.playing || native > estimate || native < estimate - 0.4
        ? native
        : Math.min(estimate, native + 0.15);
    anchor.current = { time, at: now, playing: status.playing, rate: status.playbackRate || 1 };
    setPosition(time);
  }, [status.currentTime, status.playing, status.playbackRate]);

  useEffect(() => {
    const tick = setInterval(() => {
      const a = anchor.current;
      if (!a.playing) return;
      setPosition(a.time + ((Date.now() - a.at) / 1000) * a.rate);
    }, 30);
    return () => clearInterval(tick);
  }, []);

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

  // Speed is baked into the audio by VOICEVOX, so the player always runs at
  // 1.0. Loop is a player property and has to be pushed again whenever the
  // source swaps to a new line or speed.
  useEffect(() => {
    player.setPlaybackRate(1, 'high');
    player.loop = loop;
  }, [player, loop, idx, speed]);

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
  // straight onto the word spans no matter what the playback rate is.
  // Word spans are stored for speed 1.0; the rendered audio is 1/speed as long.
  const activeWord = line.words.findIndex(
    (w) => position >= w.start / speed && position < w.end / speed,
  );
  const reading = line.timeline.map((m) => m.kana).join('');
  const progress = status.duration > 0 ? status.currentTime / status.duration : 0;

  return (
    <SafeAreaView edges={['bottom']} style={StyleSheet.flatten([styles.fill, { backgroundColor: palette.bg }])}>
      <Stack.Screen options={{ title: island.title || 'Island' }} />

      <ScrollView contentContainerStyle={styles.scroll}>
        <Text style={[styles.counter, { color: palette.muted }]}>
          {idx + 1} of {island.lines.length}
        </Text>

        {line.words.length > 0 ? (
          <View style={styles.words}>
            {line.words.map((w, i) => (
              <Text
                key={i}
                style={[
                  styles.ja,
                  styles.word,
                  {
                    color: i === activeWord ? palette.accentInk : palette.ink,
                    backgroundColor: i === activeWord ? palette.accent : 'transparent',
                  },
                ]}>
                {w.text}
              </Text>
            ))}
          </View>
        ) : (
          <Text style={[styles.ja, { color: palette.ink }]}>{line.ja}</Text>
        )}

        <Text style={[styles.reading, { color: palette.muted }]}>{reading}</Text>

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
          <Text style={[styles.speedLabel, { color: palette.muted }]}>Speed</Text>
          <Slider
            style={styles.slider}
            minimumValue={SPEED_MIN}
            maximumValue={SPEED_MAX}
            step={0.05}
            value={speed}
            onValueChange={(v) => setDragging(Math.round(v * 20) / 20)}
            onSlidingComplete={(v) => {
              setDragging(null);
              setSpeed(Math.round(v * 20) / 20);
            }}
            minimumTrackTintColor={palette.accent}
            maximumTrackTintColor={palette.line}
            thumbTintColor={palette.accent}
            accessibilityLabel="Playback speed"
          />
          <Text style={[styles.speedValue, { color: palette.ink }]}>
            {(dragging ?? speed).toFixed(2)}x
          </Text>
          <Pressable
            onPress={() => setLoop((v) => !v)}
            style={[
              styles.loop,
              {
                backgroundColor: loop ? palette.accent : palette.surface,
                borderColor: loop ? palette.accent : palette.line,
              },
            ]}>
            <Text style={[styles.loopText, { color: loop ? palette.accentInk : palette.ink }]}>
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
  words: { flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'center' },
  word: { paddingHorizontal: 4, borderRadius: Radius.sm, overflow: 'hidden' },
  reading: { fontSize: 20, lineHeight: 30, textAlign: 'center' },
  en: { fontSize: 15, lineHeight: 22, textAlign: 'center', marginTop: Spacing.sm },
  body: { fontSize: 15, lineHeight: 22, textAlign: 'center', padding: Spacing.xl },
  controls: { borderTopWidth: 1, padding: Spacing.lg, gap: Spacing.lg },
  track: { height: 4, borderRadius: 2, overflow: 'hidden' },
  trackFill: { height: 4, borderRadius: 2 },
  speedRow: { flexDirection: 'row', alignItems: 'center', gap: Spacing.sm },
  speedLabel: { fontSize: 13, fontWeight: '600' },
  slider: { flex: 1, height: 40 },
  speedValue: { fontSize: 14, fontWeight: '700', fontVariant: ['tabular-nums'], minWidth: 52, textAlign: 'right' },
  loop: {
    borderWidth: 1,
    borderRadius: Radius.pill,
    paddingVertical: Spacing.sm,
    paddingHorizontal: Spacing.md,
  },
  loopText: { fontSize: 13, fontWeight: '700' },
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
