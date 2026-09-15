import { isRunningInExpoGo } from 'expo';
import {
  type AudioMetadata,
  type AudioStatus,
  useAudioPlayer,
  useAudioPlayerStatus,
} from 'expo-audio';
import { activateKeepAwakeAsync, deactivateKeepAwake } from 'expo-keep-awake';
import { router, Stack, useLocalSearchParams } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  AppState,
  type LayoutChangeEvent,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { Gesture, GestureDetector, ScrollView } from 'react-native-gesture-handler';
import Animated, {
  cancelAnimation,
  Easing,
  Extrapolation,
  interpolate,
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
  withSpring,
  withTiming,
} from 'react-native-reanimated';
import { SafeAreaView } from 'react-native-safe-area-context';

import { AutoEchoSheet, type EchoStep } from '@/components/tide/auto-echo-sheet';
import { BottomRow } from '@/components/tide/bottom-row';
import { IslandMenuSheet } from '@/components/tide/island-menu-sheet';
import { PlayerTitle } from '@/components/tide/player-title';
import type { SparkleResultData } from '@/components/tide/sparkle-result';
import { TideScene } from '@/components/tide/tide-scene';
import { Toolbar, type ToolbarItem } from '@/components/tide/toolbar';
import { BlindPopover } from '@/components/tide/blind-popover';
import { READING_LABEL, ReadingPopover } from '@/components/tide/reading-popover';
import { RepeatPopover, repeatTileLabel } from '@/components/tide/repeat-popover';
import { speedLabel, SpeedPopover } from '@/components/tide/speed-popover';
import { BlindIcon, ReadingIcon, RepeatIcon, SpeedIcon } from '@/components/tide/toolbar-icons';
import { PressScale } from '@/components/press-scale';
import { ExplainSheet } from '@/components/explain-sheet';
import { PhraseBar } from '@/components/phrase-bar';
import { Frost } from '@/components/frost';
import { type RingMode } from '@/components/ring-button';
import { RubyWord } from '@/components/ruby-word';
import { SELECTION_HANDLE_CLEARANCE, SelectionHandles } from '@/components/selection-handles';
import { SELECTION_POPUP_WIDTH, SelectionPopup } from '@/components/selection-popup';
import { useWordHighlight, type WordBox } from '@/components/word-highlight';
import { WordOutline } from '@/components/word-outline';
import { POPOVER_WIDTH, WordPanel } from '@/components/word-panel';
import { fonts } from '@/constants/fonts';
import { Radius, Spacing, tide } from '@/constants/theme';
import { startBack } from '@/lib/card-morph';
import { useIslandExport } from '@/hooks/use-island-export';
import { useSkyStyle } from '@/lib/sky';
import { usePhrase, type PhraseSpan } from '@/hooks/use-phrase';
import { useLineStatus } from '@/hooks/use-line-status';
import { usePracticeClock } from '@/hooks/use-practice-clock';
import { TAIL_MS, useTake, WATCHDOG_FALLBACK_MS, type TakeMode } from '@/hooks/use-take';
import * as api from '@/lib/api';
import {
  applyPlaybackMode,
  releaseAudioSession,
  startPlayback,
  stopPlayback,
  useSessionPlayer,
} from '@/lib/audio-mode';
import { wordPitches } from '@/lib/pitch';
import { lineRomaji } from '@/lib/romaji';
import {
  getSettings,
  getSettingsSync,
  setAutoEcho as persistAutoEcho,
  setAutoRecord as persistAutoRecord,
  setPlayLineWhileSpeaking as persistPlayLineWhileSpeaking,
  setBlind as persistBlind,
  setReading as persistReading,
  type ReadingMode,
} from '@/lib/settings';
import { deleteTakes, resultTier } from '@/lib/takes';
import { invalidateLineAudio, localLineAudio, prefetchLineAudio } from '@/lib/line-audio-cache';

// Expo Go on Android does not ship the AudioControlsService, and activating
// the lock screen there logs a service binding error; a dev build has it
// through the expo-audio config plugin. With the app's `duckOthers` mode iOS
// never hands Now Playing to a mixable session, so on iOS this shows nothing
// until the mode is `doNotMix`; the calls below stay in place because that
// switch is then a one-line change in audio-mode.ts.
const lockScreen = Platform.OS === 'ios' || !isRunningInExpoGo();

// How long Auto Echo holds on the sparkle result before moving on, so it has
// time to be seen (SparkleResult itself fades out a little after this).
const ECHO_RESULT_HOLD_MS = 1400;

// The exported file keeps its own breath between plays, whatever the player's
// Pause is set to.
const EXPORT_GAP_MS = 2000;

// A take's tail grows by the pause, but never more than the old Lag's 1s: a
// long pause is time between plays, not a slower take.
const TAKE_LAG_MAX_MS = 1000;

// Two finish events this close together are one ending reported twice (a
// phrase's native loop can do that at the wrap). Shorter than any line.
const FINISH_GUARD_MS = 250;
// How long the ring button keeps showing Stop for a play that was asked for
// but never started (a source that fails to load).
const PENDING_PLAY_MS = 8000;
// How long after a source swap a status still carrying the old source's
// duration is read as the old source's, delivered late.
const SWAP_STALE_MS = 2000;
// How long a Play tap waits for the seek to the top before it plays anyway.
const SEEK_WAIT_MS = 200;

// A vertical swipe drags the active card at 0.35 of the finger's travel,
// with rubber-band damping past 40pt so it never tracks the raw drag once
// the swipe has clearly read as a gesture rather than a nudge.
const DRAG_RATE = 0.35;
const DRAG_LIMIT = 40;
function rubberBandDragY(translationY: number): number {
  const scaled = translationY * DRAG_RATE;
  const abs = Math.abs(scaled);
  if (abs <= DRAG_LIMIT) return scaled;
  const sign = Math.sign(scaled);
  const over = abs - DRAG_LIMIT;
  return sign * (DRAG_LIMIT + (over * DRAG_LIMIT) / (over + DRAG_LIMIT));
}

// The end of the spoken line inside the player's audio. `duration` includes
// the pad; at or below the pause length the item is not loaded yet.
function lineEndOf(duration: number, breathSec: number): number {
  return duration > breathSec ? duration - breathSec : 0;
}

// Whether the pad's silence is playing, and the whole seconds left in it.
// A take and a line played from Explain stop the line where the pad begins,
// so they never count as a breath (see `stopsAtLineEnd`).
function breathOf(s: AudioStatus, breathMs: number, stopsAtLineEnd: boolean) {
  const end = lineEndOf(s.duration, breathMs / 1000);
  const inBreath = breathMs > 0 && s.playing && end > 0 && s.currentTime >= end && !stopsAtLineEnd;
  const countdown = inBreath ? Math.max(1, Math.ceil(s.duration - s.currentTime)) : null;
  return { inBreath, countdown };
}

// A handler whose identity never changes but always runs the latest render's
// function, so a memoised child does not re-render just because the screen
// rendered again.
function useStableHandler<A extends unknown[], R>(fn: (...args: A) => R): (...args: A) => R {
  const ref = useRef(fn);
  ref.current = fn;
  return useCallback((...args: A) => ref.current(...args), []);
}

