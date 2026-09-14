import Slider from '@react-native-community/slider';
import { isRunningInExpoGo } from 'expo';
import { type AudioMetadata, useAudioPlayer, useAudioPlayerStatus } from 'expo-audio';
import { Stack, useLocalSearchParams } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  AppState,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { Gesture, GestureDetector, ScrollView } from 'react-native-gesture-handler';
import { cancelAnimation, Easing, useSharedValue, withTiming } from 'react-native-reanimated';
import { SafeAreaView } from 'react-native-safe-area-context';

import { BottomRow } from '@/components/tide/bottom-row';
import { PlayerTitle } from '@/components/tide/player-title';
import { TideScene } from '@/components/tide/tide-scene';
import { ExportLink } from '@/components/export-link';
import { PressScale } from '@/components/press-scale';
import { PhraseBar } from '@/components/phrase-bar';
import { PitchReading } from '@/components/pitch-reading';
import { ReadingPills } from '@/components/reading-pills';
import { type RingMode } from '@/components/ring-button';
import { RubyWord } from '@/components/ruby-word';
import { SELECTION_POPUP_WIDTH, SelectionPopup } from '@/components/selection-popup';
import { TakeRow } from '@/components/take-row';
import { POPOVER_WIDTH, WordPanel } from '@/components/word-panel';
import { fonts } from '@/constants/fonts';
import { Radius, SPEED_MAX, SPEED_MIN, Spacing, tide } from '@/constants/theme';
import { usePhrase, type PhraseSpan } from '@/hooks/use-phrase';
import { usePracticeClock } from '@/hooks/use-practice-clock';
import { useTake, type TakeMode } from '@/hooks/use-take';
import { useTheme } from '@/hooks/use-theme';
import * as api from '@/lib/api';
import {
  applyPlaybackMode,
  releaseAudioSession,
  startPlayback,
  stopPlayback,
  useSessionPlayer,
} from '@/lib/audio-mode';
import { pitchCells } from '@/lib/pitch';
import { lineRomaji } from '@/lib/romaji';
import {
  getSettings,
  setBlind as persistBlind,
  setHideEnglish as persistHideEnglish,
  setLagMs as persistLagMs,
  setPitch as persistPitch,
  setReading as persistReading,
  LAG_OPTIONS,
  type LagMs,
  type ReadingMode,
} from '@/lib/settings';
import { deleteTakes } from '@/lib/takes';

// Expo Go on Android does not ship the AudioControlsService, and activating
// the lock screen there logs a service binding error; a dev build has it
// through the expo-audio config plugin. With the app's `duckOthers` mode iOS
// never hands Now Playing to a mixable session, so on iOS this shows nothing
// until the mode is `doNotMix`; the calls below stay in place because that
// switch is then a one-line change in audio-mode.ts.
const lockScreen = Platform.OS === 'ios' || !isRunningInExpoGo();

