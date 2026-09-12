import Slider from '@react-native-community/slider';
import { useAudioPlayer, useAudioPlayerStatus, setAudioModeAsync } from 'expo-audio';
import { Stack, useLocalSearchParams } from 'expo-router';
import { useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { cancelAnimation, Easing, useSharedValue, withTiming } from 'react-native-reanimated';
import { SafeAreaView } from 'react-native-safe-area-context';

import { RingButton, type RingMode } from '@/components/ring-button';
import { TakeRow } from '@/components/take-row';
import { POPOVER_WIDTH, WordPanel } from '@/components/word-panel';
import { Radius, SPEED_MAX, SPEED_MIN, Spacing } from '@/constants/theme';
import { useTake } from '@/hooks/use-take';
import { useTheme } from '@/hooks/use-theme';
import * as api from '@/lib/api';
import { getVoice } from '@/lib/settings';
import { deleteTakes } from '@/lib/takes';

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
  // Off: play once and stop. Line: repeat this line. Island: every line in
  // order, then start over. Each repeat has a breath in front of it.
  type Repeat = 'off' | 'line' | 'island';
  const [repeat, setRepeat] = useState<Repeat>('line');
  // Ring fill, 0..1, animated on the UI thread.
  const ring = useSharedValue(0);
  const breathStart = useRef(0);
  // Loop is done by hand rather than with the player's own loop, so there is
  // a moment to breathe before the sentence comes around again.
  const LOOP_GAP_MS = 2000;
  const gapTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Seconds left in the breath between repeats; null when not in a breath.
  const [countdown, setCountdown] = useState<number | null>(null);
  const tickTimer = useRef<ReturnType<typeof setInterval> | null>(null);
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
  // Anything that interrupts the line also drops a take in progress and any
  // compare that was waiting for the line to end.
  function dropTake() {
    compareNext.current = false;
    setComparing(false);
    take.stopTake();
    void take.cancel();
  }
  const [showEnglish, setShowEnglish] = useState(false);
  const [voice, setVoice] = useState<number | null>(null);
  const [voiceName, setVoiceName] = useState('');
  const [revoicing, setRevoicing] = useState(false);
  const [regenerating, setRegenerating] = useState(false);
  // Backend stage while a regenerate runs, for the label on the waiting screen.
  const [buildStage, setBuildStage] = useState('');
  // Bumped after each regenerate so the line audio URLs change. useAudioPlayer
  // keys the native player on the serialized source: the same URL would keep
  // the old wav loaded under the new text.
  const [generation, setGeneration] = useState(0);
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
        ? { uri: api.lineAudioUrl(island.id, line.idx, `${island.speaker}-${generation}`, speed) }
        : null,
    [island, line, speed, generation],
  );
  // Native status arrives every 50ms; particles can be shorter than that, so
  // the position shown to the highlighter is interpolated between updates.
  // keepAudioSessionActive: a take's mic keeps running for a second after the
  // line ends, and the session must not be torn down under it in that time.
  const player = useAudioPlayer(source, { updateInterval: 50, keepAudioSessionActive: true });
  const status = useAudioPlayerStatus(player);
  const take = useTake(island?.id, idx, generation);
  // Set when Compare is waiting for the line to finish before it plays the
  // take; cleared once that happens or the compare is dropped.
  const compareNext = useRef(false);
  // State, not a ref: the Compare pill has to re-render to read Stop for as
  // long as either half of a compare run (the line, then the take) is playing.
  const [comparing, setComparing] = useState(false);
  const wasTakePlaying = useRef(false);

  // The tapped word has its own render and its own player, so hearing it never
  // moves the line's player or the highlight.
  const wordSource = useMemo(
    () =>
      island && line && selected !== null && line.words[selected]
        ? { uri: api.wordAudioUrl(line.words[selected]!.text, island.speaker) }
        : null,
    [island, line, selected],
  );
  // keepAudioSessionActive for the same reason as the line player: closePanel
  // pauses this one just before a take starts, and a pause tears the audio
  // session down 100ms later, which would land on the prepared recorder.
  const wordPlayer = useAudioPlayer(wordSource, { keepAudioSessionActive: true });
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
  // A message set just before a deliberate reload survives that reload. Every
  // other error is cleared once the island loads.
  const carryError = useRef('');
  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const data = await api.getIsland(id);
        if (alive) {
          setIsland(data);
          setError(carryError.current);
          carryError.current = '';
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

  // Polls until the island settles. Returns the ready island, throws with the
  // island's error when it failed, returns null when maxSeconds pass first.
  // A poll can fail while the server is briefly unreachable; that is not the
  // island failing, so keep polling.
  async function waitForIsland(
    islandId: string,
    maxSeconds: number,
    onStage?: (stage: string) => void,
    failedFallback = 'Building failed',
  ): Promise<api.Island | null> {
    for (let i = 0; i < maxSeconds; i += 1) {
      await new Promise((r) => setTimeout(r, 1000));
      let data: api.Island;
      try {
        data = await api.getIsland(islandId);
      } catch {
        continue;
      }
      onStage?.(data.stage);
      if (data.status === 'ready') return data;
      if (data.status === 'failed') throw new Error(data.error || failedFallback);
    }
    return null;
  }

  async function doRevoice() {
    if (!island || voice === null || revoicing || regenerating) return;
    setRevoicing(true);
    dropTake();
    player.pause();
    try {
      await api.revoice(island.id, voice);
      const data = await waitForIsland(island.id, 60, undefined, 'Re-voicing failed');
      if (data) {
        setIsland(data);
        setIdx(0);
        setError('');
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Re-voicing failed');
    } finally {
      setRevoicing(false);
    }
  }

  function confirmRegenerate() {
    if (!island || revoicing || regenerating) return;
    const target: api.Complexity = island.complexity === 'simple' ? 'complex' : 'simple';
    Alert.alert(
      target === 'complex' ? 'Regenerate with complex patterns?' : 'Regenerate one sentence at a time?',
      'The current lines are replaced with new ones written from the same recording. This takes about a minute.',
      [
        { text: 'Cancel', style: 'cancel' },
        { text: 'Regenerate', onPress: () => void doRegenerate(target) },
      ],
    );
  }

  // The backend drops the old lines as soon as the route runs and rebuilds
  // from the stored recording: transcribe, write, speak. The screen shows the
  // stage until the island is ready again, then starts over at line 0.
  async function doRegenerate(target: api.Complexity) {
    if (!island) return;
    setRegenerating(true);
    setBuildStage('transcribing');
    cancelGap();
    playWhenLoaded.current = false;
    dropTake();
    player.pause();
    closePanel();
    try {
      try {
        await api.regenerate(island.id, target);
      } catch (e) {
        // Nothing was started, so the island on the server still matches what
        // is on screen. Say why and go back to it.
        setError(e instanceof Error ? e.message : 'Regenerating failed');
        return;
      }
      deleteTakes(island.id);
      const data = await waitForIsland(island.id, 240, setBuildStage);
      cancelAnimation(ring);
      ring.value = 0;
      ringAimed.current = false;
      anchor.current = { time: 0, at: Date.now(), playing: false, rate: 1 };
      setPosition(0);
      setGeneration((g) => g + 1);
      setIdx(0);
      if (!data) {
        // Each new line is written over the same audio path, so by now the
        // server has already replaced the lines this screen is holding.
        // Reload onto whatever it has rather than showing old text.
        const message = 'Still building. This shows what the server has so far.';
        carryError.current = message;
        setError(message);
        setAttempt((n) => n + 1);
        return;
      }
      setIsland(data);
      setError('');
    } catch (e) {
      // The server now holds a failed island with no lines. Reloading shows
      // the failed screen, which already offers Regenerate.
      setError(e instanceof Error ? e.message : 'Regenerating failed');
      setAttempt((n) => n + 1);
    } finally {
      setRegenerating(false);
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

  // The ring follows native playback with ONE linear animation to full over
  // the remaining time, started when playback starts. Later status updates
  // only re-aim it if it has clearly drifted; restarting it on every update
  // is what made it stutter.
  const ringAimed = useRef(false);
  useEffect(() => {
    if (status.playing && status.duration > 0) {
      const target = status.currentTime / status.duration;
      const drifted = Math.abs(ring.value - target) > 0.08;
      if (!ringAimed.current || drifted) {
        ringAimed.current = true;
        cancelAnimation(ring);
        ring.value = target;
        const remaining = Math.max(0, (status.duration - status.currentTime) * 1000);
        ring.value = withTiming(1, { duration: remaining, easing: Easing.linear });
      }
    } else if (!status.playing) {
      ringAimed.current = false;
      if (countdown === null) {
        cancelAnimation(ring);
        ring.value = withTiming(0, { duration: 180 });
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status.playing, status.currentTime, status.duration, countdown]);

  // After a line switch that should keep playing, start the new source as
  // soon as it is swapped in; the native player begins when the item is ready.
  const playWhenLoaded = useRef(false);
  useEffect(() => {
    if (!playWhenLoaded.current || !source) return;
    playWhenLoaded.current = false;
    player.play();
  }, [source, player]);

  function startBreath(then: () => void) {
    cancelGap();
    breathStart.current = Date.now();
    setCountdown(Math.round(LOOP_GAP_MS / 1000));
    cancelAnimation(ring);
    ring.value = 1;
    ring.value = withTiming(0, { duration: LOOP_GAP_MS, easing: Easing.linear });
    tickTimer.current = setInterval(() => {
      const elapsed = Date.now() - breathStart.current;
      setCountdown(Math.max(1, Math.ceil((LOOP_GAP_MS - elapsed) / 1000)));
    }, 250);
    gapTimer.current = setTimeout(() => {
      cancelGap();
      then();
    }, LOOP_GAP_MS);
  }

  // The player can report "just finished" twice for one ending (once at the
  // end, once more right after the loop seeks back to the top), which used
  // to start two breaths. A finish is handled at most once per 800ms and
  // never while a breath is already pending.
  const lastFinish = useRef(0);
  useEffect(() => {
    if (!status.didJustFinish || !island || playWhenLoaded.current) return;
    if (gapTimer.current) return;
    const now = Date.now();
    if (now - lastFinish.current < 800) return;
    lastFinish.current = now;
    if (take.phase === 'recording') take.scheduleStop();
    if (compareNext.current) {
      compareNext.current = false;
      take.playTake();
      return;
    }
    if (repeat === 'line') {
      startBreath(async () => {
        await player.seekTo(0);
        player.play();
      });
    } else if (repeat === 'island') {
      startBreath(() => {
        playWhenLoaded.current = true;
        setIdx((i) => (i + 1) % island.lines.length);
      });
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
    playWhenLoaded.current = false;
    dropTake();
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

  // Switching lines: stop the old audio first, reset everything that belonged
  // to it, and carry on playing on the new line if we were playing.
  function go(target: number) {
    if (!island) return;
    const clamped = Math.max(0, Math.min(island.lines.length - 1, target));
    if (clamped === idx) return;
    const wasActive = status.playing || countdown !== null;
    cancelGap();
    dropTake();
    player.pause();
    cancelAnimation(ring);
    ring.value = 0;
    ringAimed.current = false;
    anchor.current = { time: 0, at: Date.now(), playing: false, rate: 1 };
    setPosition(0);
    closePanel();
    playWhenLoaded.current = wasActive;
    setIdx(clamped);
  }
  const next = () => go(idx + 1);
  const prev = () => go(idx - 1);

  // Lines are short, so Play always starts the sentence from the top. There is
  // no resuming from the middle: that is never what you want when shadowing.
  async function toggle() {
    const active = status.playing || countdown !== null;
    cancelGap();
    playWhenLoaded.current = false;
    if (active) {
      dropTake();
      player.pause();
      return;
    }
    dropTake();
    ringAimed.current = false;
    try {
      await player.seekTo(0);
    } catch {
      // A seek can fail while the item is still loading; play anyway.
    }
    player.play();
  }

  // The take is only in phase 'recording' once startTake resolves, so the pill
  // stays tappable through the permission and audio mode round trips. This
  // holds the second tap off, which would otherwise prepare the recorder again
  // and start the line twice.
  const startingTake = useRef(false);

  async function recordTake() {
    if (!line || startingTake.current) return;
    startingTake.current = true;
    try {
      cancelGap();
      playWhenLoaded.current = false;
      closePanel();
      dropTake();
      player.pause();
      ringAimed.current = false;
      try {
        await player.seekTo(0);
      } catch {
        // A seek can fail while the item is still loading; play anyway.
      }
      // The line's duration is the watchdog's base: a take that is never ended
      // by the line stops itself a few seconds past it.
      if (!(await take.startTake(status.duration))) return;
      player.play();
    } finally {
      startingTake.current = false;
    }
  }

  function compare() {
    if (compareNext.current || (take.takePlaying && comparing)) {
      dropTake();
      player.pause();
      return;
    }
    cancelGap();
    playWhenLoaded.current = false;
    closePanel();
    take.stopTake();
    compareNext.current = true;
    setComparing(true);
    ringAimed.current = false;
    void (async () => {
      try {
        await player.seekTo(0);
      } catch {
        // A seek can fail while the item is still loading; play anyway.
      }
      player.play();
    })();
  }

  function hearTake() {
    if (take.takePlaying) {
      take.stopTake();
      return;
    }
    cancelGap();
    closePanel();
    compareNext.current = false;
    setComparing(false);
    if (status.playing) player.pause();
    take.playTake();
  }

  // A compare run covers both halves, the line then the take, so it only
  // ends here when the take finishes playing on its own; the Compare pill
  // stopping it early is handled in compare() and dropTake() above.
  useEffect(() => {
    if (wasTakePlaying.current && !take.takePlaying && comparing) setComparing(false);
    wasTakePlaying.current = take.takePlaying;
  }, [take.takePlaying, comparing]);

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
                deleteTakes(island.id);
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

  if (regenerating) {
    return (
      <SafeAreaView style={StyleSheet.flatten([styles.fill, styles.center, { backgroundColor: palette.bg }])}>
        <Stack.Screen options={{ title: island.title || 'Island' }} />
        <ActivityIndicator color={palette.accent} />
        <Text style={[styles.body, { color: palette.muted }]}>
          {api.STAGE_LABEL[buildStage] ?? 'Rebuilding this island…'}
        </Text>
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

  const ringMode: RingMode = status.playing ? 'playing' : countdown !== null ? 'breath' : 'idle';

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


        <Pressable onPress={() => setShowEnglish((v) => !v)}>
          <Text style={[styles.en, { color: showEnglish ? palette.ink : palette.muted }]}>
            {showEnglish ? line.en : 'Tap to show the English'}
          </Text>
        </Pressable>
      </ScrollView>

      <View style={[styles.controls, { borderTopColor: palette.line }]}>
        <View style={styles.ringRow}>
          <Pressable onPress={prev} disabled={idx === 0} hitSlop={16} style={styles.side}>
            <Text style={[styles.sideText, { color: idx === 0 ? palette.line : palette.ink }]}>‹</Text>
          </Pressable>
          <RingButton progress={ring} mode={ringMode} countdown={countdown} onPress={toggle} />
          <Pressable
            onPress={next}
            disabled={idx >= island.lines.length - 1}
            hitSlop={16}
            style={styles.side}>
            <Text
              style={[styles.sideText, { color: idx >= island.lines.length - 1 ? palette.line : palette.ink }]}>
              ›
            </Text>
          </Pressable>
        </View>

        <TakeRow
          phase={take.phase}
          level={take.level}
          takePlaying={take.takePlaying}
          comparing={comparing}
          error={take.error}
          onRecord={() => void recordTake()}
          onCompare={compare}
          onPlayTake={hearTake}
        />

        {voice !== null && island.speaker !== voice ? (
          <Pressable
            onPress={doRevoice}
            disabled={revoicing || regenerating}
            style={styles.action}>
            <Text style={[styles.actionText, { color: revoicing || regenerating ? palette.muted : palette.accent }]}>
              {revoicing ? 'Re-voicing…' : `Re-voice in ${voiceName || 'the chosen voice'}`}
            </Text>
          </Pressable>
        ) : null}

        <Pressable onPress={confirmRegenerate} disabled={revoicing || regenerating} style={styles.action}>
          <Text style={[styles.actionText, { color: revoicing || regenerating ? palette.muted : palette.accent }]}>
            {regenerating
              ? 'Regenerating…'
              : island.complexity === 'simple'
                ? 'Regenerate with complex patterns'
                : 'Regenerate one sentence at a time'}
          </Text>
        </Pressable>

        <View style={styles.pillRow}>
          <Text style={[styles.pillLabel, { color: palette.muted }]}>Repeat</Text>
          {(['off', 'line', 'island'] as const).map((mode) => {
            const on = repeat === mode;
            return (
              <Pressable
                key={mode}
                onPress={() => {
                  setRepeat(mode);
                  if (mode === 'off') cancelGap();
                }}
                style={[
                  styles.pill,
                  {
                    backgroundColor: on ? palette.accent : palette.surface,
                    borderColor: on ? palette.accent : palette.line,
                  },
                ]}>
                <Text style={[styles.pillText, { color: on ? palette.accentInk : palette.ink }]}>
                  {mode === 'off' ? 'Off' : mode === 'line' ? 'Line' : 'Island'}
                </Text>
              </Pressable>
            );
          })}
        </View>

        <View style={styles.speedRow}>
          <Text style={[styles.pillLabel, { color: palette.muted }]}>Speed</Text>
          <Slider
            style={styles.slider}
            minimumValue={SPEED_MIN}
            maximumValue={SPEED_MAX}
            step={0.05}
            value={speed}
            onValueChange={(v) => setDragging(Math.round(v * 20) / 20)}
            onSlidingComplete={(v) => {
              setDragging(null);
              const next = Math.round(v * 20) / 20;
              if (next === speed) return;
              // The line is re-rendered at the new speed; if it was playing,
              // carry on at the new speed from the top instead of going silent.
              const wasActive = status.playing || countdown !== null;
              cancelGap();
              dropTake();
              player.pause();
              cancelAnimation(ring);
              ring.value = 0;
              ringAimed.current = false;
              playWhenLoaded.current = wasActive;
              setSpeed(next);
            }}
            minimumTrackTintColor={palette.accent}
            maximumTrackTintColor={palette.line}
            thumbTintColor={palette.accent}
            accessibilityLabel="Playback speed"
          />
          <Text style={[styles.speedValue, { color: palette.ink }]}>
            {(dragging ?? speed).toFixed(2)}x
          </Text>
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
  controls: { borderTopWidth: 1, paddingHorizontal: Spacing.lg, paddingTop: Spacing.md, paddingBottom: Spacing.lg, gap: Spacing.md },
  action: { alignItems: 'center', paddingVertical: Spacing.xs },
  actionText: { fontSize: 14, fontWeight: '600' },
  ringRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: Spacing.xl },
  side: { paddingHorizontal: Spacing.md, paddingVertical: Spacing.sm },
  sideText: { fontSize: 40, lineHeight: 44, fontWeight: '300' },
  pillRow: { flexDirection: 'row', alignItems: 'center', gap: Spacing.sm, justifyContent: 'center' },
  pillLabel: { fontSize: 13, fontWeight: '600', minWidth: 52 },
  pill: { borderWidth: 1, borderRadius: Radius.pill, paddingVertical: Spacing.xs + 2, paddingHorizontal: Spacing.md },
  pillText: { fontSize: 13, fontWeight: '700' },
  speedRow: { flexDirection: 'row', alignItems: 'center', gap: Spacing.sm },
  slider: { flex: 1, height: 36 },
  speedValue: { fontSize: 14, fontWeight: '700', fontVariant: ['tabular-nums'], minWidth: 52, textAlign: 'right' },
});
