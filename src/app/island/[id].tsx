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

import { POPOVER_WIDTH, WordPanel } from '@/components/word-panel';
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
  // Loop is done by hand rather than with the player's own loop, so there is
  // a moment to breathe before the sentence comes around again.
  const LOOP_GAP_MS = 2000;
  const gapTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Seconds left in the breath between repeats; null when not in a breath.
  const [countdown, setCountdown] = useState<number | null>(null);
  const tickTimer = useRef<ReturnType<typeof setInterval> | null>(null);
  // True from the moment a looped line starts until Stop, so the UI can say
  // "you are inside a loop" even during the quiet gap.
  const [looping, setLooping] = useState(false);
  function cancelGap() {
    if (gapTimer.current) {
      clearTimeout(gapTimer.current);
      gapTimer.current = null;
    }
    if (tickTimer.current) {
      clearInterval(tickTimer.current);
      tickTimer.current = null;
    }
    setCountdown(null);
  }
  const [showEnglish, setShowEnglish] = useState(false);
  const [voice, setVoice] = useState<number | null>(null);
  const [voiceName, setVoiceName] = useState('');
  const [revoicing, setRevoicing] = useState(false);
  // The tapped word, its dictionary result, and the timer that ends Hear it.
  const [selected, setSelected] = useState<number | null>(null);
  const [glossData, setGlossData] = useState<api.Gloss | null>(null);
  // Where each word sits inside the sentence block, so the popover can sit
  // right under the tapped one without moving anything else.
  const wordBoxes = useRef<Record<number, { x: number; y: number; width: number; height: number }>>({});
  const [blockWidth, setBlockWidth] = useState(0);

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

  // The tapped word has its own render and its own player, so hearing it never
  // moves the line's player or the highlight.
  const wordSource = useMemo(
    () =>
      island && line && selected !== null && line.words[selected]
        ? { uri: api.wordAudioUrl(line.words[selected]!.text, island.speaker) }
        : null,
    [island, line, selected],
  );
  const wordPlayer = useAudioPlayer(wordSource);
  const wordStatus = useAudioPlayerStatus(wordPlayer);
  const autoPlayed = useRef<string | null>(null);

  // Play the word once as soon as its audio is ready, for each new selection.
  useEffect(() => {
    const key = wordSource?.uri ?? null;
    if (!key || !wordStatus.isLoaded || autoPlayed.current === key) return;
    autoPlayed.current = key;
    wordPlayer.play();
  }, [wordSource, wordStatus.isLoaded, wordPlayer]);
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

  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const data = await api.getIsland(id);
        if (alive) {
          setIsland(data);
          setError('');
        }
      } catch (e) {
        if (alive) setError(e instanceof Error ? e.message : 'Could not load this island');
      }
    })();
    return () => {
      alive = false;
    };
  }, [id, attempt]);

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
      // A poll can fail while the server is briefly unreachable; that is not
      // the island failing, so keep polling.
      for (let i = 0; i < 60; i += 1) {
        await new Promise((r) => setTimeout(r, 1000));
        let data: api.Island;
        try {
          data = await api.getIsland(island.id);
        } catch {
          continue;
        }
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
    player.loop = false;
  }, [player, idx, speed]);

  useEffect(() => cancelGap, []);

  useEffect(() => {
    if (!status.didJustFinish) return;
    if (loop) {
      cancelGap();
      setLooping(true);
      let left = Math.round(LOOP_GAP_MS / 1000);
      setCountdown(left);
      tickTimer.current = setInterval(() => {
        left -= 1;
        setCountdown(left > 0 ? left : null);
      }, 1000);
      gapTimer.current = setTimeout(async () => {
        cancelGap();
        await player.seekTo(0);
        player.play();
      }, LOOP_GAP_MS);
    } else {
      setLooping(false);
      next();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status.didJustFinish]);

  function closePanel() {
    wordPlayer.pause();
    setSelected(null);
    setGlossData(null);
  }

  // A new line or speed means new audio, so the panel no longer applies.
  useEffect(() => {
    closePanel();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [idx, speed]);

  async function tapWord(i: number) {
    if (!line) return;
    cancelGap();
    setLooping(false);
    if (status.playing) player.pause();
    setSelected(i);
    setGlossData(null);
    try {
      const g = await api.gloss(line.words[i]!.text);
      setGlossData(g);
    } catch {
      setGlossData({ word: line.words[i]!.text, base: '', reading: '', entries: [], found: false });
    }
  }

  async function hearWord() {
    await wordPlayer.seekTo(0);
    wordPlayer.play();
  }

  function go(target: number) {
    cancelGap();
    setLooping(false);
    if (!island) return;
    const clamped = Math.max(0, Math.min(island.lines.length - 1, target));
    setIdx(clamped);
  }
  const next = () => go(idx + 1);
  const prev = () => go(idx - 1);

  // Lines are short, so Play always starts the sentence from the top. There is
  // no resuming from the middle: that is never what you want when shadowing.
  async function toggle() {
    const active = status.playing || looping;
    cancelGap();
    if (active) {
      player.pause();
      setLooping(false);
      return;
    }
    setLooping(loop);
    await player.seekTo(0);
    player.play();
  }

  if (error && !island) {
    return (
      <SafeAreaView style={StyleSheet.flatten([styles.fill, styles.center, { backgroundColor: palette.bg }])}>
        <Text style={[styles.body, { color: palette.danger }]}>{error}</Text>
        <Pressable
          onPress={() => setAttempt((n) => n + 1)}
          style={[styles.retry, { backgroundColor: palette.accent }]}>
          <Text style={[styles.retryText, { color: palette.accentInk }]}>Retry</Text>
        </Pressable>
      </SafeAreaView>
    );
  }
  if (!island) {
    return (
      <SafeAreaView style={StyleSheet.flatten([styles.fill, styles.center, { backgroundColor: palette.bg }])}>
        <ActivityIndicator color={palette.accent} />
      </SafeAreaView>
    );
  }
  if (!line) {
    // Still building, failed, or interrupted with nothing left: never a
    // silent spinner. Offer the way out.
    const busy = island.status === 'pending' || island.status === 'working';
    return (
      <SafeAreaView style={StyleSheet.flatten([styles.fill, styles.center, { backgroundColor: palette.bg }])}>
        <Stack.Screen options={{ title: island.title || 'Island' }} />
        {busy ? <ActivityIndicator color={palette.accent} /> : null}
        <Text style={[styles.body, { color: busy ? palette.muted : palette.danger }]}>
          {busy
            ? 'Still building this island…'
            : island.error || 'This island has no lines.'}
        </Text>
        {!busy ? (
          <Pressable
            onPress={async () => {
              try {
                await api.regenerate(island.id, island.complexity);
                setAttempt((n) => n + 1);
              } catch (e) {
                setError(e instanceof Error ? e.message : 'Could not regenerate');
              }
            }}
            style={[styles.retry, { backgroundColor: palette.accent }]}>
            <Text style={[styles.retryText, { color: palette.accentInk }]}>Regenerate</Text>
          </Pressable>
        ) : (
          <Pressable onPress={() => setAttempt((n) => n + 1)} style={styles.secondaryBtn}>
            <Text style={[styles.retryText, { color: palette.muted }]}>Refresh</Text>
          </Pressable>
        )}
      </SafeAreaView>
    );
  }

  // currentTime is a position in the source audio, not wall clock, so it maps
  // straight onto the word spans no matter what the playback rate is.
  // Word spans are stored for speed 1.0; the rendered audio is 1/speed as long.
  // Only a playing line lights up. Paused or finished, nothing is green.
  const activeWord = status.playing
    ? line.words.findIndex((w) => position >= w.start / speed && position < w.end / speed)
    : -1;
  const reading = line.timeline.map((m) => m.kana).join('');

  // Popover under the tapped word, centred on it, kept inside the block.
  const box = selected !== null ? wordBoxes.current[selected] : undefined;
  const popLeft = box
    ? Math.max(0, Math.min(blockWidth - POPOVER_WIDTH, box.x + box.width / 2 - POPOVER_WIDTH / 2))
    : 0;
  const popTop = box ? box.y + box.height + 6 : 0;
  const progress = status.duration > 0 ? status.currentTime / status.duration : 0;

  return (
    <SafeAreaView edges={['bottom']} style={StyleSheet.flatten([styles.fill, { backgroundColor: palette.bg }])}>
      <Stack.Screen options={{ title: island.title || 'Island' }} />

      <ScrollView contentContainerStyle={styles.scroll}>
        <Text style={[styles.counter, { color: palette.muted }]}>
          {idx + 1} of {island.lines.length}
        </Text>
        {error ? (
          <Pressable onPress={() => setError('')}>
            <Text style={[styles.inlineError, { color: palette.danger }]}>{error}</Text>
          </Pressable>
        ) : null}

        {line.words.length > 0 ? (
          <View
            style={styles.block}
            onLayout={(e) => setBlockWidth(e.nativeEvent.layout.width)}>
          <View style={styles.words}>
            {line.words.map((w, i) => (
              <Text
                key={i}
                onPress={() => tapWord(i)}
                onLayout={(e) => {
                  wordBoxes.current[i] = e.nativeEvent.layout;
                }}
                style={[
                  styles.ja,
                  styles.word,
                  {
                    color: i === activeWord ? palette.accentInk : palette.ink,
                    backgroundColor:
                      i === activeWord
                        ? palette.accent
                        : i === selected
                          ? palette.surfaceAlt
                          : 'transparent',
                    textDecorationLine: i === selected ? 'underline' : 'none',
                  },
                ]}>
                {w.text}
              </Text>
            ))}
          </View>
          {selected !== null && line.words[selected] ? (
            <WordPanel
              word={line.words[selected]!.text}
              gloss={glossData}
              left={popLeft}
              top={popTop}
              onHear={() => hearWord()}
              onClose={closePanel}
            />
          ) : null}
          </View>
        ) : (
          <Text style={[styles.ja, { color: palette.ink }]}>{line.ja}</Text>
        )}

        <Text style={[styles.reading, { color: palette.muted }]}>{reading}</Text>

        {countdown !== null ? (
          <Text style={[styles.again, { color: palette.accentInk, backgroundColor: palette.accent }]}>
            again in {countdown}
          </Text>
        ) : null}

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
              {status.playing || looping ? 'Stop' : 'Play'}
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
  block: { position: 'relative', zIndex: 5 },
  words: { flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'center' },
  word: { paddingHorizontal: 4, borderRadius: Radius.sm, overflow: 'hidden' },
  reading: { fontSize: 20, lineHeight: 30, textAlign: 'center' },
  en: { fontSize: 15, lineHeight: 22, textAlign: 'center', marginTop: Spacing.sm },
  again: {
    alignSelf: 'center',
    fontSize: 13,
    fontWeight: '700',
    paddingVertical: 4,
    paddingHorizontal: 12,
    borderRadius: Radius.pill,
    overflow: 'hidden',
  },
  body: { fontSize: 15, lineHeight: 22, textAlign: 'center', padding: Spacing.xl },
  inlineError: { fontSize: 13, lineHeight: 18, textAlign: 'center' },
  retry: { paddingVertical: Spacing.md, paddingHorizontal: Spacing.xxl, borderRadius: Radius.pill, marginTop: Spacing.md },
  secondaryBtn: { paddingVertical: Spacing.md, marginTop: Spacing.sm },
  retryText: { fontSize: 15, fontWeight: '700' },
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