export default function IslandScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const { palette } = useTheme();

  const [island, setIsland] = useState<api.Island | null>(null);
  const [error, setError] = useState('');
  const [idx, setIdx] = useState(0);
  const [editingTitle, setEditingTitle] = useState(false);
  const [draftTitle, setDraftTitle] = useState('');
  const editingTitleRef = useRef(false);
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
  // The breath between repeats is silence the backend appends to the line's
  // own audio (the `pad` query param), so Repeat Line is the player's own
  // loop and Repeat Island advances on the native finish event. There are no
  // timers in the loop on purpose: Android stops JS timers while the screen
  // is locked, and the native `status` (every 50ms) keeps arriving in the
  // background on both platforms, so the ring, the countdown, the take tail
  // and Compare all key off it instead. The requested breath is this plus the
  // shadowing lag. Other apps' audio stays ducked for the whole loop, breaths
  // included, and comes back at a stop point (see `releaseAudioSession`).
  const LOOP_GAP_MS = 2000;
  // Anything that interrupts the line also drops a take in progress and any
  // compare that was waiting for the line to end.
  function dropTake() {
    compareNext.current = false;
    setComparing(false);
    take.stopTake();
    void take.cancel();
  }
  const [showEnglish, setShowEnglish] = useState(false);
  const [blind, setBlind] = useState(false);
  const [hideEnglish, setHideEnglish] = useState(false);
  // Shadowing lag: lengthens the take tail and the loop breath, nothing else.
  const [lagMs, setLagMs] = useState<LagMs>(0);
  // Set once the user taps Blind or a Lag pill, so a slow settings load does
  // not overwrite the choice.
  const blindTouched = useRef(false);
  const hideEnglishTouched = useRef(false);
  const lagTouched = useRef(false);
  // How the reading is shown (furigana over the kanji, the kana line, or
  // romaji) and whether pitch marks are drawn. Remembered like Blind and Lag.
  const [readingMode, setReadingMode] = useState<ReadingMode>('furigana');
  const [pitch, setPitchOn] = useState(true);
  const readingTouched = useRef(false);
  const pitchTouched = useRef(false);
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
  // The line whose hidden text was revealed. Keyed on generation and idx, so
  // a new line (or a regenerate landing) is hidden in the same render that
  // shows it, with no frame of text in between.
  const lineKey = `${generation}:${idx}`;
  const [peekKey, setPeekKey] = useState<string | null>(null);
  const hidden = blind && peekKey !== lineKey;
  // The tapped word, its dictionary result, and the timer that ends Hear it.
  const [selected, setSelected] = useState<number | null>(null);
  const [glossData, setGlossData] = useState<api.Gloss | null>(null);
  // Where each word sits inside the sentence block, so the popover can sit
  // right under the tapped one without moving anything else, and so the drag
  // gesture below can hit-test a touch point to a word.
  const wordBoxes = useRef<Record<number, { x: number; y: number; width: number; height: number }>>({});
  const [blockWidth, setBlockWidth] = useState(0);
  // The height of the scroll viewport itself (not its content): the scene and
  // dock fill exactly one screen, and the temporary section is reached below it.
  const [viewportH, setViewportH] = useState(0);
  const scrollRef = useRef<ScrollView>(null);
  // The run of words a drag has selected. Set on the pan gesture's start and
  // update, left alone on end: that is what shows the Repeat popup.
  const [dragSpan, setDragSpan] = useState<PhraseSpan | null>(null);
  const anchorWord = useRef(0);

  const line = island?.lines[idx];
  // Per line, not per render: the position ticks every 50ms while playing.
  const lineRomajiText = useMemo(() => (line ? lineRomaji(line) : ''), [line]);
  const linePitchCells = useMemo(() => (line ? pitchCells(line.timeline) : null), [line]);
  // The pad requested from the backend: always the breath plus the lag,
  // whatever the Repeat pill says, so tapping Repeat never restarts the line.
  const breathMs = LOOP_GAP_MS + lagMs;
  const phrase = usePhrase(lineKey, line, speed);
  const source = useMemo(
    () =>
      island && line
        ? {
            uri: api.lineAudioUrl(
              island.id,
              line.idx,
              `${island.speaker}-${generation}`,
              speed,
              breathMs,
              phrase.audio,
            ),
          }
        : null,
    // A lag change re-creates the player (new pad, new source URL), so a
    // playing line restarts from the top, exactly like a speed change does.
    // A phrase is its own render, so setting or clearing one swaps the player
    // like a speed change.
    [island, line, speed, generation, lagMs, phrase.audio?.startMs, phrase.audio?.endMs],
  );
  // Native status arrives every 50ms; particles can be shorter than that, so
  // the position shown to the highlighter is interpolated between updates.
  // keepAudioSessionActive: a take's mic keeps running for a second after the
  // line ends, and the session must not be torn down under it in that time.
  const player = useAudioPlayer(source, { updateInterval: 50, keepAudioSessionActive: true });
  const status = useAudioPlayerStatus(player);
  useSessionPlayer(player);
  usePracticeClock(island?.id, player, status);
  const breathSec = breathMs / 1000;
  // status.duration includes the pad. Below the breath length the item is not loaded yet.
  const lineEnd = status.duration > breathSec ? status.duration - breathSec : 0;
  const take = useTake(island?.id, idx, generation);
  // Set when Compare is waiting for the line to finish before it plays the
  // take; cleared once that happens or the compare is dropped.
  const compareNext = useRef(false);
  // State, not a ref: the Compare pill has to re-render to read Stop for as
  // long as either half of a compare run (the line, then the take) is playing.
  const [comparing, setComparing] = useState(false);
  // Repeat Off, a take and a Compare all stop the line where the pad begins
  // (the crossing effect below), so no breath follows. The pause lands a
  // status or two after the crossing, and without this the draining ring and
  // the countdown would flash for that moment.
  const stopsAtLineEnd = repeat === 'off' || take.phase === 'recording' || comparing;
  const inBreath = status.playing && lineEnd > 0 && status.currentTime >= lineEnd && !stopsAtLineEnd;
  const countdown = inBreath ? Math.max(1, Math.ceil(status.duration - status.currentTime)) : null;
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
  useSessionPlayer(wordPlayer);
  const autoPlayed = useRef<string | null>(null);

  // Play the word once as soon as its audio is ready, for each new selection.
  useEffect(() => {
    const key = wordSource?.uri ?? null;
    if (!key || !wordStatus.isLoaded || autoPlayed.current === key) return;
    autoPlayed.current = key;
    startPlayback(wordPlayer);
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
    void applyPlaybackMode();
    return () => {
      void releaseAudioSession();
    };
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
  // which voice it would switch to. Also loads blind mode and the lag, which
  // live in the same settings file.
  useEffect(() => {
    let alive = true;
    (async () => {
      const settings = await getSettings();
      if (!alive) return;
      setVoice(settings.voice);
      // Settings can land after the user already tapped Blind or a Lag pill;
      // what they tapped wins.
      if (!blindTouched.current) {
        setBlind(settings.blind);
        if (settings.blind) {
          closePanel();
          setDragSpan(null);
        }
      }
      if (!hideEnglishTouched.current) setHideEnglish(settings.hideEnglish);
      if (!lagTouched.current) setLagMs(settings.lagMs);
      if (!readingTouched.current) setReadingMode(settings.reading);
      if (!pitchTouched.current) setPitchOn(settings.pitch);
      try {
        const speakers = await api.listSpeakers();
        for (const sp of speakers) {
          const st = sp.styles.find((s) => s.id === settings.voice);
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
    stopPlayback(player);
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

  async function renameTitle(title: string) {
    if (!island) return;
    // A single-line TextInput fires onSubmitEditing then onBlur for one
    // return press (submitBehavior defaults to 'blurAndSubmit'). The ref
    // closes that window synchronously so the second call is a no-op.
    if (!editingTitleRef.current) return;
    editingTitleRef.current = false;
    const finalTitle = title.trim() || 'Untitled island';
    setEditingTitle(false);
    try {
      await api.renameIsland(island.id, finalTitle);
      setIsland({ ...island, title: finalTitle });
    } catch (e) {
      Alert.alert('Could not rename', e instanceof Error ? e.message : 'The server did not answer.');
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
    playWhenLoaded.current = false;
    dropTake();
    stopPlayback(player);
    closePanel();
    setDragSpan(null);
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
      ringPhase.current = 'idle';
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
  // 1.0. Loop is a player property, driven by the Repeat pill: Line loops the
  // native player (the pad's silence becomes the breath, with no gap at the
  // wrap), Off and Island advance by hand from the crossing and finish
  // effects below. Pushed again whenever the source swaps to a new line or
  // speed, since the player identity changes with them.
  useEffect(() => {
    player.setPlaybackRate(1, 'high');
    player.loop = repeat === 'line';
  }, [player, repeat]);

  // The ring follows native playback with ONE linear animation per phase,
  // aimed to full over the remaining spoken time, then to empty over the
  // remaining breath. Later status updates only re-aim it if it has clearly
  // drifted; restarting it on every update is what made it stutter.
  const ringPhase = useRef<'idle' | 'line' | 'breath'>('idle');
  useEffect(() => {
    if (status.playing && lineEnd > 0 && !inBreath) {
      // Past lineEnd only for the moment before a stop at the line's end lands.
      const target = Math.min(1, status.currentTime / lineEnd);
      const drifted = Math.abs(ring.value - target) > 0.08;
      if (ringPhase.current !== 'line' || drifted) {
        ringPhase.current = 'line';
        cancelAnimation(ring);
        ring.value = target;
        const remaining = Math.max(0, (lineEnd - status.currentTime) * 1000);
        ring.value = withTiming(1, { duration: remaining, easing: Easing.linear });
      }
    } else if (inBreath) {
      const target = (status.duration - status.currentTime) / breathSec;
      const drifted = Math.abs(ring.value - target) > 0.08;
      if (ringPhase.current !== 'breath' || drifted) {
        ringPhase.current = 'breath';
        cancelAnimation(ring);
        ring.value = target;
        const remaining = Math.max(0, (status.duration - status.currentTime) * 1000);
        ring.value = withTiming(0, { duration: remaining, easing: Easing.linear });
      }
    } else if (!status.playing) {
      ringPhase.current = 'idle';
      cancelAnimation(ring);
      ring.value = withTiming(0, { duration: 180 });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status.playing, status.currentTime, status.duration, lineEnd]);

  // After a line switch that should keep playing, start the new source as
  // soon as it is swapped in; the native player begins when the item is ready.
  const playWhenLoaded = useRef(false);
  useEffect(() => {
    if (!playWhenLoaded.current || !source) return;
    playWhenLoaded.current = false;
    startPlayback(player);
  }, [source, player]);

  // Lock screen / notification text. Blind mode never shows the Japanese.
  function lockMeta(): AudioMetadata {
    const pos = `Line ${idx + 1} of ${island!.lines.length}`;
    const artist = island!.title || 'Island';
    return blind ? { title: pos, artist } : { title: phrase.label ?? line!.ja, artist, albumTitle: pos };
  }

  // The line player is the lock screen / notification's active player.
  // useAudioPlayer swaps in a new native player per source, and releasing the
  // old one (which happens before this effect runs, in the same commit)
  // already clears the lock screen on both platforms, so there is no
  // explicit clear anywhere here.
  useEffect(() => {
    if (!lockScreen || !island || !line) return;
    player.setActiveForLockScreen(true, lockMeta(), { showSeekForward: false, showSeekBackward: false });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [player, lockScreen, island?.id, generation]);

  useEffect(() => {
    if (!lockScreen || !island || !line) return;
    player.updateLockScreenMetadata(lockMeta());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [blind, idx, island?.title, island?.lines.length, line?.ja, phrase.label]);

  // A take made with the phone in a pocket is not a take, and the microphone
  // must never run in the background: dropped as soon as the app backgrounds.
  // The line stops with it; nothing else about playback changes here. The
  // listener is subscribed once, so everything it calls is read through the
  // ref: the first render's dropTake would close over a take whose cancel()
  // still sees `recording` as false and leaves the microphone running.
  const backgroundRef = useRef({ take, player, dropTake });
  backgroundRef.current = { take, player, dropTake };
  useEffect(() => {
    const sub = AppState.addEventListener('change', (state) => {
      if (state !== 'background') return;
      const { take: t, player: p, dropTake: drop } = backgroundRef.current;
      if (t.phase === 'recording') {
        // The line first: stopPlayback never throws, and neither does the
        // take player's pause inside drop().
        stopPlayback(p);
        void p.seekTo(0);
        drop();
      }
    });
    return () => sub.remove();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // The moment the spoken line ends and the pad's silence begins is the "line
  // finished" moment for a take, a Compare and Repeat Off. `status.currentTime`
  // is native and keeps arriving with the app in the background; the
  // interpolated `position` runs on a JS interval that Android stops when the
  // screen locks, so it must not be used here. `crossed` resets on a wrap (the
  // native loop) or a seek, and whenever the player identity changes.
  const crossed = useRef(false);
  useEffect(() => {
    crossed.current = false;
  }, [player]);
  useEffect(() => {
    if (!status.playing || lineEnd <= 0) return;
    if (status.currentTime < lineEnd) {
      crossed.current = false;
      return;
    }
    if (crossed.current) return;
    crossed.current = true;
    if (take.phase === 'recording') {
      stopPlayback(player);
      void player.seekTo(0);
      take.scheduleStop();
      return;
    }
    if (compareNext.current) {
      compareNext.current = false;
      stopPlayback(player);
      void player.seekTo(0);
      take.playTake();
      return;
    }
    if (repeat === 'off') {
      stopPlayback(player);
      void player.seekTo(0);
      void releaseAudioSession();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status.currentTime, status.playing, lineEnd]);

  // Repeat Line is the native loop and never reaches this. A finish can also
  // arrive late, after a status already crossed lineEnd, so a stray one while
  // Off has already parked the player at 0 is harmless. The 800ms once-guard
  // and the playWhenLoaded bail-out keep a finish from firing twice for one
  // ending (once at the end, once more right after a loop wraps).
  const lastFinish = useRef(0);
  useEffect(() => {
    if (!status.didJustFinish || !island || playWhenLoaded.current) return;
    const now = Date.now();
    if (now - lastFinish.current < 800) return;
    lastFinish.current = now;
    if (repeat !== 'island') {
      if (repeat === 'off') {
        void player.seekTo(0);
        void releaseAudioSession();
      }
      return;
    }
    if (island.lines.length === 1) {
      // idx would not change, so the source stays the same and the
      // playWhenLoaded effect never fires: seek and play by hand instead.
      // Hide the text again for the next loop explicitly, since a new lineKey
      // never arrives to do it.
      setPeekKey(null);
      void (async () => {
        await player.seekTo(0);
        startPlayback(player);
      })();
      return;
    }
    playWhenLoaded.current = true;
    setPeekKey(null);
    if (phrase.span) take.discardTake();
    setIdx((i) => (i + 1) % island.lines.length);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status.didJustFinish]);

  function closePanel() {
    stopPlayback(wordPlayer);
    setSelected(null);
    setGlossData(null);
  }

  // A new line or speed means new audio, so the panel and any drag selection
  // no longer apply.
  useEffect(() => {
    closePanel();
    setDragSpan(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [idx, speed]);

  async function tapWord(i: number) {
    if (!line) return;
    if (hidden) return;
    playWhenLoaded.current = false;
    dropTake();
    if (status.playing) stopPlayback(player);
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
    startPlayback(wordPlayer);
  }

  // Hit-tests a point in styles.words' own coordinate space (what
  // GestureDetector reports touches in, since it wraps that view) to a word
  // index: the row whose y-range contains the point (or the closest one by
  // vertical distance, for a touch between rows), then within that row the
  // word whose x-range is closest, which clamps a drag past either edge of a
  // row to that edge rather than spilling onto the next one. Blind mode has
  // nothing to hit.
  function hitTest(x: number, y: number): number | null {
    if (!line || hidden) return null;
    const boxes = wordBoxes.current;
    const indices = Object.keys(boxes)
      .map(Number)
      .filter((i) => i < line.words.length);
    if (indices.length === 0) return null;
    let rowY = boxes[indices[0]!]!.y;
    let exact = false;
    for (const i of indices) {
      const b = boxes[i]!;
      if (y >= b.y && y < b.y + b.height) {
        rowY = b.y;
        exact = true;
        break;
      }
    }
    if (!exact) {
      let best = Infinity;
      for (const i of indices) {
        const b = boxes[i]!;
        const dist = Math.abs(y - (b.y + b.height / 2));
        if (dist < best) {
          best = dist;
          rowY = b.y;
        }
      }
    }
    const row = indices.filter((i) => Math.abs(boxes[i]!.y - rowY) < 2).sort((a, b) => a - b);
    let picked = row[0]!;
    let bestXDist = Infinity;
    for (const i of row) {
      const b = boxes[i]!;
      if (x >= b.x && x < b.x + b.width) return i;
      const dist = x < b.x ? b.x - x : x - (b.x + b.width);
      if (dist < bestXDist) {
        bestXDist = dist;
        picked = i;
      }
    }
    return picked;
  }

  // A drag picks the phrase, snapped to whole words: hold still for the pan
  // to activate (the ScrollView is free to claim a vertical drag until then),
  // then the highlight follows the touch as `dragSpan`. A plain tap falls
  // through to the word popover instead, and also dismisses a drag selection
  // sitting from before. Both run on the JS thread: nothing here is a
  // worklet, so state and the existing async handlers can be called directly.
  const pan = Gesture.Pan()
    .activateAfterLongPress(450)
    .runOnJS(true)
    .onStart((e) => {
      const i = hitTest(e.x, e.y);
      if (i === null) return;
      closePanel();
      anchorWord.current = i;
      setDragSpan({ from: i, to: i });
    })
    .onUpdate((e) => {
      const i = hitTest(e.x, e.y);
      if (i === null) return;
      const a = anchorWord.current;
      setDragSpan({ from: Math.min(a, i), to: Math.max(a, i) });
    });
  const tap = Gesture.Tap()
    .runOnJS(true)
    .onEnd((e) => {
      setDragSpan(null);
      const i = hitTest(e.x, e.y);
      if (i !== null) void tapWord(i);
    });
  // A quick vertical drag reads as a swipe instead of the phrase-selection
  // pan: the pan only activates after a 450ms hold, so a fast flick falls
  // through to this before that timer fires. blocksExternalGesture holds the
  // outer scroll view off until the swipe fails, so a horizontal or slow drag
  // still reaches it.
  const swipe = Gesture.Pan()
    .runOnJS(true)
    .activeOffsetY([-16, 16])
    .failOffsetX([-24, 24])
    .blocksExternalGesture(scrollRef)
    .onEnd((e) => {
      if (e.translationY < -40 || e.velocityY < -500) next();
      else if (e.translationY > 40 || e.velocityY > 500) {
        playWhenLoaded.current = false;
        setDragSpan(null);
        void playFromTop();
      }
    });
  const sentenceGesture = Gesture.Exclusive(pan, swipe, tap);

  // The drag selection's popup Repeat button: same follow-up as picking a
  // phrase used to run, then the selection (and its popup) is done.
  function repeatSelection() {
    const span = dragSpan;
    setDragSpan(null);
    if (!span || phrase.set(span) !== 'set') return;
    dropTake();
    // A take belongs to the audio it was recorded over.
    take.discardTake();
    stopPlayback(player);
    cancelAnimation(ring);
    ring.value = 0;
    ringPhase.current = 'idle';
    playWhenLoaded.current = true;
  }

  // Back to the whole line, carrying on if it was playing.
  function clearPhrase() {
    if (!phrase.span) return;
    const wasActive = status.playing;
    dropTake();
    take.discardTake();
    stopPlayback(player);
    cancelAnimation(ring);
    ring.value = 0;
    ringPhase.current = 'idle';
    playWhenLoaded.current = wasActive;
    setDragSpan(null);
    phrase.clear();
  }

  // Switching lines: stop the old audio first, reset everything that belonged
  // to it, and carry on playing on the new line if we were playing.
  function go(target: number) {
    if (!island) return;
    const clamped = Math.max(0, Math.min(island.lines.length - 1, target));
    if (clamped === idx) return;
    const wasActive = status.playing;
    dropTake();
    // Leaving the line clears its phrase, and with it a take recorded on it.
    if (phrase.span) take.discardTake();
    stopPlayback(player);
    cancelAnimation(ring);
    ring.value = 0;
    ringPhase.current = 'idle';
    anchor.current = { time: 0, at: Date.now(), playing: false, rate: 1 };
    setPosition(0);
    closePanel();
    setDragSpan(null);
    playWhenLoaded.current = wasActive;
    // Coming back to a line that was peeked at hides it again.
    setPeekKey(null);
    setIdx(clamped);
  }
  const next = () => go(idx + 1);
  const prev = () => go(idx - 1);

  // Starts the line fresh from the top, whether or not it was already
  // playing: shared by the ring's Play tap and a swipe down on the sentence.
  async function playFromTop() {
    dropTake();
    ringPhase.current = 'idle';
    try {
      await player.seekTo(0);
    } catch {
      // A seek can fail while the item is still loading; play anyway.
    }
    // A short phrase can reach lineEnd before a status below it resets this.
    crossed.current = false;
    startPlayback(player);
  }

  // Lines are short, so Play always starts the sentence from the top. There is
  // no resuming from the middle: that is never what you want when shadowing.
  async function toggle() {
    const active = status.playing;
    playWhenLoaded.current = false;
    setDragSpan(null);
    if (active) {
      dropTake();
      stopPlayback(player);
      void releaseAudioSession();
      return;
    }
    await playFromTop();
  }

  function toggleBlind() {
    const next = !blind;
    blindTouched.current = true;
    setBlind(next);
    setPeekKey(null);
    if (next) {
      closePanel();
      setDragSpan(null);
    }
    // The pill already shows the new value; a failed save only means it is
    // not remembered next time.
    persistBlind(next).catch(() => {});
  }

  function toggleHideEnglish() {
    const next = !hideEnglish;
    hideEnglishTouched.current = true;
    setHideEnglish(next);
    persistHideEnglish(next).catch(() => {});
  }

  function pickLag(ms: LagMs) {
    lagTouched.current = true;
    persistLagMs(ms).catch(() => {});
    if (ms === lagMs) return;
    // The lag is part of the line's pad, so the source (and the player)
    // changes with it. Same reset as a speed change: a take and a pending
    // Compare are dropped, and a playing line carries on from the top.
    const wasActive = status.playing;
    dropTake();
    stopPlayback(player);
    cancelAnimation(ring);
    ring.value = 0;
    ringPhase.current = 'idle';
    playWhenLoaded.current = wasActive;
    setLagMs(ms);
  }

  // Neither touches playback: switching the reading never stops the line, a
  // take, a compare or the popover. A failed save only means it is not
  // remembered next time.
  function pickReading(mode: ReadingMode) {
    readingTouched.current = true;
    setReadingMode(mode);
    persistReading(mode).catch(() => {});
  }

  function togglePitch() {
    const next = !pitch;
    pitchTouched.current = true;
    setPitchOn(next);
    persistPitch(next).catch(() => {});
  }

  // The take is only in phase 'recording' once startTake resolves, so the pill
  // stays tappable through the permission and audio mode round trips. This
  // holds the second tap off, which would otherwise prepare the recorder again
  // and start the line twice.
  const startingTake = useRef(false);

  // Shared by recordTake and calibrateSpeaker: only the recording mode
  // differs between a take and a speaker calibration, so both go through the
  // same cancel, close, drop, seek and play sequence and cannot drift apart.
  async function beginRecording(mode: TakeMode) {
    if (!line || startingTake.current) return;
    startingTake.current = true;
    try {
      playWhenLoaded.current = false;
      closePanel();
      setDragSpan(null);
      // dropTake(), but waiting for the cancel: it stops a take still
      // recording and releases the session, and that must be done before the
      // new recorder is prepared rather than land under it.
      compareNext.current = false;
      setComparing(false);
      take.stopTake();
      stopPlayback(player);
      await take.cancel();
      ringPhase.current = 'idle';
      try {
        await player.seekTo(0);
      } catch {
        // A seek can fail while the item is still loading; play anyway.
      }
      // The spoken line's length (without the pad) is the watchdog's base: a
      // take that is never ended by the line stops itself a few seconds past it.
      // A calibration is always the whole line (calibrateSpeaker clears a
      // phrase first): the speaker profile is global and a slice is too short
      // to learn it from.
      const span = mode === 'calibrate' ? null : phrase.audio;
      if (!(await take.startTake(lineEnd || undefined, speed, mode, lagMs, span))) return;
      crossed.current = false;
      startPlayback(player);
    } finally {
      startingTake.current = false;
    }
  }

  // Stamps where line time 0 sits in the take (see markLineStart) the first
  // time playback status arrives with a real position during a take, so a
  // headphone take (no echo for the backend to anchor on) can still be
  // scored.
  useEffect(() => {
    if (take.phase === 'recording' && take.mode === 'take' && status.playing && status.currentTime > 0) {
      take.markLineStart(status.currentTime);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status.playing, status.currentTime, take.phase, take.mode]);

  async function recordTake() {
    await beginRecording('take');
  }

  // Calibrating with a phrase set goes back to the whole line first and
  // starts once that audio is swapped in (the effect below), so the phone
  // plays exactly the reference the backend calibrates against.
  const calibrateWhenLoaded = useRef(false);
  async function calibrateSpeaker() {
    if (phrase.span) {
      clearPhrase();
      playWhenLoaded.current = false;
      calibrateWhenLoaded.current = true;
      return;
    }
    await beginRecording('calibrate');
  }
  useEffect(() => {
    if (!calibrateWhenLoaded.current || !source) return;
    calibrateWhenLoaded.current = false;
    void beginRecording('calibrate');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [source, player]);

  function compare() {
    if (compareNext.current || (take.takePlaying && comparing)) {
      dropTake();
      stopPlayback(player);
      return;
    }
    playWhenLoaded.current = false;
    closePanel();
    setDragSpan(null);
    take.stopTake();
    compareNext.current = true;
    setComparing(true);
    ringPhase.current = 'idle';
    void (async () => {
      try {
        await player.seekTo(0);
      } catch {
        // A seek can fail while the item is still loading; play anyway.
      }
      crossed.current = false;
      startPlayback(player);
    })();
  }

  function hearTake() {
    if (take.takePlaying) {
      take.stopTake();
      return;
    }
    closePanel();
    setDragSpan(null);
    compareNext.current = false;
    setComparing(false);
    if (status.playing) stopPlayback(player);
    take.playTake();
  }

  // A compare run covers both halves, the line then the take, so it only
  // ends here when the take finishes playing on its own; the Compare pill
  // stopping it early is handled in compare() and dropTake() above. This also
  // covers My take finishing on its own. Android gives audio focus back by
  // itself when the take player stops; on iOS the duck lasts as long as the
  // session is active, so releaseAudioSession() hands the volume back here.
  useEffect(() => {
    if (wasTakePlaying.current && !take.takePlaying && !status.playing) {
      if (comparing) setComparing(false);
      void releaseAudioSession();
    }
    wasTakePlaying.current = take.takePlaying;
  }, [take.takePlaying, comparing, status.playing]);

  // The word player finishing on its own is also a stop point: Hear it never
  // loops, so once it stops (and the line is not playing) nothing of ours
  // should still be making sound.
  const wasWordPlaying = useRef(false);
  useEffect(() => {
    if (wasWordPlaying.current && !wordStatus.playing && !status.playing) void releaseAudioSession();
    wasWordPlaying.current = wordStatus.playing;
  }, [wordStatus.playing, status.playing]);

  // ROUND C: opens the Island menu sheet.
  function openIslandMenu() {}

  // ROUND C: opens the Practice sheet.
  function openPractice() {}

  if (error && !island) {
    return (
      <SafeAreaView style={StyleSheet.flatten([styles.fill, styles.center, { backgroundColor: tide.sky[0] }])}>
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
      <SafeAreaView style={StyleSheet.flatten([styles.fill, styles.center, { backgroundColor: tide.sky[0] }])}>
        <ActivityIndicator color={palette.accent} />
      </SafeAreaView>
    );
  }
  if (!line) {
    // Still building, failed, or interrupted with nothing left: never a
    // silent spinner. Offer the way out.
    const busy = island.status === 'pending' || island.status === 'working';
    return (
      <SafeAreaView style={StyleSheet.flatten([styles.fill, styles.center, { backgroundColor: tide.sky[0] }])}>
        <Stack.Screen options={{ title: island.title || 'Island' }} />
        {busy ? <ActivityIndicator color={palette.accent} /> : null}
        <Text style={[styles.body, { color: busy ? tide.textDim : palette.danger }]}>
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
            <Text style={[styles.retryText, { color: tide.textDim }]}>Refresh</Text>
          </Pressable>
        )}
      </SafeAreaView>
    );
  }

  if (regenerating) {
    return (
      <SafeAreaView style={StyleSheet.flatten([styles.fill, styles.center, { backgroundColor: tide.sky[0] }])}>
        <Stack.Screen options={{ title: island.title || 'Island' }} />
        <ActivityIndicator color={palette.accent} />
        <Text style={[styles.body, { color: tide.textDim }]}>
          {api.STAGE_LABEL[buildStage] ?? 'Rebuilding this island…'}
        </Text>
      </SafeAreaView>
    );
  }

  // currentTime is a position in the source audio, not wall clock, so it maps
  // straight onto the word spans no matter what the playback rate is.
  // Word spans are stored for speed 1.0; the rendered audio is 1/speed as long.
  // Only a playing line lights up. Paused or finished, nothing is green.
  // The phrase audio starts at the phrase's first word, so the position is
  // shifted back onto the line's own timings.
  // The breath after a phrase runs the shifted position past the phrase, so
  // only the phrase's own words may light up.
  const at = position + phrase.offsetSec;
  const found = status.playing
    ? line.words.findIndex((w) => at >= w.start / speed && at < w.end / speed)
    : -1;
  const activeWord =
    phrase.span && (found < phrase.span.from || found > phrase.span.to) ? -1 : found;
  // The last take's per-word timing marks, index-aligned with line.words.
  // Only shown once that take is ready: otherwise the old take's marks would
  // stay up while a new one is recording.
  const marks = take.phase === 'ready' ? take.take?.score?.words ?? null : null;
  const reading = line.timeline.map((m) => m.kana).join('');
  // Under the sentence: the kana or romaji line by mode, nothing in Furigana
  // mode (the reading is on the kanji). The pitch strip is the kana line with
  // marks; in Kana mode it stands in for the plain line, in the other modes
  // it is its own row.
  const modeLine = readingMode === 'kana' ? reading : readingMode === 'romaji' ? lineRomajiText : null;
  const cells = pitch ? linePitchCells : null;

  const ringMode: RingMode = status.playing ? (inBreath ? 'breath' : 'playing') : 'idle';

  // Popover under the tapped word, centred on it, kept inside the block.
  const box = selected !== null ? wordBoxes.current[selected] : undefined;
  const popLeft = box
    ? Math.max(0, Math.min(blockWidth - POPOVER_WIDTH, box.x + box.width / 2 - POPOVER_WIDTH / 2))
    : 0;
  const popTop = box ? box.y + box.height + 6 : 0;

  // The Repeat popup under a drag selection: the same clamping approach as
  // the word popover above, but anchored to the union of the span's word
  // boxes instead of one box.
  const dragBoxes = dragSpan
    ? Array.from(
        { length: dragSpan.to - dragSpan.from + 1 },
        (_, k) => wordBoxes.current[dragSpan.from + k],
      ).filter((b): b is { x: number; y: number; width: number; height: number } => !!b)
    : [];
  const dragUnion = dragBoxes.length
    ? dragBoxes.reduce(
        (acc, b) => ({
          x: Math.min(acc.x, b.x),
          y: Math.min(acc.y, b.y),
          right: Math.max(acc.right, b.x + b.width),
          bottom: Math.max(acc.bottom, b.y + b.height),
        }),
        { x: Infinity, y: Infinity, right: -Infinity, bottom: -Infinity },
      )
    : null;
  const dragPopLeft = dragUnion
    ? Math.max(
        0,
        Math.min(
          blockWidth - SELECTION_POPUP_WIDTH,
          dragUnion.x + (dragUnion.right - dragUnion.x) / 2 - SELECTION_POPUP_WIDTH / 2,
        ),
      )
    : 0;
  const dragPopTop = dragUnion ? dragUnion.bottom + 6 : 0;
  const progress = status.duration > 0 ? status.currentTime / status.duration : 0;

  // The sentence sits on the waterline: the tappable block when words are
  // known, the fallback line when they are not, then the reading and pitch
  // rows. Blind swaps the whole slot for the peek prompt.
  const sentence = hidden ? (
    <Pressable onPress={() => setPeekKey(lineKey)} style={styles.peek} accessibilityRole="button">
      <Text style={styles.peekText}>Tap to peek</Text>
    </Pressable>
  ) : (
    <>
      {line.words.length > 0 ? (
        <View style={styles.block} onLayout={(e) => setBlockWidth(e.nativeEvent.layout.width)}>
          <GestureDetector gesture={sentenceGesture}>
            <View style={styles.words}>
              {line.words.map((w, i) => (
                <RubyWord
                  key={i}
                  word={w}
                  showRuby={readingMode === 'furigana'}
                  active={i === activeWord}
                  selected={i === selected || (!!dragSpan && i >= dragSpan.from && i <= dragSpan.to)}
                  dimmed={!!phrase.span && (i < phrase.span.from || i > phrase.span.to)}
                  mark={marks && marks[i] !== 'ok' && marks[i] !== 'none' ? marks[i] : null}
                  onLayout={(e) => {
                    wordBoxes.current[i] = e.nativeEvent.layout;
                  }}
                />
              ))}
            </View>
          </GestureDetector>
          {selected !== null && line.words[selected] ? (
            <WordPanel
              word={line.words[selected]!.text}
              gloss={glossData}
              left={popLeft}
              top={popTop}
              romaji={readingMode === 'romaji'}
              onHear={() => hearWord()}
              onClose={closePanel}
            />
          ) : null}
          {dragSpan && dragUnion ? (
            <SelectionPopup left={dragPopLeft} top={dragPopTop} onRepeat={repeatSelection} />
          ) : null}
        </View>
      ) : (
        <Text style={styles.ja}>{line.ja}</Text>
      )}

      {modeLine !== null && !(readingMode === 'kana' && cells) ? (
        <Text style={styles.reading}>{modeLine}</Text>
      ) : null}
      {cells ? <PitchReading cells={cells} /> : null}
    </>
  );

  // The same words again, drawn upside down under the waterline by the
  // scene itself; never tappable, so no panel, no popup, no marks.
  const reflection = hidden ? null : line.words.length > 0 ? (
    <View style={styles.words}>
      {line.words.map((w, i) => (
        <RubyWord
          key={i}
          word={w}
          showRuby={readingMode === 'furigana'}
          active={i === activeWord}
          dimmed={!!phrase.span && (i < phrase.span.from || i > phrase.span.to)}
          selected={false}
          mark={null}
          onLayout={() => {}}
        />
      ))}
    </View>
  ) : (
    <Text style={styles.ja}>{line.ja}</Text>
  );

  const below = (
    <>
      {!hideEnglish && !hidden ? (
        <Pressable onPress={() => setShowEnglish((v) => !v)}>
          <Text style={[styles.en, { color: showEnglish ? tide.text : tide.textDim }]}>
            {showEnglish ? line.en : 'Tap to show the English'}
          </Text>
        </Pressable>
      ) : null}
      <PhraseBar label={phrase.label} hidden={hidden} onClear={clearPhrase} />
    </>
  );

  // ROUND C: remove this section once the sheets exist.
  const tempSection = (
    <View style={[styles.temp, { backgroundColor: palette.bg, borderTopColor: palette.line }]}>
      <Text style={[styles.tempNote, { color: palette.muted }]}>
        Temporary controls. Round C moves these into the Practice and Island sheets.
      </Text>

      <View style={styles.pillRow}>
        <Text style={[styles.pillLabel, { color: palette.muted }]}>Repeat</Text>
        {(['off', 'line', 'island'] as const).map((mode) => {
          const on = repeat === mode;
          return (
            <Pressable
              key={mode}
              onPress={() => setRepeat(mode)}
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

      <ReadingPills value={readingMode} onChange={pickReading} pitch={pitch} onTogglePitch={togglePitch} />

      <View style={styles.shadowRow}>
        <Pressable
          onPress={toggleBlind}
          style={[
            styles.pill,
            {
              backgroundColor: blind ? palette.accent : palette.surface,
              borderColor: blind ? palette.accent : palette.line,
            },
          ]}>
          <Text style={[styles.pillText, { color: blind ? palette.accentInk : palette.ink }]}>Blind</Text>
        </Pressable>
        <Pressable
          onPress={toggleHideEnglish}
          style={[
            styles.pill,
            {
              backgroundColor: hideEnglish ? palette.accent : palette.surface,
              borderColor: hideEnglish ? palette.accent : palette.line,
            },
          ]}>
          <Text style={[styles.pillText, { color: hideEnglish ? palette.accentInk : palette.ink }]}>Hide EN</Text>
        </Pressable>
        <Text style={[styles.pillLabel, styles.lagLabel, { color: palette.muted }]}>Lag</Text>
        {LAG_OPTIONS.map((ms) => {
          const on = lagMs === ms;
          return (
            <Pressable
              key={ms}
              onPress={() => pickLag(ms)}
              style={[
                styles.pill,
                {
                  backgroundColor: on ? palette.accent : palette.surface,
                  borderColor: on ? palette.accent : palette.line,
                },
              ]}>
              <Text style={[styles.pillText, { color: on ? palette.accentInk : palette.ink }]}>
                {ms === 0 ? 'Off' : `${ms / 1000}s`}
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
            const wasActive = status.playing;
            dropTake();
            stopPlayback(player);
            cancelAnimation(ring);
            ring.value = 0;
            ringPhase.current = 'idle';
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

      {editingTitle ? (
        <TextInput
          autoFocus
          value={draftTitle}
          onChangeText={setDraftTitle}
          onSubmitEditing={() => void renameTitle(draftTitle)}
          onBlur={() => void renameTitle(draftTitle)}
          style={[styles.titleInput, { color: palette.ink, borderColor: palette.line }]}
        />
      ) : (
        <Pressable
          onPress={() => {
            setDraftTitle(island.title);
            setEditingTitle(true);
            editingTitleRef.current = true;
          }}
          style={styles.action}>
          <Text style={[styles.actionText, { color: palette.accent }]}>
            {island.title || 'Untitled island'}
          </Text>
        </Pressable>
      )}

      <ExportLink
        islandId={island.id}
        title={island.title}
        speed={speed}
        gapMs={breathMs}
        disabled={revoicing || regenerating}
      />

      <Pressable onPress={confirmRegenerate} disabled={revoicing || regenerating} style={styles.action}>
        <Text style={[styles.actionText, { color: revoicing || regenerating ? palette.muted : palette.accent }]}>
          {regenerating
            ? 'Regenerating…'
            : island.complexity === 'simple'
              ? 'Regenerate with complex patterns'
              : 'Regenerate one sentence at a time'}
        </Text>
      </Pressable>

      <Pressable onPress={() => void calibrateSpeaker()} disabled={take.phase === 'recording'} style={styles.action}>
        <Text style={[styles.actionText, { color: take.phase === 'recording' ? palette.muted : palette.accent }]}>
          Calibrate speaker
        </Text>
      </Pressable>
    </View>
  );

  return (
    <SafeAreaView edges={['bottom']} style={StyleSheet.flatten([styles.fill, { backgroundColor: tide.sky[0] }])}>
      <StatusBar style="light" />
      <Stack.Screen
        options={{
          headerStyle: { backgroundColor: tide.sky[0] },
          headerTintColor: tide.text,
          headerShadowVisible: false,
          headerTitleAlign: 'center',
          headerTitle: () => <PlayerTitle title={island.title || 'Island'} lineIndex={idx} lineCount={island.lines.length} />,
          headerRight: () => (
            <PressScale onPress={openIslandMenu} hitSlop={12} accessibilityLabel="Island menu">
              <Text style={styles.menuGlyph}>…</Text>
            </PressScale>
          ),
        }}
      />

      <ScrollView ref={scrollRef} onLayout={(e) => setViewportH(e.nativeEvent.layout.height)} bounces={false}>
        <View style={{ height: viewportH }}>
          <TideScene
            lineIndex={idx}
            lineCount={island.lines.length}
            countdown={countdown}
            banner={
              error ? (
                <Pressable onPress={() => setError('')}>
                  <Text style={[styles.inlineError, { color: palette.danger }]}>{error}</Text>
                </Pressable>
              ) : undefined
            }
            sentence={sentence}
            reflection={reflection}
            below={below}
          />

          <View style={styles.dock}>
            {take.phase !== 'idle' || take.error ? (
              <TakeRow
                phase={take.phase}
                level={take.level}
                takePlaying={take.takePlaying}
                comparing={comparing}
                error={take.error}
                clean={take.clean}
                score={take.take?.score ?? null}
                calibrating={take.mode === 'calibrate' && take.phase === 'recording'}
                onRecord={() => void recordTake()}
                onCompare={compare}
                onPlayTake={hearTake}
                onCalibrate={() => void calibrateSpeaker()}
              />
            ) : null}
            <BottomRow
              ring={ring}
              ringMode={ringMode}
              onToggle={toggle}
              onPrev={prev}
              onNext={next}
              prevDisabled={idx === 0}
              nextDisabled={idx >= island.lines.length - 1}
              recording={take.phase === 'recording'}
              onRecord={() => void (take.phase === 'recording' ? toggle() : recordTake())}
              onPractice={openPractice}
            />
          </View>
        </View>

        {tempSection}
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1 },
  center: { alignItems: 'center', justifyContent: 'center' },
  scroll: { padding: Spacing.xl, gap: Spacing.lg, flexGrow: 1, justifyContent: 'center' },
  ja: { fontFamily: fonts.serifJp, fontSize: 26, lineHeight: 38, textAlign: 'center', color: tide.text },
  block: { position: 'relative', zIndex: 5 },
  words: { flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'center' },
  reading: { fontFamily: fonts.serifJp, fontSize: 16, lineHeight: 24, textAlign: 'center', color: tide.textDim },
  en: { fontFamily: fonts.ui, fontSize: 14, lineHeight: 20, textAlign: 'center', marginTop: Spacing.sm },
  peek: { minHeight: 80, alignItems: 'center', justifyContent: 'center' },
  peekText: { fontFamily: fonts.ui, fontSize: 15, color: tide.textDim },
  menuGlyph: { fontFamily: fonts.ui, fontSize: 22, color: tide.text },
  dock: {},
  body: { fontSize: 15, lineHeight: 22, textAlign: 'center', padding: Spacing.xl },
  inlineError: { fontSize: 13, lineHeight: 18, textAlign: 'center' },
  retry: { paddingVertical: Spacing.md, paddingHorizontal: Spacing.xxl, borderRadius: Radius.pill, marginTop: Spacing.md },
  secondaryBtn: { paddingVertical: Spacing.md, marginTop: Spacing.sm },
  retryText: { fontSize: 15, fontWeight: '700' },
  action: { alignItems: 'center', paddingVertical: Spacing.xs },
  actionText: { fontSize: 14, fontWeight: '600' },
  titleInput: {
    fontSize: 14,
    fontWeight: '600',
    textAlign: 'center',
    paddingVertical: Spacing.xs,
    borderBottomWidth: 1,
  },
  pillRow: { flexDirection: 'row', alignItems: 'center', gap: Spacing.sm, justifyContent: 'center' },
  pillLabel: { fontSize: 13, fontWeight: '600', minWidth: 52 },
  pill: { borderWidth: 1, borderRadius: Radius.pill, paddingVertical: Spacing.xs + 2, paddingHorizontal: Spacing.md },
  pillText: { fontSize: 13, fontWeight: '700' },
  shadowRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: Spacing.sm,
    flexWrap: 'wrap',
  },
  lagLabel: { minWidth: 0, marginLeft: Spacing.sm },
  speedRow: { flexDirection: 'row', alignItems: 'center', gap: Spacing.sm },
  slider: { flex: 1, height: 36 },
  speedValue: { fontSize: 14, fontWeight: '700', fontVariant: ['tabular-nums'], minWidth: 52, textAlign: 'right' },
  temp: { borderTopWidth: 1, padding: Spacing.lg, gap: Spacing.md },
  tempNote: { fontSize: 13, lineHeight: 18 },
});