export default function IslandScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const sky = useSkyStyle();

  const [island, setIsland] = useState<api.Island | null>(null);
  const [error, setError] = useState('');
  const [idx, setIdx] = useState(0);
  // `speed` is what the audio was rendered at; the Speed sheet shows the
  // live drag position, and only a release re-renders the line.
  const [speed, setSpeed] = useState<number>(() => getSettingsSync().defaultSpeed);
  // The island always plays on, line after line, wrapping from the last to
  // the first until paused. Each line plays `times` times, with `pauseMs` of
  // silence after every play (between its repeats and before the next line).
  // `pauseMs` follows the Pause ruler live; `padMs` is what the audio was
  // rendered with, set once the ruler comes to rest, since a new pad means a
  // new source and a restart.
  const [times, setTimes] = useState(() => getSettingsSync().defaultTimes);
  const [pauseMs, setPauseMs] = useState(() => getSettingsSync().defaultPauseMs);
  const [padMs, setPadMs] = useState(() => getSettingsSync().defaultPauseMs);
  // Set once the user changes speed, times or pause on this visit, so the
  // settings load (which can land after a cold start's empty cache) never
  // overrides it.
  const speedTouched = useRef(false);
  const timesTouched = useRef(false);
  const pauseTouched = useRef(false);
  // Completed plays of the line on screen, counted by the finish effect
  // against `times`. Back to 0 whenever the line starts over from a user
  // action or a new source.
  const playsDone = useRef(0);
  // Which toolbar or header sheet is open, if any: one at a time.
  const [sheet, setSheet] = useState<'echo' | 'island' | null>(null);
  // The Speed tile's popover and the tile's box, anchored like Repeat's.
  const [speedPopOpen, setSpeedPopOpen] = useState(false);
  const [speedTile, setSpeedTile] = useState<{ x: number; y: number; width: number } | null>(null);
  // The readout the Speed popover's ruler follows live; only its settle
  // commits to `speed` and restarts the line, like the Pause ruler's padMs.
  const [speedLive, setSpeedLive] = useState<number>(() => getSettingsSync().defaultSpeed);
  // The Repeat tile's popover and the tile's box, anchored like Blind's.
  const [repeatPopOpen, setRepeatPopOpen] = useState(false);
  const [repeatTile, setRepeatTile] = useState<{ x: number; y: number; width: number } | null>(null);
  // The Blind tile's popover, and where to anchor it: the tile's box in the
  // toolbar row, the dock's in the player, and the player's width.
  const [blindPopOpen, setBlindPopOpen] = useState(false);
  const [blindTile, setBlindTile] = useState<{ x: number; y: number; width: number } | null>(null);
  // The Reading tile's popover and the tile's box, anchored like Blind's.
  const [readingPopOpen, setReadingPopOpen] = useState(false);
  const [readingTile, setReadingTile] = useState<{ x: number; y: number; width: number } | null>(null);
  const [dockY, setDockY] = useState(0);
  const [playerW, setPlayerW] = useState(0);
  // An action a sheet's row picked, run once the sheet has fully closed (an
  // Alert or a share sheet shown while the Modal is dismissing can vanish on
  // iOS otherwise).
  const afterSheet = useRef<(() => void) | null>(null);
  function closeSheetThen(fn: () => void) {
    afterSheet.current = fn;
    setSheet(null);
  }
  function runAfterSheet() {
    const fn = afterSheet.current;
    afterSheet.current = null;
    if (fn) fn();
  }
  // Auto Echo's active segment fill, 0..1, animated on the UI thread the same
  // way: one shared value, aimed with withTiming over the step's real
  // duration, re-aimed only on drift. Which segment reads it is decided by
  // the step (see the effect below and SEGMENT_INDEX in AutoEchoSheet).
  const echoFill = useSharedValue(0);
  // The active card's vertical offset while a swipe drags it: 0 at rest,
  // rubber-banded toward the finger while dragging, snapped or sprung back
  // to 0 on release (see the `swipe` gesture below).
  const dragY = useSharedValue(0);
  const reducedMotion = useReducedMotion();
  // The pause after each play is silence the backend appends to the line's
  // own audio (the `pad` query param), so a repeat and the move to the next
  // line both run off the native finish event. There are no timers in the
  // loop on purpose: Android stops JS timers while the screen is locked, and
  // the native `status` (every 50ms) keeps arriving in the background on both
  // platforms, so the countdown and the take tail both key off it
  // instead. Other apps' audio stays ducked for the whole loop, pauses
  // included, and comes back at a stop point (see `releaseAudioSession`).
  // Anything that interrupts the line also drops a take in progress.
  function dropTake() {
    take.stopTake();
    void take.cancel();
  }
  // The English line under the sentence, clear or frosted. Starts from the
  // Settings default; the Blind popover flips it for this visit only.
  const [englishShown, setEnglishShown] = useState(() => !getSettingsSync().hideEnglish);
  const [blind, setBlind] = useState(false);
  // Set once the user taps Blind, so a slow settings load does not overwrite
  // the choice.
  const blindTouched = useRef(false);
  const englishTouched = useRef(false);
  // How the reading is shown (furigana over the kanji, the kana line, or
  // romaji) and whether pitch marks are drawn. Remembered like Blind.
  const [readingMode, setReadingMode] = useState<ReadingMode>('furigana');
  const [pitch, setPitchOn] = useState(true);
  const readingTouched = useRef(false);
  // Whether to keep the screen from locking while this player is open.
  const [keepAwake, setKeepAwakeState] = useState(() => getSettingsSync().keepAwake);
  const pitchTouched = useRef(false);
  const [voice, setVoice] = useState<number | null>(null);
  const [voiceName, setVoiceName] = useState('');
  const [revoicing, setRevoicing] = useState(false);
  const [regenerating, setRegenerating] = useState(false);
  // Backend stage while a regenerate runs, for the label on the waiting screen.
  const [buildStage, setBuildStage] = useState('');
  // Bumped after each regenerate so the line audio URLs change. The player
  // loads a new source only when the URL changes: the same URL would keep the
  // old wav loaded under the new text.
  const [generation, setGeneration] = useState(0);
  // The line a finger is holding to peek at in Blind mode; every other moment
  // Blind is on, the Japanese is frosted. Keyed on generation and idx, so a
  // line that changes under the finger (the island moving on) is frosted in
  // the same render that shows it.
  const lineKey = `${generation}:${idx}`;
  const [peekKey, setPeekKey] = useState<string | null>(null);
  const hidden = blind && peekKey !== lineKey;
  // A press held on the frosted English shows it until the finger lifts. Keyed
  // like peekKey, so a line change under the finger frosts again.
  const [enPeekKey, setEnPeekKey] = useState<string | null>(null);
  const enFrosted = !englishShown && enPeekKey !== lineKey;
  // The tapped word, its dictionary result, and the timer that ends Hear it.
  const [selected, setSelected] = useState<number | null>(null);
  const [glossData, setGlossData] = useState<api.Gloss | null>(null);
  // How the tapped word functions in this sentence: undefined until the
  // fetch resolves, null once it resolves empty or fails. Guarded by
  // wordRequestId so a slow answer for a word that's no longer selected
  // never lands under a different one.
  const [explainContext, setExplainContext] = useState<string | null | undefined>(undefined);
  const wordRequestId = useRef(0);
  // Where each word sits inside the sentence block, so the popover can sit
  // right under the tapped one without moving anything else, and so the drag
  // gesture below can hit-test a touch point to a word.
  const wordBoxes = useRef<Record<number, { x: number; y: number; width: number; height: number }>>({});
  const [blockWidth, setBlockWidth] = useState(0);
  const scrollRef = useRef<ScrollView>(null);
  // The run of words a drag has selected. Set on the pan gesture's start and
  // update, left alone on end: that is what shows the Repeat popup.
  const [dragSpan, setDragSpan] = useState<PhraseSpan | null>(null);
  // True while a selection handle is being dragged: hides the popup so it
  // does not sit under the finger, and keeps the two clear functions below
  // from stepping on each other.
  const [handleDragging, setHandleDragging] = useState(false);
  // The span edge a handle grab holds fixed, so dragging past it swaps
  // cleanly instead of leaving a gap or a stuck handle.
  const handleFixed = useRef(0);
  // Set by the sentence block's own onTouchStart so the scene wrapper's
  // touch guard below can tell a touch inside the block from one outside it.
  const blockTouched = useRef(false);
  const anchorWord = useRef(0);
  // The Explain sheet: one answer per line, so it clears alongside the rest
  // of the panel state on a line or speed change.
  const [explainOpen, setExplainOpen] = useState(false);
  const [explainMarked, setExplainMarked] = useState<string[]>([]);
  const [explainWhole, setExplainWhole] = useState(false);
  const [explainSpan, setExplainSpan] = useState<PhraseSpan | null>(null);
  // Bumped on every line or speed change, so an answer that lands after the
  // line moved on can tell it no longer belongs to the sentence on screen.
  const [chatGeneration, setChatGeneration] = useState(0);

  const line = island?.lines[idx];
  // The transcript's Japanese text, one entry per line: stable across the
  // 50ms position ticks so TideScene's dim lines never see a new array.
  const lines = useMemo(() => island?.lines.map((l) => l.ja) ?? [], [island]);
  // Per line, not per render: the position ticks every 50ms while playing.
  const lineRomajiText = useMemo(() => (line ? lineRomaji(line) : ''), [line]);
  const linePitches = useMemo(() => (line ? wordPitches(line) : null), [line]);
  // The pad requested from the backend: the Pause at rest. Times is not part
  // of the audio, so changing it never restarts the line.
  const breathMs = padMs;
  const takeLagMs = Math.min(breathMs, TAKE_LAG_MAX_MS);
  const { exportNow, working: exporting } = useIslandExport({
    islandId: island?.id ?? '',
    title: island?.title ?? '',
    speed,
    gapMs: EXPORT_GAP_MS,
    onError: setError,
  });
  const phrase = usePhrase(lineKey, line, speed);
  // Each word's layout box by index, on the UI thread for the underline. Kept
  // next to wordBoxes, which the JS hit-testing reads.
  const wordBoxesUI = useSharedValue<(WordBox | null)[]>([]);
  // The line audio the player should hold. A string, so a new island object
  // with the same audio (a rename) is not a new source.
  // A pause change is a new pad and so a new URL, and a playing line restarts
  // from the top, exactly like a speed change does. A phrase is its own
  // render, so setting or clearing one swaps the source like a speed change.
  const sourceUri =
    island && line
      ? api.lineAudioUrl(island.id, line.idx, `${island.speaker}-${generation}`, speed, breathMs, phrase.audio)
      : null;
  // ONE native player for the screen's whole life: a new line, speed, pause
  // or phrase swaps its source with replace() (the effect below). Giving
  // useAudioPlayer the source instead releases the native player and builds a
  // new one on every change, and every listener and effect keyed on the
  // player re-runs with it, which is the stall at each line change.
  // Native status arrives every 50ms; particles can be shorter than that, so
  // the word highlight extrapolates the position between updates on the UI
  // thread (see useWordHighlight).
  // keepAudioSessionActive: a take's mic keeps running for a second after the
  // line ends, and the session must not be torn down under it in that time.
  const player = useAudioPlayer(null, { updateInterval: 50, keepAudioSessionActive: true });
  // The source the player last loaded, and the moment it did with the old
  // source's duration: a status the old source sent just before the swap can
  // still arrive after it, and must not count for the new one (see
  // isStaleStatus).
  const loadedUri = useRef<string | null>(null);
  const swap = useRef<{ at: number; oldDuration: number } | null>(null);
  useSessionPlayer(player);
  usePracticeClock(island?.id, player);
  // The active word and its handoff to the next, derived from the audio
  // position on the UI thread: the word colours and the underline (in the
  // player and in the Explain sheet) all read this one value.
  const { highlight, reset: resetHighlight, hold: holdHighlight } = useWordHighlight(
    player,
    line?.words,
    speed,
    phrase.offsetSec,
    phrase.span,
  );
  const breathSec = breathMs / 1000;
  const take = useTake(island?.id, idx, generation);
  // Auto Echo's own step, and a ref mirror so the effects and listeners below
  // (some subscribed once, some reading state a render behind) always see the
  // current step rather than the one closed over when they were set up.
  const [echoStep, setEchoStep] = useState<EchoStep>('idle');
  const echoRef = useRef<EchoStep>('idle');
  echoRef.current = echoStep;
  // The last Play step's outcome, shown as a sparkle and word by AutoEchoSheet.
  const [echoResult, setEchoResult] = useState<SparkleResultData>(null);
  // Holds Auto Echo's advance to the next line until the result has had time
  // to show; cleared by stopEcho so closing the sheet or backgrounding never
  // leaves it running.
  const advanceHoldRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [autoEcho, setAutoEchoState] = useState(true);
  // Read when the hold ends, so turning Auto Echo off during it is honoured.
  const autoEchoRef = useRef(autoEcho);
  autoEchoRef.current = autoEcho;
  useEffect(
    () => () => {
      if (advanceHoldRef.current) clearTimeout(advanceHoldRef.current);
    },
    [],
  );
  const [autoRecord, setAutoRecordState] = useState(true);
  const autoEchoTouched = useRef(false);
  const autoRecordTouched = useRef(false);
  // Off: the Speak step records with the line silent, so no speaker bleed.
  const [playLineWhileSpeaking, setPlayLineWhileSpeakingState] = useState(false);
  const playLineTouched = useRef(false);
  // When the Speak take was started, so the take-saved effect below only
  // reacts to a take recorded during this pass (see that effect's comment).
  const speakStartedAt = useRef(0);
  // Whether that Speak take recorded with the line silent: such a take ends
  // on useTake's timer, so its length compares against the whole expected
  // take (line, tail and pause), not the line alone.
  const speakSilent = useRef(false);
  // Stop was tapped on this Speak take: the take is saving, so Stop and Retry
  // are hidden until the next Speak starts.
  const [speakStopped, setSpeakStopped] = useState(false);
  const wasEchoTakePlaying = useRef(false);
  const echoActive = sheet === 'echo' && echoStep !== 'idle' && echoStep !== 'done';
  // A take and a line played from Explain stop the line where the pad begins
  // (the crossing effect below), so no pause follows. The stop lands a status
  // or two after the crossing, and without this the countdown would flash
  // for that moment. With a 0s pause there is no pad to count down.
  const stopsAtLineEnd = take.phase === 'recording' || explainOpen;
  // The line's status renders the screen only when something drawn from it
  // changes: playing, loaded, the duration, a finish, the breath and its
  // countdown second. Each 50ms position update runs onLineStatus (below)
  // instead, which moves the Auto Echo fill on the UI thread and watches for
  // the line's end without a render.
  const { status, latest: latestStatus } = useLineStatus(
    player,
    onLineStatus,
    (s) => {
      const b = breathOf(s, breathMs, stopsAtLineEnd);
      return `${s.playing}|${s.isLoaded}|${s.duration}|${s.didJustFinish}|${b.inBreath}|${b.countdown}`;
    },
    (s) => !isStaleStatus(s),
  );
  const lineEnd = lineEndOf(status.duration, breathSec);
  const { inBreath, countdown } = breathOf(status, breathMs, stopsAtLineEnd);
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
  // which voice it would switch to. Also loads blind mode and the player defaults, which
  // live in the same settings file.
  useEffect(() => {
    let alive = true;
    (async () => {
      const settings = await getSettings();
      if (!alive) return;
      setVoice(settings.voice);
      // Settings can land after the user already tapped Blind or a Repeat
      // pill; what they tapped wins.
      if (!blindTouched.current) {
        setBlind(settings.blind);
        if (settings.blind) {
          closePanel();
          setDragSpan(null);
        }
      }
      if (!englishTouched.current) setEnglishShown(!settings.hideEnglish);
      if (!autoEchoTouched.current) setAutoEchoState(settings.autoEcho);
      if (!autoRecordTouched.current) setAutoRecordState(settings.autoRecord);
      if (!playLineTouched.current) setPlayLineWhileSpeakingState(settings.playLineWhileSpeaking);
      if (!readingTouched.current) setReadingMode(settings.reading);
      if (!pitchTouched.current) setPitchOn(settings.pitch);
      if (!speedTouched.current) {
        setSpeed(settings.defaultSpeed);
        setSpeedLive(settings.defaultSpeed);
      }
      if (!timesTouched.current) setTimes(settings.defaultTimes);
      if (!pauseTouched.current) {
        setPauseMs(settings.defaultPauseMs);
        setPadMs(settings.defaultPauseMs);
      }
      setKeepAwakeState(settings.keepAwake);
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

  // Keeps the screen from locking while this player is open, when the
  // setting is on. Off once the screen unmounts either way.
  useEffect(() => {
    if (!keepAwake) return;
    const tag = 'island-player';
    void activateKeepAwakeAsync(tag);
    return () => {
      void deactivateKeepAwake(tag);
    };
  }, [keepAwake]);

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
    setPlayWhenLoaded(false);
    dropTake();
    stopPlayback(player);
    try {
      await api.revoice(island.id, voice);
      invalidateLineAudio(island.id);
      const data = await waitForIsland(island.id, 60, undefined, 'Re-voicing failed');
      if (data) {
        setIsland(data);
        resetForNewAudio();
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
    const finalTitle = title.trim() || 'Untitled island';
    try {
      await api.renameIsland(island.id, finalTitle);
      // Functional update: this runs after the sheet's exit animation
      // (`onDismissed`), so `island` closed over at call time may already be
      // stale if a build or revoice updated it in the meantime.
      setIsland((cur) => cur && { ...cur, title: finalTitle });
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
    setPlayWhenLoaded(false);
    dropTake();
    stopPlayback(player);
    closePanel();
    setDragSpan(null);
    try {
      try {
        await api.regenerate(island.id, target);
        invalidateLineAudio(island.id);
      } catch (e) {
        // Nothing was started, so the island on the server still matches what
        // is on screen. Say why and go back to it.
        setError(e instanceof Error ? e.message : 'Regenerating failed');
        return;
      }
      deleteTakes(island.id);
      const data = await waitForIsland(island.id, 240, setBuildStage);
      resetHighlight();
      setGeneration((g) => g + 1);
      resetForNewAudio();
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
  // 1.0. The native loop is only for a phrase picked from the selection
  // popup, which repeats until cleared (the pad's silence becomes the pause,
  // with no gap at the wrap). Whole lines repeat and advance by hand from the
  // finish effect below. Both settings live on the native player and survive
  // a source swap.
  const phraseLoop = !!phrase.span;
  useEffect(() => {
    player.setPlaybackRate(1, 'high');
    // Auto Echo advances by hand between its own steps (Listen, then a
    // recorded Speak, then Play), so the native loop must stay off for the
    // whole pass even on a phrase.
    // A line played from the Explain sheet plays once, so no native loop
    // either while that sheet is open.
    player.loop = phraseLoop && !echoActive && !explainOpen;
  }, [player, phraseLoop, echoActive, explainOpen]);

  // Auto Echo's segment fill: which segment is "active" is `step` itself
  // (AutoEchoSheet's SEGMENT_INDEX), so this only has to animate `echoFill`
  // toward 1 over that step's real duration. Reset to 0 on every step change,
  // which is also what makes a finished step's fill hold at full: the sheet
  // renders segments before the active one as always full, so once the step
  // moves on this value stops mattering for it.
  const echoFillStep = useRef<EchoStep>('idle');
  // The Speak segment has no natural end event to key off (the learner or the
  // watchdog can stop it early), so it is aimed once per recording attempt,
  // identified by `speakStartedAt`, which a Retry bumps without changing
  // `echoStep` at all.
  const echoFillSpeakAt = useRef(-1);
  // Listen and Echo follow the line's own position, so they are aimed from
  // onLineStatus on each status as well as from the step effect below. A
  // status landing between a step change's render and that effect leaves the
  // fill alone: the effect resets it to 0 first, then aims it.
  function aimEchoLine(s: AudioStatus) {
    const step = echoRef.current;
    if (echoFillStep.current !== step) return;
    const end = lineEndOf(s.duration, breathSec);

    if (step === 'listen') {
      if (!s.playing || end <= 0) return;
      const target = Math.min(1, s.currentTime / end);
      if (echoFill.value === 0 || Math.abs(echoFill.value - target) > 0.08) {
        cancelAnimation(echoFill);
        echoFill.value = target;
        const remaining = Math.max(0, (end - s.currentTime) * 1000);
        echoFill.value = withTiming(1, { duration: remaining, easing: Easing.linear });
      }
      return;
    }

    if (step === 'echo') {
      if (breathSec <= 0 || end <= 0) return;
      const target = Math.min(1, Math.max(0, s.currentTime - end) / breathSec);
      if (echoFill.value === 0 || Math.abs(echoFill.value - target) > 0.08) {
        cancelAnimation(echoFill);
        echoFill.value = target;
        const remaining = Math.max(0, (s.duration - s.currentTime) * 1000);
        echoFill.value = withTiming(1, { duration: remaining, easing: Easing.linear });
      }
    }
  }
  useEffect(() => {
    if (echoFillStep.current !== echoStep) {
      echoFillStep.current = echoStep;
      cancelAnimation(echoFill);
      echoFill.value = 0;
    }

    if (echoStep === 'listen' || echoStep === 'echo') {
      aimEchoLine(latestStatus.current);
      return;
    }

    if (echoStep === 'speak') {
      // Still opening the mic, or the previous take's cleanup finishing:
      // hold empty until this attempt is actually recording.
      if (take.phase !== 'recording' || echoFillSpeakAt.current === speakStartedAt.current) return;
      echoFillSpeakAt.current = speakStartedAt.current;
      cancelAnimation(echoFill);
      echoFill.value = 0;
      const lineMs = lineEnd > 0 ? lineEnd * 1000 : WATCHDOG_FALLBACK_MS;
      const expected = lineMs + TAIL_MS + takeLagMs;
      echoFill.value = withTiming(1, { duration: expected, easing: Easing.linear });
      return;
    }

    if (echoStep === 'play') {
      if (take.takeDuration <= 0) return;
      const target = Math.min(1, take.takeCurrentTime / take.takeDuration);
      if (echoFill.value === 0 || Math.abs(echoFill.value - target) > 0.08) {
        cancelAnimation(echoFill);
        echoFill.value = target;
        const remaining = Math.max(0, (take.takeDuration - take.takeCurrentTime) * 1000);
        echoFill.value = withTiming(1, { duration: remaining, easing: Easing.linear });
      }
      return;
    }
    // idle, armed, done: nothing to animate. Armed holds at the 0 the step
    // change above just set (Speak has not started yet); done and idle show
    // through the sheet's static full/empty rule instead of this value.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    echoStep,
    lineEnd,
    breathSec,
    take.phase,
    take.takeCurrentTime,
    take.takeDuration,
    takeLagMs,
  ]);

  // After a line switch that should keep playing, start the new source as
  // soon as it is swapped in; the native player begins when the item is ready.
  const playWhenLoaded = useRef(false);

  // A continuous run stops the player between plays: a new line swaps the
  // source in and loads it, and a repeat seeks back to the top. `playing` is
  // false for that gap, so the ring button would flash Play at every line.
  // This holds "we asked for playback and it has not started yet", which the
  // button reads next to `playing`. Cleared by the first playing status
  // (onLineStatus), by any stop that cancels the continuation, or after
  // PENDING_PLAY_MS if the audio never starts.
  const [pendingPlay, setPendingPlayState] = useState(false);
  const pendingPlayRef = useRef(false);
  function setPendingPlay(on: boolean) {
    pendingPlayRef.current = on;
    setPendingPlayState(on);
  }
  function setPlayWhenLoaded(on: boolean) {
    playWhenLoaded.current = on;
    setPendingPlay(on);
  }
  useEffect(() => {
    if (!pendingPlay) return;
    const t = setTimeout(() => setPendingPlay(false), PENDING_PLAY_MS);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pendingPlay]);

  // Loads a new source into the one player, and starts it when a line switch
  // should keep playing (the native player begins once the item is ready).
  // Everything that used to reset with a new player resets here: the crossing,
  // the play count, the last tick and the highlight.
  useEffect(() => {
    if (!sourceUri || sourceUri === loadedUri.current) return;
    const first = loadedUri.current === null;
    swap.current = first ? null : { at: Date.now(), oldDuration: latestStatus.current.duration };
    loadedUri.current = sourceUri;
    crossed.current = false;
    playsDone.current = 0;
    lastTick.current = null;
    if (!first) resetHighlight();
    // A downloaded file loads at once; a remote URL makes iOS build the item
    // on the main thread while it waits on the network. Everything else here
    // (loadedUri, kickUri, finishUri) keeps the logical URL, not the file.
    const local = line ? localLineAudio(sourceUri, line.ja) : null;
    try {
      player.replace({ uri: local ?? sourceUri });
    } catch {
      // The screen is unmounting and the player is already released.
      return;
    }
    kickUri.current = null;
    if (!playWhenLoaded.current) return;
    playWhenLoaded.current = false;
    kickUri.current = sourceUri;
    startPlayback(player);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sourceUri, player]);
  // The lines around the current one download in the background, so the next
  // line change (or a step back) loads a local file. It runs after the change
  // has committed, and a new line, speed or pause replaces what is still
  // queued. The phrase's own render is not fetched ahead: it is only ever
  // played for the line on screen.
  useEffect(() => {
    if (!island || island.lines.length === 0) return;
    const t = setTimeout(() => {
      const n = island.lines.length;
      const order = [idx + 1, idx + 2, idx - 1, idx].map((i) => (i + n) % n);
      const version = `${island.speaker}-${generation}`;
      prefetchLineAudio(
        [...new Set(order)].map((i) => {
          const l = island.lines[i]!;
          return { url: api.lineAudioUrl(island.id, l.idx, version, speed, breathMs), tag: l.ja };
        }),
      );
    }, 0);
    return () => clearTimeout(t);
  }, [island, idx, generation, speed, breathMs]);
  // No expo-audio preload() for the next line: on iOS, replace() with a
  // preloaded URL moves that item out of the AVPlayer that loaded it into this
  // one (AudioModule.swift `replace`), and with it the line after the first
  // showed playing, stayed silent, and a seek on it never returned. A plain
  // replace() builds a fresh item, the path the first line plays through.

  // The source a swap asked to play. play() lands while the item is still
  // loading; if the first status that shows it loaded is still paused while
  // the play is pending, it is asked once more (see onLineStatus).
  const kickUri = useRef<string | null>(null);

  // seekTo resolves when the native seek completes, and a seek on an item
  // that never loads never completes. Play goes ahead after SEEK_WAIT_MS
  // either way, so a tap on the button always does something.
  async function seekTop() {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        player.seekTo(0),
        new Promise<void>((resolve) => {
          timer = setTimeout(resolve, SEEK_WAIT_MS);
        }),
      ]);
    } catch {
      // A seek can fail while the item is still loading; play anyway.
    } finally {
      clearTimeout(timer);
    }
  }

  // A status the old source sent just before a swap and delivered after it:
  // it still carries the old source's duration. Once the new source reports
  // its own duration, nothing more is filtered.
  function isStaleStatus(s: AudioStatus): boolean {
    const sw = swap.current;
    if (!sw) return false;
    if (Date.now() - sw.at > SWAP_STALE_MS) {
      swap.current = null;
      return false;
    }
    if (s.duration > 0 && s.duration === sw.oldDuration) return true;
    if (s.duration > 0) swap.current = null;
    return false;
  }

  // Lock screen / notification text. Blind mode never shows the Japanese.
  function lockMeta(): AudioMetadata {
    const pos = `Line ${idx + 1} of ${island!.lines.length}`;
    const artist = island!.title || 'Island';
    return blind ? { title: pos, artist } : { title: phrase.label ?? line!.ja, artist, albumTitle: pos };
  }

  // The line player is the lock screen / notification's active player. It
  // lives as long as the screen, and releasing it on unmount clears the lock
  // screen on both platforms, so there is no explicit clear anywhere here.
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
  const backgroundRef = useRef({ take, player, dropTake, stopEcho, echoRef });
  backgroundRef.current = { take, player, dropTake, stopEcho, echoRef };
  useEffect(() => {
    const sub = AppState.addEventListener('change', (state) => {
      if (state !== 'background') return;
      const { take: t, player: p, dropTake: drop, stopEcho: stopE, echoRef } = backgroundRef.current;
      // Auto Echo stops the whole pass on backgrounding, not just a take in
      // progress: the sheet stays open showing Start.
      if (echoRef.current !== 'idle') {
        stopE();
        return;
      }
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
  // finished" moment for a take, Auto Echo's Listen step and a line played
  // from the Explain sheet. `status.currentTime` is native and keeps arriving with
  // the app in the background, unlike UI frames, so the word highlight's
  // extrapolated position must not be used here. `crossed` resets on a wrap (the
  // native loop) or a seek, and whenever the source swaps (the swap effect).
  const crossed = useRef(false);
  function watchLineEnd(s: AudioStatus) {
    const end = lineEndOf(s.duration, breathSec);
    if (!s.playing || end <= 0) return;
    if (s.currentTime < end) {
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
    // Played from the Explain sheet: once, then parked at the top of the same
    // line, whatever Repeat says. Advancing would change the line, and a line
    // change closes the sheet.
    if (explainOpen) {
      stopPlayback(player);
      void player.seekTo(0);
      void releaseAudioSession();
      return;
    }
    if (echoRef.current === 'listen') {
      // The line itself keeps playing into the pad's silence, which is the
      // Echo step's pause (the Pause setting); the countdown already reads
      // off that silence, so nothing else needs to start here.
      setEchoStep('echo');
    }
  }

  // Every native status of the line player lands here, 20 times a second
  // while it plays, without rendering the screen (see useLineStatus). The
  // work is what used to run in effects keyed on the position, in the same
  // order, and only when the position, playing, duration or line end
  // actually changed, as those effects would.
  const lastTick = useRef<{ time: number; playing: boolean; duration: number; end: number } | null>(null);
  function onLineStatus(s: AudioStatus) {
    const end = lineEndOf(s.duration, breathSec);
    const t = lastTick.current;
    if (t && t.time === s.currentTime && t.playing === s.playing && t.duration === s.duration && t.end === end) {
      return;
    }
    lastTick.current = { time: s.currentTime, playing: s.playing, duration: s.duration, end };
    if (s.didJustFinish) finishUri.current = loadedUri.current;
    if (s.playing && pendingPlayRef.current) setPendingPlay(false);
    if (s.playing) kickUri.current = null;
    else if (s.isLoaded && s.duration > 0 && kickUri.current === loadedUri.current && kickUri.current) {
      kickUri.current = null;
      if (pendingPlayRef.current) startPlayback(player);
    }
    aimEchoLine(s);
    watchLineEnd(s);
    markTakeLineStart(s);
  }

  // Every play of a whole line ends here: another play of the same line
  // while fewer than `times` are done, otherwise the next line (wrapping to
  // the first). The pad's silence has already played by now, so that is the
  // pause. A phrase's native loop repeats it until cleared, and the
  // playWhenLoaded bail-out keeps a finish from the old source from counting
  // once a line change is under way. `finishUri` is the source loaded when the
  // finish arrived: a finish that landed in the same render as a line change
  // belongs to the old line and is dropped here (a later one is dropped
  // before it renders, by isStaleStatus).
  const lastFinish = useRef(0);
  const finishUri = useRef<string | null>(null);
  useEffect(() => {
    if (!status.didJustFinish || !island || playWhenLoaded.current) return;
    if (finishUri.current !== sourceUri) return;
    const now = Date.now();
    if (now - lastFinish.current < FINISH_GUARD_MS) return;
    lastFinish.current = now;
    // With a 0s pause there is no pad after the line, so the last status can
    // arrive before lineEnd and the crossing effect above never fires. The
    // finish stands in for it: a take ends its tail from here.
    if (take.phase === 'recording') {
      if (!crossed.current) {
        crossed.current = true;
        void player.seekTo(0);
        take.scheduleStop();
      }
      return;
    }
    // A finish that slips past the crossing stop above while Explain is open
    // still must not advance the line.
    if (explainOpen) {
      void player.seekTo(0);
      void releaseAudioSession();
      return;
    }
    if (echoRef.current === 'listen' || echoRef.current === 'echo') {
      // The line's own finish, at the end of the pad, is the Echo step's own
      // end (Listen straight to here when the pause is 0s): Auto Record on
      // opens the mic at once, off arms the Record button and gives the
      // audio session back while it waits.
      if (autoRecord) {
        void startSpeak();
      } else {
        setEchoStep('armed');
        void releaseAudioSession();
      }
      return;
    }
    // The rest of an Auto Echo pass never plays the line through to here.
    if (echoRef.current !== 'idle' && echoRef.current !== 'done') return;
    if (phrase.span) return;
    playsDone.current += 1;
    if (playsDone.current < times || island.lines.length === 1) {
      if (playsDone.current >= times) playsDone.current = 0;
      // Same line again: the source stays the same, so the playWhenLoaded
      // effect never fires. Seek and play by hand instead.
      resetHighlight();
      setPendingPlay(true);
      void (async () => {
        await seekTop();
        // Stopped during the seek: the repeat is cancelled.
        if (!pendingPlayRef.current) return;
        crossed.current = false;
        startPlayback(player);
      })();
      return;
    }
    playsDone.current = 0;
    setPlayWhenLoaded(true);
    resetHighlight();
    resetForNewAudio();
    setPeekKey(null);
    setIdx((i) => (i + 1) % island.lines.length);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status.didJustFinish]);

  function closePanel() {
    stopPlayback(wordPlayer);
    setSelected(null);
    setGlossData(null);
    setExplainContext(undefined);
    wordRequestId.current++;
  }

  // A new line or speed means new audio, so the panel, any drag selection and
  // the Explain thread (which is about the old line's sentence) no longer apply.
  // Called by every handler that changes the line or the speed, next to that
  // change, so React batches all of it into the change's one render.
  function resetForNewAudio() {
    closePanel();
    setDragSpan(null);
    setHandleDragging(false);
    setExplainOpen(false);
    setChatGeneration((g) => g + 1);
  }

  async function tapWord(i: number) {
    if (!line) return;
    if (hidden) return;
    setPlayWhenLoaded(false);
    dropTake();
    if (status.playing) stopPlayback(player);
    setSelected(i);
    setGlossData(null);
    setExplainContext(undefined);
    const requestId = ++wordRequestId.current;
    try {
      const g = await api.gloss(line.words[i]!.text);
      setGlossData(g);
      try {
        const ctx = await api.explainWord(line.words[i]!.text, line.ja, line.en);
        if (wordRequestId.current === requestId) setExplainContext(ctx || null);
      } catch {
        if (wordRequestId.current === requestId) setExplainContext(null);
      }
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

  // A tap on empty space inside the active card, not a word: restarts the
  // sentence from the top, same as a swipe down. Shared by the tap gesture's
  // hitTest miss (a gap between words) and the background Pressable that
  // catches the card's own padding, which sits outside the GestureDetector's
  // view and so never reaches hitTest at all.
  function tapEmptySentence() {
    if (dragSpan) {
      clearSelection();
      return;
    }
    setPlayWhenLoaded(false);
    void playFromTop();
  }
  // What the gestures below read when they fire. They are built once, so a
  // re-render never hands GestureDetector new gesture objects (which makes it
  // reattach every handler), and read this render's state and handlers here.
  const liveNow = {
    hitTest,
    closePanel,
    tapWord,
    tapEmptySentence,
    clearSelection,
    go,
    playFromTop,
    setPlayWhenLoaded,
    reducedMotion,
    idx,
    dragSpan,
    lineKey,
    line,
  };
  const live = useRef(liveNow);
  live.current = liveNow;
  // A drag picks the phrase, snapped to whole words: hold still for the pan
  // to activate (the ScrollView is free to claim a vertical drag until then),
  // then the highlight follows the touch as `dragSpan`. A plain tap falls
  // through to the word popover instead, and also dismisses a drag selection
  // sitting from before. Both run on the JS thread: nothing here is a
  // worklet, so state and the existing async handlers can be called directly.
  //
  // A quick vertical drag reads as a swipe instead of the phrase-selection
  // pan: the pan only activates after a 450ms hold, so a fast flick falls
  // through to this before that timer fires. blocksExternalGesture holds the
  // outer scroll view off until the swipe fails, so a horizontal or slow drag
  // still reaches it. While it drags, the card follows the finger with
  // resistance (dragY, read by cardDragStyle below); on release it either
  // snaps straight back to 0 (the swipe fired, and the rise-from-water line
  // change takes over from there) or springs back with high damping (the
  // swipe fell short).
  //
  // Blind mode's only gesture on the sentence is `peek`: hold to see it, let
  // go to frost it again. No word taps, no selection and no swipes while it is
  // frosted. `peekOff` stands in for it on a line without words when Blind is
  // off.
  const { sentenceGesture, peek, peekOff } = useMemo(() => {
    const pan = Gesture.Pan()
      .activateAfterLongPress(450)
      .runOnJS(true)
      .onStart((e) => {
        const l = live.current;
        const i = l.hitTest(e.x, e.y);
        if (i === null) return;
        l.closePanel();
        anchorWord.current = i;
        setDragSpan({ from: i, to: i });
      })
      .onUpdate((e) => {
        const i = live.current.hitTest(e.x, e.y);
        if (i === null) return;
        const a = anchorWord.current;
        setDragSpan({ from: Math.min(a, i), to: Math.max(a, i) });
      });
    const tap = Gesture.Tap()
      .runOnJS(true)
      .onEnd((e) => {
        const l = live.current;
        if (l.dragSpan) {
          l.clearSelection();
          return;
        }
        const i = l.hitTest(e.x, e.y);
        if (i !== null) void l.tapWord(i);
        else l.tapEmptySentence();
      });
    const swipe = Gesture.Pan()
      .runOnJS(true)
      .activeOffsetY([-16, 16])
      .failOffsetX([-24, 24])
      .blocksExternalGesture(scrollRef)
      .onUpdate((e) => {
        if (live.current.reducedMotion) return;
        dragY.value = rubberBandDragY(e.translationY);
      })
      .onEnd((e) => {
        const l = live.current;
        const fires = e.translationY < -40 || e.velocityY < -500 || e.translationY > 40 || e.velocityY > 500;
        if (!l.reducedMotion) {
          dragY.value = fires ? 0 : withSpring(0, { damping: 26, stiffness: 300 });
        }
        if (e.translationY < -40 || e.velocityY < -500) l.go(l.idx + 1);
        else if (e.translationY > 40 || e.velocityY > 500) {
          l.setPlayWhenLoaded(false);
          l.clearSelection();
          void l.playFromTop();
        }
      });
    const peekGesture = Gesture.LongPress()
      .minDuration(120)
      .maxDistance(10000)
      .runOnJS(true)
      .onStart(() => setPeekKey(live.current.lineKey))
      .onFinalize(() => setPeekKey(null));
    return {
      sentenceGesture: Gesture.Exclusive(pan, swipe, tap),
      peek: peekGesture,
      peekOff: Gesture.LongPress().enabled(false),
    };
  }, [dragY]);
  // Follows dragY while a swipe drags the card, with a slight scale down so
  // it reads as lifting off the waterline rather than just sliding.
  const cardDragStyle = useAnimatedStyle(() => ({
    transform: [
      { translateY: dragY.value },
      { scale: interpolate(Math.abs(dragY.value), [0, DRAG_LIMIT], [1, 0.99], Extrapolation.CLAMP) },
    ],
  }));
  // The scene fades and rises 10pt into place once the line is on screen. A
  // style driven from here, not a layout `entering` animation: the wrapper
  // holds the Skia water and nested entering views, and mounting all of that
  // under a layout animation during the push is the likeliest cause of the
  // native crash on open.
  const sceneShown = !!line && !regenerating;
  const sceneIn = useSharedValue(0);
  useEffect(() => {
    if (!sceneShown) {
      cancelAnimation(sceneIn);
      sceneIn.value = 0;
      return;
    }
    sceneIn.value = withTiming(1, { duration: reducedMotion ? 200 : 220 });
  }, [sceneShown, reducedMotion, sceneIn]);
  const sceneInStyle = useAnimatedStyle(() => ({
    opacity: sceneIn.value,
    transform: [{ translateY: reducedMotion ? 0 : (1 - sceneIn.value) * 10 }],
  }));

  // A handle grab fixes the opposite edge of the span, so dragging past it
  // swaps the selection instead of leaving a gap or a stuck handle: the
  // start handle fixes `to`, the end handle fixes `from`.
  function grabHandle(which: 'start' | 'end') {
    if (!dragSpan) return;
    handleFixed.current = which === 'start' ? dragSpan.to : dragSpan.from;
    setHandleDragging(true);
    closePanel();
  }

  // Block coordinates of the dragged finger, every update: hit-test to a
  // word and rebuild the span around the fixed edge from the grab.
  function dragHandle(x: number, y: number) {
    const i = hitTest(x, y);
    if (i === null) return;
    const f = handleFixed.current;
    setDragSpan({ from: Math.min(f, i), to: Math.max(f, i) });
  }

  function releaseHandle() {
    setHandleDragging(false);
  }

  // The one place a selection actually clears, so handleDragging can never
  // stick once dragSpan is gone.
  function clearSelection() {
    setDragSpan(null);
    setHandleDragging(false);
  }

  // Any touch outside the sentence block clears a selection: the block's own
  // onTouchStart sets blockTouched first since child touch handlers fire
  // before the parent's, so a touch inside the block (words, handles, popup)
  // never reaches here as an outside touch.
  function onSceneTouch() {
    if (!blockTouched.current && dragSpan) clearSelection();
    blockTouched.current = false;
  }

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
    setPlayWhenLoaded(true);
  }

  // The drag selection's popup Explain button: reads the same dragSpan
  // Repeat does, turns it into the marked words for the sheet, and clears
  // the selection since the sheet takes over from here. A plain JS callback
  // off a Pressable.onPress, not the pan gesture, so it can read state
  // freely.
  // Opening the sheet stops the line dead: otherwise it plays on behind the
  // sheet and moves on to the next line, which the line-change
  // effect above reads as "this Explain thread is stale" and closes the sheet
  // out from under the learner. Closing the sheet does not resume it; the tap
  // handler ExplainSheet gets below (playFromTop) is the only way to hear the
  // line again while the sheet is open, and while it is open the line plays
  // once and stops at its end (the crossing and finish effects above).
  function openExplain() {
    const span = dragSpan;
    if (!span || !line) return;
    const words = line.words.slice(span.from, span.to + 1).map((w) => w.text);
    setExplainMarked(words);
    setExplainWhole(span.from === 0 && span.to === line.words.length - 1);
    setExplainSpan(span);
    setDragSpan(null);
    pausePlayback();
    setExplainOpen(true);
  }

  // Closing the sheet leaves the player paused on the same line, even when
  // the sheet's own tap had the line playing.
  function closeExplain() {
    pausePlayback();
    setExplainOpen(false);
  }

  // Back to the whole line, carrying on if it was playing.
  function clearPhrase() {
    if (!phrase.span) return;
    const wasActive = status.playing || pendingPlayRef.current;
    dropTake();
    take.discardTake();
    stopPlayback(player);
    setPlayWhenLoaded(wasActive);
    setDragSpan(null);
    phrase.clear();
  }

  // Switching lines: stop the old audio first, reset everything that belonged
  // to it, and carry on playing on the new line if we were playing.
  function go(target: number) {
    // The line never changes under the Explain sheet (see openExplain).
    if (!island || explainOpen) return;
    const clamped = Math.max(0, Math.min(island.lines.length - 1, target));
    if (clamped === idx) return;
    const wasActive = status.playing || pendingPlayRef.current;
    dropTake();
    // Leaving the line clears its phrase, and with it a take recorded on it.
    if (phrase.span) take.discardTake();
    stopPlayback(player);
    resetHighlight();
    resetForNewAudio();
    setPlayWhenLoaded(wasActive);
    setPeekKey(null);
    setIdx(clamped);
  }
  const next = () => go(idx + 1);
  const prev = () => go(idx - 1);

  // Starts the line fresh from the top, whether or not it was already
  // playing: shared by the ring's Play tap and a swipe down on the sentence.
  async function playFromTop() {
    dropTake();
    // A restart mid-word fades the highlight in again from the top instead
    // of snapping the lit word off.
    resetHighlight();
    await seekTop();
    // A short phrase can reach lineEnd before a status below it resets this.
    crossed.current = false;
    // A restart counts its plays from the top again.
    playsDone.current = 0;
    startPlayback(player);
  }

  // Stops the line exactly like the ring button's own Pause tap: drops any
  // take in progress and hands the audio session back. Safe to call whether
  // or not the line is actually playing. Shared by toggle and the Explain
  // sheet, which must stop the line the moment it opens.
  function pausePlayback() {
    // Pause the player first: it is the one call whose effect the user can
    // actually see and hear, so nothing here should sit in front of it.
    stopPlayback(player);
    setPlayWhenLoaded(false);
    dropTake();
    // Freeze the highlight where it is now: the paused status lands a moment
    // later, and running on until then could start lighting the next word.
    holdHighlight();
    void releaseAudioSession();
  }

  // Lines are short, so Play always starts the sentence from the top. There is
  // no resuming from the middle: that is never what you want when shadowing.
  async function toggle() {
    // Between two plays of a run the button shows Stop, so a tap there stops.
    const active = status.playing || pendingPlayRef.current;
    setDragSpan(null);
    if (active) {
      pausePlayback();
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

  // The Blind popover's translate toggle: frost or clear the English. Not
  // saved; the Settings default decides how the next visit starts.
  function toggleEnglish() {
    englishTouched.current = true;
    setEnPeekKey(null);
    setEnglishShown((v) => !v);
  }

  // Times is not part of the audio: the line playing carries on, and the
  // next finish counts against the new value.
  function pickTimes(next: number) {
    timesTouched.current = true;
    setTimes(next);
  }

  // Every step of the Pause ruler: the readout and the tile follow at once.
  function pickPause(ms: number) {
    pauseTouched.current = true;
    setPauseMs(ms);
  }

  function commitPause(ms: number) {
    pauseTouched.current = true;
    setPauseMs(ms);
    if (ms === padMs) return;
    // The pause is the line's pad, so the source (and the player) changes
    // with it. Same reset as a speed change: a take in progress is dropped,
    // and a playing line carries on from the top.
    const wasActive = status.playing || pendingPlayRef.current;
    dropTake();
    stopPlayback(player);
    setPlayWhenLoaded(wasActive);
    setPadMs(ms);
  }

  // Neither touches playback: switching the reading never stops the line, a
  // take or the popover. A failed save only means it is not remembered next
  // time.
  function pickReading(mode: ReadingMode) {
    readingTouched.current = true;
    setReadingMode(mode);
    persistReading(mode).catch(() => {});
  }

  // Both apply at the next transition, never interrupting the step running
  // when they are flipped.
  function toggleAutoEcho() {
    const next = !autoEcho;
    autoEchoTouched.current = true;
    setAutoEchoState(next);
    persistAutoEcho(next).catch(() => {});
  }

  function toggleAutoRecord() {
    const next = !autoRecord;
    autoRecordTouched.current = true;
    setAutoRecordState(next);
    persistAutoRecord(next).catch(() => {});
  }

  function togglePlayLineWhileSpeaking() {
    const next = !playLineWhileSpeaking;
    playLineTouched.current = true;
    setPlayLineWhileSpeakingState(next);
    persistPlayLineWhileSpeaking(next).catch(() => {});
  }

  // The Speed popover's ruler follows every step live; only used to update
  // the readout and the tile, never the audio.
  function pickSpeed(next: number) {
    speedTouched.current = true;
    setSpeedLive(next);
  }

  // The Speed ruler's settle: the line is re-rendered at the new speed, and
  // if it was playing, carries on at the new speed from the top instead of
  // going silent.
  function commitSpeed(next: number) {
    speedTouched.current = true;
    setSpeedLive(next);
    if (next === speed) return;
    const wasActive = status.playing || pendingPlayRef.current;
    dropTake();
    stopPlayback(player);
    setPlayWhenLoaded(wasActive);
    resetForNewAudio();
    setSpeed(next);
  }

  // The take is only in phase 'recording' once startTake resolves, so the pill
  // stays tappable through the permission and audio mode round trips. This
  // holds the second tap off, which would otherwise prepare the recorder again
  // and start the line twice.
  const startingTake = useRef(false);

  // Shared by startSpeak and calibrateSpeaker: only the recording mode
  // differs between a take and a speaker calibration, so both go through the
  // same cancel, close, drop, seek and play sequence and cannot drift apart.
  // `silent` records without starting the line: the take then ends on its own
  // timer in useTake instead of the line's end.
  async function beginRecording(mode: TakeMode, silent = false): Promise<boolean> {
    if (!line || startingTake.current) return false;
    startingTake.current = true;
    try {
      setPlayWhenLoaded(false);
      closePanel();
      setDragSpan(null);
      // dropTake(), but waiting for the cancel: it stops a take still
      // recording and releases the session, and that must be done before the
      // new recorder is prepared rather than land under it.
      take.stopTake();
      stopPlayback(player);
      await take.cancel();
      await seekTop();
      // The spoken line's length (without the pad) is the watchdog's base: a
      // take that is never ended by the line stops itself a few seconds past it.
      // A calibration is always the whole line (calibrateSpeaker clears a
      // phrase first): the speaker profile is global and a slice is too short
      // to learn it from.
      const span = mode === 'calibrate' ? null : phrase.audio;
      if (!(await take.startTake(lineEnd || undefined, speed, mode, takeLagMs, span, silent))) return false;
      crossed.current = false;
      if (!silent) startPlayback(player);
      return true;
    } finally {
      startingTake.current = false;
    }
  }

  // Stamps where line time 0 sits in the take (see markLineStart) the first
  // time playback status arrives with a real position during a take, so a
  // headphone take (no echo for the backend to anchor on) can still be
  // scored.
  // Run by onLineStatus for each status, and here when the take starts.
  function markTakeLineStart(s: AudioStatus) {
    if (take.phase === 'recording' && take.mode === 'take' && s.playing && s.currentTime > 0) {
      take.markLineStart(s.currentTime);
    }
  }
  useEffect(() => {
    markTakeLineStart(latestStatus.current);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [take.phase, take.mode]);

  // Calibrating with a phrase set goes back to the whole line first and
  // starts once that audio is swapped in (the effect below), so the phone
  // plays exactly the reference the backend calibrates against.
  const calibrateWhenLoaded = useRef(false);
  async function calibrateSpeaker() {
    if (phrase.span) {
      clearPhrase();
      setPlayWhenLoaded(false);
      calibrateWhenLoaded.current = true;
      return;
    }
    await beginRecording('calibrate');
  }
  useEffect(() => {
    if (!calibrateWhenLoaded.current || !sourceUri) return;
    calibrateWhenLoaded.current = false;
    void beginRecording('calibrate');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sourceUri]);

  // The Speak step's take: opens the mic with the line playing under it,
  // exactly like Record my take, so the recording is scored and cleaned the
  // same way. With Play the line while I speak off, the line stays silent and
  // the take is neither cleaned nor scored (see useTake's `silent`). `speakStartedAt` marks the moment so the take-saved effect
  // below only reacts to a take from this pass, not a stale or cancelled one.
  async function startSpeak() {
    // A second tap while the mic is still opening: the first start carries
    // on, and beginRecording would refuse this one anyway.
    if (startingTake.current) return;
    speakStartedAt.current = Date.now();
    setSpeakStopped(false);
    setEchoStep('speak');
    setEchoResult(null);
    speakSilent.current = !playLineWhileSpeaking;
    const ok = await beginRecording('take', speakSilent.current);
    if (!ok) {
      setEchoStep('idle');
      return;
    }
    // The sheet closed (or the app went to the background) while the mic was
    // opening: stopEcho found nothing to cancel yet, so drop this take now.
    if (echoRef.current !== 'speak') {
      stopPlayback(player);
      void take.cancel();
    }
  }

  // Moves the loop on to the next line (or restarts the only line an island
  // has) after a Play step finishes, and starts its Listen step.
  async function advanceEcho() {
    if (!island) return;
    if (island.lines.length === 1) {
      await seekTop();
      // The sheet closed during the seek.
      if (echoRef.current !== 'play') return;
      crossed.current = false;
      setEchoStep('listen');
      startPlayback(player);
      return;
    }
    go((idx + 1) % island.lines.length);
    // go() reads status.playing, which is false here (the take was the thing
    // playing), so the line has to be told to play once the new one loads.
    setPlayWhenLoaded(true);
    setEchoStep('listen');
  }

  // Starts (or restarts) the loop on the current line.
  function startEcho() {
    setEchoStep('listen');
    void playFromTop();
  }

  function openEcho() {
    setEchoResult(null);
    setSheet('echo');
    startEcho();
  }

  // Ends the loop: called when the sheet closes and when the app backgrounds
  // mid-pass. Drops any take in progress and any that just finished recording.
  function stopEcho() {
    if (advanceHoldRef.current) {
      clearTimeout(advanceHoldRef.current);
      advanceHoldRef.current = null;
    }
    setEchoStep('idle');
    setEchoResult(null);
    setPlayWhenLoaded(false);
    dropTake();
    stopPlayback(player);
    void player.seekTo(0);
    void releaseAudioSession();
  }

  // The Speak step's take, once saved and its player loaded, starts the Play
  // step. `recordedAt` has to be newer than when this pass's Speak began: a
  // Retry's cancel flickers `phase` back to 'ready' with the take it is about
  // to replace, and a line switched away and back still carries its own old
  // take, and neither should be mistaken for the one just recorded. It also
  // waits out the echo cleanup: the cleaned file landing swaps the take
  // player, which would cut a take already playing off mid-word.
  useEffect(() => {
    if (
      echoRef.current === 'speak' &&
      take.phase === 'ready' &&
      take.clean.state !== 'working' &&
      take.takeLoaded &&
      take.take &&
      take.take.recordedAt > speakStartedAt.current
    ) {
      setEchoStep('play');
      take.playTake();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [take.phase, take.take?.recordedAt, take.takeLoaded, take.clean.state]);

  // The Play step's take finishing on its own is a stop point: Android gives
  // audio focus back by itself when the take player stops; on iOS the duck
  // lasts as long as the session is active, so releaseAudioSession() hands
  // the volume back here.
  useEffect(() => {
    if (wasTakePlaying.current && !take.takePlaying && !status.playing) {
      void releaseAudioSession();
    }
    wasTakePlaying.current = take.takePlaying;
  }, [take.takePlaying, status.playing]);

  // The Play step's take finishing on its own moves the loop on: Auto Echo on
  // advances to the next line (wrapping like the player does), off ends the
  // pass at Pass complete.
  useEffect(() => {
    if (wasEchoTakePlaying.current && !take.takePlaying && echoRef.current === 'play') {
      const expectedSec =
        speakSilent.current && lineEnd > 0 ? lineEnd + (TAIL_MS + takeLagMs) / 1000 : lineEnd;
      const tier = resultTier(take.take?.score ?? null, take.takeDuration, expectedSec);
      setEchoResult({ id: Date.now(), tier });
      if (autoEcho) {
        advanceHoldRef.current = setTimeout(() => {
          advanceHoldRef.current = null;
          // Auto Echo turned off during the hold: end the pass instead.
          if (!autoEchoRef.current) {
            if (echoRef.current === 'play') setEchoStep('done');
            return;
          }
          void advanceEcho();
        }, ECHO_RESULT_HOLD_MS);
      } else {
        setEchoStep('done');
      }
    }
    wasEchoTakePlaying.current = take.takePlaying;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [take.takePlaying]);

  // The word player finishing on its own is also a stop point: Hear it never
  // loops, so once it stops (and the line is not playing) nothing of ours
  // should still be making sound.
  const wasWordPlaying = useRef(false);
  useEffect(() => {
    if (wasWordPlaying.current && !wordStatus.playing && !status.playing) void releaseAudioSession();
    wasWordPlaying.current = wordStatus.playing;
  }, [wordStatus.playing, status.playing]);

  function openIslandMenu() {
    // The header `…` only renders in the main return below, but
    // `Stack.Screen` options that omit `headerRight` merge onto whatever the
    // last render set, so the button (and this handler) can still be live
    // when a re-render drops into the failed/building or regenerating
    // return, none of which render a sheet. Without this guard, a tap there
    // sets `sheet` to 'island' and the menu pops open once the screen is
    // back on the main return.
    if (!line || regenerating) return;
    setSheet('island');
  }

  function confirmDelete() {
    if (!island) return;
    Alert.alert(
      `Delete "${island.title || 'Untitled island'}"?`,
      'Its lines, audio and takes are removed.',
      [
        { text: 'Cancel', style: 'cancel' },
        { text: 'Delete', style: 'destructive', onPress: () => void removeIsland() },
      ],
    );
  }

  async function removeIsland() {
    if (!island) return;
    dropTake();
    stopPlayback(player);
    try {
      await api.deleteIsland(island.id);
      invalidateLineAudio(island.id);
      deleteTakes(island.id);
      void releaseAudioSession();
      router.back();
    } catch (e) {
      Alert.alert('Could not delete', e instanceof Error ? e.message : 'The server did not answer.');
    }
  }

  // Above the dock: Speed, Repeat, Reading and Blind, each opening its own
  // popover. Opening one closes the others, and never touches playback.
  const toolbarItems = useMemo((): ToolbarItem[] => {
    const repeatOn = times > 1 || pauseMs > 0;
    const speedOn = Math.abs(speedLive - 1) > 0.001;
    const readingOn = readingMode !== 'off';
    return [
      {
        key: 'speed',
        icon: <SpeedIcon color={speedOn ? tide.lang.ja : tide.textDim} size={22} />,
        label: 'Speed',
        value: speedLabel(speedLive),
        active: speedOn,
        onPress: () => {
          setRepeatPopOpen(false);
          setReadingPopOpen(false);
          setBlindPopOpen(false);
          setSpeedPopOpen((v) => !v);
        },
        onLayout: (e) => {
          const { x, y, width } = e.nativeEvent.layout;
          setSpeedTile({ x, y, width });
        },
      },
      {
        key: 'repeat',
        icon: <RepeatIcon color={repeatOn ? tide.lang.ja : tide.textDim} size={22} />,
        label: 'Repeat',
        value: repeatTileLabel(times, pauseMs),
        active: repeatOn,
        onPress: () => {
          setSpeedPopOpen(false);
          setReadingPopOpen(false);
          setBlindPopOpen(false);
          setRepeatPopOpen((v) => !v);
        },
        onLayout: (e) => {
          const { x, y, width } = e.nativeEvent.layout;
          setRepeatTile({ x, y, width });
        },
      },
      {
        key: 'reading',
        icon: <ReadingIcon color={readingOn ? tide.lang.ja : tide.textDim} size={22} />,
        label: 'Reading',
        value: READING_LABEL[readingMode],
        active: readingOn,
        onPress: () => {
          setSpeedPopOpen(false);
          setRepeatPopOpen(false);
          setBlindPopOpen(false);
          setReadingPopOpen((v) => !v);
        },
        onLayout: (e) => {
          const { x, y, width } = e.nativeEvent.layout;
          setReadingTile({ x, y, width });
        },
      },
      {
        key: 'blind',
        icon: <BlindIcon color={blind || !englishShown ? tide.lang.ja : tide.textDim} size={22} />,
        label: 'Blind',
        value: blind && !englishShown ? 'Both' : blind ? 'JP' : !englishShown ? 'EN' : 'Off',
        active: blind || !englishShown,
        onPress: () => {
          setSpeedPopOpen(false);
          setReadingPopOpen(false);
          setRepeatPopOpen(false);
          setBlindPopOpen((v) => !v);
        },
        onLayout: (e) => {
          const { x, y, width } = e.nativeEvent.layout;
          setBlindTile({ x, y, width });
        },
      },
    ];
  }, [speedLive, times, pauseMs, readingMode, blind, englishShown]);

  // A tapped transcript line jumps there and plays it, even from a paused
  // state (go alone would leave a paused line paused).
  function jumpToLine(i: number) {
    if (explainOpen) return;
    go(i);
    setPlayWhenLoaded(true);
  }

  // What TideScene and the dock receive: the same identity on every render,
  // so the memoised children skip a render that changed nothing of theirs.
  // Each still runs the latest render's handler.
  const onLineTap = useStableHandler(jumpToLine);
  const onToggle = useStableHandler(() => void toggle());
  const onPrev = useStableHandler(prev);
  const onNext = useStableHandler(next);
  const onDockRecord = useStableHandler(() => void (take.phase === 'recording' ? toggle() : openEcho()));
  const onClearPhrase = useStableHandler(clearPhrase);
  const banner = useMemo(
    () =>
      error ? (
        <Pressable onPress={() => setError('')}>
          <Text style={[styles.inlineError, { color: tide.record }]}>{error}</Text>
        </Pressable>
      ) : undefined,
    [error],
  );
  const below = useMemo(
    () => <PhraseBar label={phrase.label} hidden={hidden} onClear={onClearPhrase} />,
    [phrase.label, hidden, onClearPhrase],
  );

  // The last take's per-word timing marks, index-aligned with line.words.
  // Only shown once that take is ready: otherwise the old take's marks would
  // stay up while a new one is recording.
  const marks = take.phase === 'ready' ? (take.take?.score?.words ?? null) : null;
  // Under the sentence: the kana or romaji line by mode, nothing in Furigana
  // mode (the reading is on the kanji). Pitch is drawn over the words
  // themselves, in every mode.
  const modeLine = useMemo(
    () =>
      !line
        ? null
        : readingMode === 'kana'
          ? line.timeline.map((m) => m.kana).join('')
          : readingMode === 'romaji'
            ? lineRomajiText
            : null,
    [line, readingMode, lineRomajiText],
  );
  const pitches = pitch ? linePitches : null;

  // Stable identities for everything the sentence card hands its children, so
  // the card below is rebuilt only when something it draws changes.
  const onTapEmpty = useStableHandler(tapEmptySentence);
  const onGrabHandle = useStableHandler(grabHandle);
  const onDragHandle = useStableHandler(dragHandle);
  const onReleaseHandle = useStableHandler(releaseHandle);
  const onHearWord = useStableHandler(() => void hearWord());
  const onClosePanel = useStableHandler(closePanel);
  const onRepeatSelection = useStableHandler(repeatSelection);
  const onOpenExplain = useStableHandler(openExplain);
  const onBlockLayout = useCallback((e: LayoutChangeEvent) => setBlockWidth(e.nativeEvent.layout.width), []);
  const onBlockTouch = useCallback(() => {
    blockTouched.current = true;
  }, []);
  const onEnPressIn = useStableHandler(() => {
    if (!englishShown) setEnPeekKey(lineKey);
  });
  const onEnPressOut = useCallback(() => setEnPeekKey(null), []);
  // Each word's box lands in wordBoxes at once, for the JS hit-testing, and
  // reaches the UI thread's copy once per frame, after the whole batch of word
  // layouts, instead of rebuilding and writing the full array for every word.
  const boxesFrame = useRef<number | null>(null);
  const writeBoxesSoon = useStableHandler(() => {
    if (boxesFrame.current !== null) return;
    boxesFrame.current = requestAnimationFrame(() => {
      boxesFrame.current = null;
      const n = live.current.line?.words.length ?? 0;
      wordBoxesUI.value = Array.from({ length: n }, (_, k) => wordBoxes.current[k] ?? null);
    });
  });
  const onWordLayout = useStableHandler((i: number, e: LayoutChangeEvent) => {
    wordBoxes.current[i] = e.nativeEvent.layout;
    writeBoxesSoon();
  });
  // A new line with fewer words may lay out no word at all (every kept box
  // is unchanged), so the UI copy is trimmed to it here as well.
  useEffect(() => {
    writeBoxesSoon();
  }, [line, writeBoxesSoon]);
  useEffect(
    () => () => {
      if (boxesFrame.current !== null) cancelAnimationFrame(boxesFrame.current);
    },
    [],
  );

  const sentence = useMemo(() => {
    if (!line) return null;
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
    const dragPopTop = dragUnion ? dragUnion.bottom + SELECTION_HANDLE_CLEARANCE : 0;

    // The sentence sits on the waterline: the tappable block when words are
    // known, the fallback line when they are not, then the reading row and the
    // English strip, all inside one card. Blind keeps all of it in place and
    // frosts the Japanese; holding it peeks. The gesture sits outside the Frost
    // because the frosted copy takes no touches; the Frost adds no offset, so
    // the gesture's coordinates still match the word boxes.
    return (
      <Animated.View style={[styles.activeCard, cardDragStyle]}>
        {line.words.length > 0 ? (
          <>
            {/* Fills the whole card, behind the block: catches a tap on the
                card's own padding, which sits outside the block's bounds and
                so never reaches the GestureDetector or its hitTest miss. Off in
                Blind mode, where only a hold on the sentence does anything. */}
            <Pressable
              style={StyleSheet.absoluteFill}
              onPress={onTapEmpty}
              disabled={blind}
              accessible={false}
            />
            <View
              style={styles.block}
              onLayout={onBlockLayout}
              onTouchStart={onBlockTouch}>
              <GestureDetector gesture={blind ? peek : sentenceGesture}>
                <View collapsable={false}>
                  <Frost frosted={hidden} blur={4.5}>
                    <View style={styles.words}>
                      {line.words.map((w, i) => (
                        <RubyWord
                          key={i}
                          word={w}
                          showRuby={readingMode === 'furigana'}
                          index={i}
                          highlight={highlight}
                          concealed={hidden}
                          selected={i === selected || (!!dragSpan && i >= dragSpan.from && i <= dragSpan.to)}
                          dimmed={!!phrase.span && (i < phrase.span.from || i > phrase.span.to)}
                          mark={marks && marks[i] !== 'ok' && marks[i] !== 'none' ? marks[i] : null}
                          pitch={pitches?.[i]}
                          onLayout={onWordLayout}
                        />
                      ))}
                    </View>
                    {hidden ? null : <WordOutline highlight={highlight} boxes={wordBoxesUI} />}
                  </Frost>
                </View>
              </GestureDetector>
              {dragSpan && wordBoxes.current[dragSpan.from] && wordBoxes.current[dragSpan.to] ? (
                <SelectionHandles
                  start={wordBoxes.current[dragSpan.from]!}
                  end={wordBoxes.current[dragSpan.to]!}
                  scrollRef={scrollRef}
                  onGrab={onGrabHandle}
                  onDrag={onDragHandle}
                  onRelease={onReleaseHandle}
                />
              ) : null}
              {selected !== null && line.words[selected] ? (
                <WordPanel
                  word={line.words[selected]!.text}
                  gloss={glossData}
                  context={explainContext}
                  left={popLeft}
                  top={popTop}
                  romaji={readingMode === 'romaji'}
                  onHear={onHearWord}
                  onClose={onClosePanel}
                />
              ) : null}
              {dragSpan && dragUnion && !handleDragging ? (
                <SelectionPopup left={dragPopLeft} top={dragPopTop} onRepeat={onRepeatSelection} onExplain={onOpenExplain} />
              ) : null}
            </View>
          </>
        ) : (
          <GestureDetector gesture={blind ? peek : peekOff}>
            <View>
              <Frost frosted={hidden} blur={4.5}>
                <Text style={styles.ja}>{line.ja}</Text>
              </Frost>
            </View>
          </GestureDetector>
        )}

        {modeLine !== null ? (
          <Frost frosted={hidden} ink={tide.textDim}>
            <Text style={styles.reading}>{modeLine}</Text>
          </Frost>
        ) : null}

        {/* The English in its own inset strip at the foot of the card. The
            Blind popover frosts or clears it; a press held on the frosted
            English only peeks, and it frosts again on release. The strip sits
            above the card's tap-to-play fill, so a press here never plays. */}
        {line.en ? (
          <Pressable
            onPressIn={onEnPressIn}
            onPressOut={onEnPressOut}
            style={styles.enStrip}
            accessibilityLabel={englishShown ? line.en : 'English translation, hidden'}>
            <Frost frosted={enFrosted} ink={tide.textDim} blur={3.5}>
              <Text style={styles.en}>{line.en}</Text>
            </Frost>
          </Pressable>
        ) : null}
      </Animated.View>
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    line,
    blind,
    hidden,
    readingMode,
    highlight,
    selected,
    dragSpan,
    phrase.span,
    marks,
    pitches,
    glossData,
    explainContext,
    blockWidth,
    handleDragging,
    modeLine,
    enFrosted,
    englishShown,
    cardDragStyle,
    sentenceGesture,
    peek,
    peekOff,
  ]);

  // The header's options, rebuilt only when something in them changes: every
  // new options object is a navigation.setOptions call and a header render.
  const onHeaderBack = useStableHandler(() => {
    if (!island || !startBack(island.id)) {
      router.back();
      return;
    }
    requestAnimationFrame(() => router.back());
  });
  const onHeaderMenu = useStableHandler(openIslandMenu);
  const headerTitleText = island?.title || 'Island';
  const headerLineCount = island?.lines.length ?? 0;
  const screenOptions = useMemo(
    () => ({
      headerStyle: { backgroundColor: sky.top },
      headerTintColor: tide.text,
      headerShadowVisible: false,
      headerTitleAlign: 'center' as const,
      headerTitle: () => <PlayerTitle title={headerTitleText} lineIndex={idx} lineCount={headerLineCount} />,
      headerLeft: () => (
        <PressScale onPress={onHeaderBack} hitSlop={12} accessibilityLabel="Back">
          <Text style={styles.backGlyph}>‹</Text>
        </PressScale>
      ),
      headerRight: () => (
        <PressScale onPress={onHeaderMenu} hitSlop={12} accessibilityLabel="Island menu">
          <Text style={styles.menuGlyph}>…</Text>
        </PressScale>
      ),
    }),
    [sky.top, headerTitleText, idx, headerLineCount, onHeaderBack, onHeaderMenu],
  );

  if (error && !island) {
    return (
      <SafeAreaView style={StyleSheet.flatten([styles.fill, styles.center, { backgroundColor: sky.top }])}>
        <Text style={[styles.body, { color: tide.record }]}>{error}</Text>
        <PressScale
          onPress={() => setAttempt((n) => n + 1)}
          style={[styles.retry, { backgroundColor: tide.lang.ja }]}>
          <Text style={[styles.retryText, { color: tide.sky[0] }]}>Retry</Text>
        </PressScale>
      </SafeAreaView>
    );
  }
  if (!island) {
    return (
      <SafeAreaView style={StyleSheet.flatten([styles.fill, styles.center, { backgroundColor: sky.top }])}>
        <ActivityIndicator color={tide.lang.ja} />
      </SafeAreaView>
    );
  }
  if (!line) {
    // Still building, failed, or interrupted with nothing left: never a
    // silent spinner. Offer the way out.
    const busy = island.status === 'pending' || island.status === 'working';
    return (
      <SafeAreaView style={StyleSheet.flatten([styles.fill, styles.center, { backgroundColor: sky.top }])}>
        <Stack.Screen options={{ title: island.title || 'Island' }} />
        {busy ? <ActivityIndicator color={tide.lang.ja} /> : null}
        <Text style={[styles.body, { color: busy ? tide.textDim : tide.record }]}>
          {busy
            ? 'Still building this island…'
            : island.error || 'This island has no lines.'}
        </Text>
        {!busy ? (
          <PressScale
            onPress={async () => {
              try {
                await api.regenerate(island.id, island.complexity);
                invalidateLineAudio(island.id);
                deleteTakes(island.id);
                setAttempt((n) => n + 1);
              } catch (e) {
                setError(e instanceof Error ? e.message : 'Could not regenerate');
              }
            }}
            style={[styles.retry, { backgroundColor: tide.lang.ja }]}>
            <Text style={[styles.retryText, { color: tide.sky[0] }]}>Regenerate</Text>
          </PressScale>
        ) : (
          <PressScale onPress={() => setAttempt((n) => n + 1)} style={styles.secondaryBtn}>
            <Text style={[styles.retryText, { color: tide.textDim }]}>Refresh</Text>
          </PressScale>
        )}
      </SafeAreaView>
    );
  }

  if (regenerating) {
    return (
      <SafeAreaView style={StyleSheet.flatten([styles.fill, styles.center, { backgroundColor: sky.top }])}>
        <Stack.Screen options={{ title: island.title || 'Island' }} />
        <ActivityIndicator color={tide.lang.ja} />
        <Text style={[styles.body, { color: tide.textDim }]}>
          {api.STAGE_LABEL[buildStage] ?? 'Rebuilding this island…'}
        </Text>
      </SafeAreaView>
    );
  }

  const ringMode: RingMode = status.playing || pendingPlay ? (inBreath ? 'breath' : 'playing') : 'idle';

  return (
    <SafeAreaView edges={['bottom']} style={StyleSheet.flatten([styles.fill, { backgroundColor: sky.top }])}>
      <StatusBar style="light" />
      <Stack.Screen options={screenOptions} />

      <Animated.View
        style={[styles.fill, sceneInStyle]}
        onTouchStart={onSceneTouch}
        onLayout={(e) => setPlayerW(e.nativeEvent.layout.width)}>
        <TideScene
          lineIndex={idx}
          lineCount={island.lines.length}
          lines={lines}
          blind={blind}
          busy={status.playing || take.phase === 'recording' || countdown !== null}
          countdown={countdown}
          banner={banner}
          sentence={sentence}
          below={below}
          scrollRef={scrollRef}
          onLineTap={onLineTap}
        />

        <View style={styles.dock} onLayout={(e) => setDockY(e.nativeEvent.layout.y)}>
          <Toolbar items={toolbarItems} />
          <BottomRow
            ringMode={ringMode}
            onToggle={onToggle}
            onPrev={onPrev}
            onNext={onNext}
            prevDisabled={idx === 0}
            nextDisabled={idx >= island.lines.length - 1}
            recording={take.phase === 'recording'}
            level={take.level}
            onRecord={onDockRecord}
          />
        </View>
        {speedPopOpen && speedTile && playerW > 0 ? (
          <SpeedPopover
            anchorX={speedTile.x + speedTile.width / 2}
            anchorTop={dockY + speedTile.y}
            width={playerW}
            speed={speedLive}
            onSpeed={pickSpeed}
            onSettle={commitSpeed}
            onClose={() => setSpeedPopOpen(false)}
          />
        ) : null}
        {readingPopOpen && readingTile && playerW > 0 ? (
          <ReadingPopover
            anchorX={readingTile.x + readingTile.width / 2}
            anchorTop={dockY + readingTile.y}
            width={playerW}
            value={readingMode}
            onChange={pickReading}
            onClose={() => setReadingPopOpen(false)}
          />
        ) : null}
        {blindPopOpen && blindTile && playerW > 0 ? (
          <BlindPopover
            anchorX={blindTile.x + blindTile.width / 2}
            anchorTop={dockY + blindTile.y}
            width={playerW}
            jaHidden={blind}
            enHidden={!englishShown}
            onToggleJa={toggleBlind}
            onToggleEn={toggleEnglish}
            onClose={() => setBlindPopOpen(false)}
          />
        ) : null}
        {repeatPopOpen && repeatTile && playerW > 0 ? (
          <RepeatPopover
            anchorX={repeatTile.x + repeatTile.width / 2}
            anchorTop={dockY + repeatTile.y}
            width={playerW}
            times={times}
            pauseMs={pauseMs}
            onTimes={pickTimes}
            onPause={pickPause}
            onPauseSettle={commitPause}
            onClose={() => setRepeatPopOpen(false)}
          />
        ) : null}
      </Animated.View>

      <AutoEchoSheet
        open={sheet === 'echo'}
        onClose={() => {
          stopEcho();
          setSheet(null);
        }}
        onDismissed={runAfterSheet}
        sentence={blind ? null : (phrase.label ?? line.ja)}
        english={englishShown ? line.en : null}
        step={echoStep}
        countdown={countdown}
        level={take.level}
        fill={echoFill}
        result={echoResult}
        error={take.error}
        autoEcho={autoEcho}
        autoRecord={autoRecord}
        onToggleAutoEcho={toggleAutoEcho}
        onToggleAutoRecord={toggleAutoRecord}
        playLineWhileSpeaking={playLineWhileSpeaking}
        onTogglePlayLineWhileSpeaking={togglePlayLineWhileSpeaking}
        onStart={startEcho}
        onRecord={() => void startSpeak()}
        stopping={speakStopped && !take.error}
        onStop={() => {
          // Before the mic is open there is nothing to stop yet.
          if (take.phase !== 'recording') return;
          setSpeakStopped(true);
          stopPlayback(player);
          void player.seekTo(0);
          take.finishNow();
        }}
        onRetry={() => void startSpeak()}
      />
      <IslandMenuSheet
        open={sheet === 'island'}
        onClose={() => setSheet(null)}
        onDismissed={runAfterSheet}
        title={island.title}
        complexity={island.complexity}
        busy={revoicing || regenerating}
        recording={take.phase === 'recording'}
        exporting={exporting}
        revoiceName={voice !== null && island.speaker !== voice ? voiceName || 'the chosen voice' : null}
        onRename={(t) => closeSheetThen(() => void renameTitle(t))}
        onExport={() => closeSheetThen(() => void exportNow())}
        onRevoice={() => closeSheetThen(() => void doRevoice())}
        onRegenerate={() => closeSheetThen(confirmRegenerate)}
        onCalibrate={() => closeSheetThen(() => void calibrateSpeaker())}
        onDelete={() => closeSheetThen(confirmDelete)}
      />
      <ExplainSheet
        open={explainOpen}
        onClose={closeExplain}
        sentenceJa={line?.ja ?? ''}
        sentenceEn={line?.en ?? ''}
        words={line.words}
        span={explainSpan}
        highlight={highlight}
        blind={blind}
        marked={explainMarked}
        whole={explainWhole}
        generation={chatGeneration}
        onPlaySentence={() => void playFromTop()}
      />
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1 },
  center: { alignItems: 'center', justifyContent: 'center' },
  scroll: { padding: Spacing.xl, gap: Spacing.lg, flexGrow: 1, justifyContent: 'center' },
  ja: { fontFamily: fonts.serifJp, fontSize: 26, lineHeight: 38, textAlign: 'center', color: tide.text },
  activeCard: {
    borderRadius: Radius.lg,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: 'rgba(255,158,128,0.35)',
    backgroundColor: 'rgba(255,255,255,0.04)',
    paddingVertical: 14,
    paddingHorizontal: 16,
  },
  block: { position: 'relative', zIndex: 5 },
  words: { flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'center' },
  reading: { fontFamily: fonts.serifJp, fontSize: 16, lineHeight: 24, textAlign: 'center', color: tide.textDim },
  enStrip: {
    marginTop: 10,
    paddingVertical: 6,
    paddingHorizontal: 16,
    borderRadius: Radius.sm,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: 'rgba(255,255,255,0.12)',
    backgroundColor: 'rgba(255,255,255,0.04)',
  },
  en: { fontFamily: fonts.ui, fontSize: 13, lineHeight: 18, textAlign: 'center', color: tide.textDim },
  menuGlyph: { fontFamily: fonts.ui, fontSize: 22, color: tide.text },
  backGlyph: { fontFamily: fonts.ui, fontSize: 28, color: tide.text },
  dock: { backgroundColor: 'rgba(0,0,0,0.18)', borderTopLeftRadius: Radius.lg, borderTopRightRadius: Radius.lg },
  body: { fontSize: 15, lineHeight: 22, textAlign: 'center', padding: Spacing.xl },
  inlineError: { fontSize: 13, lineHeight: 18, textAlign: 'center' },
  retry: { paddingVertical: Spacing.md, paddingHorizontal: Spacing.xxl, borderRadius: Radius.pill, marginTop: Spacing.md },
  secondaryBtn: { paddingVertical: Spacing.md, marginTop: Spacing.sm },
  retryText: { fontSize: 15, fontWeight: '700' },
});
