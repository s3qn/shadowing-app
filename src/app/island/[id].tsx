import { isRunningInExpoGo } from 'expo';
import {
  type AudioMetadata,
  type AudioStatus,
  useAudioPlayer,
} from 'expo-audio';
import * as Clipboard from 'expo-clipboard';
import { activateKeepAwakeAsync, deactivateKeepAwake } from 'expo-keep-awake';
import { router, useLocalSearchParams, useNavigation } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { memo, useCallback, useEffect, useEffectEvent, useLayoutEffect, useMemo, useRef, useState } from 'react';
import {
  Alert,
  AppState,
  type LayoutChangeEvent,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  useWindowDimensions,
  View,
} from 'react-native';
import { Gesture, GestureDetector, ScrollView } from 'react-native-gesture-handler';
import Animated, {
  cancelAnimation,
  Easing,
  Extrapolation,
  interpolate,
  runOnJS,
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
  withSpring,
  withTiming,
} from 'react-native-reanimated';
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';

import { AutoEchoSheet } from '@/components/tide/auto-echo-sheet';
import { BottomRow } from '@/components/tide/bottom-row';
import { IslandMenuSheet } from '@/components/tide/island-menu-sheet';
import { PlayerTitle } from '@/components/tide/player-title';
import type { SparkleResultData } from '@/components/tide/sparkle-result';
import { TideScene } from '@/components/tide/tide-scene';
import { LONG_ISLAND } from '@/components/tide/transcript-window';
import { useContentReveal, usePieceStyle } from '@/components/tide/use-content-reveal';
import { Toolbar, type ToolbarItem } from '@/components/tide/toolbar';
import { BlindPopover } from '@/components/tide/blind-popover';
import { READING_LABEL_KEY, ReadingPopover } from '@/components/tide/reading-popover';
import { RepeatPopover, repeatTileLabel } from '@/components/tide/repeat-popover';
import { speedLabel, SpeedPopover } from '@/components/tide/speed-popover';
import { BlindIcon, ReadingIcon, RepeatIcon, SpeedIcon } from '@/components/tide/toolbar-icons';
import { PressScale } from '@/components/press-scale';
import { CatConstellation } from '@/components/cat-constellation';
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
import { SlideReveal } from '@/components/slide-reveal';
import { TakeFeedback } from '@/components/take-feedback';
import { SymbolView } from 'expo-symbols'; // icon-buttons: retry/regenerate/refresh
import { PrismButton } from '@/components/prism'; // icon-buttons: retry/regenerate/refresh
import { fonts } from '@/constants/fonts';
// prism-player-buttons and icon-buttons: verb tokens
import { Radius, Spacing, prism, tide, verb } from '@/constants/theme';
import {
  afterCoverGone,
  canStartBack,
  isActive as morphActive,
  openCoverUp,
  openedLine,
  openedTitle,
  PLAYER_HEADER_ROW_H,
  playerGone,
  playerReady,
  setHeaderBoxRect,
  setHeaderTitleRect,
  startBack,
  useMorphHidesTitle,
} from '@/lib/card-morph';
import { hapticImpact } from '@/lib/haptics';
import { invalidateCachedIsland, peekCachedIsland, readCachedIsland, writeCachedIsland } from '@/lib/island-cache';
import { requestLoader } from '@/lib/loading-overlay';
import { useIslandExport } from '@/hooks/use-island-export';
import { getLastLine, peekLastLine, setLastLine } from '@/lib/last-line';
import { useSkyStyle } from '@/lib/sky';
import { usePhrase, type PhraseSpan } from '@/hooks/use-phrase';
import { useLineStatus } from '@/hooks/use-line-status';
import { usePracticeClock } from '@/hooks/use-practice-clock';
import { TAIL_MS, useTake, WATCHDOG_FALLBACK_MS, type TakeMode } from '@/hooks/use-take';
import * as api from '@/lib/api';
import {
  applyPlaybackMode,
  releaseAudioSession,
  scheduleAudioSessionRelease,
  startPlayback,
  stopPlayback,
  useSessionPlayer,
} from '@/lib/audio-mode';
import {
  afterTakePlayed,
  afterTakeSaved,
  fillKindOf,
  isActive,
  isArmedStep,
  isPlayStep,
  isSpeakStep,
  nextOnLineFinish,
  passSpeed,
  speakStepOf,
  textShownAt,
  type PassStep,
  type Programme,
} from '@/lib/pass-programme';
import { wordPitches } from '@/lib/pitch';
import { addLadder } from '@/lib/practice';
import { lineRomaji } from '@/lib/romaji';
import { forgetRung, getRung, peekRung, recordTake, setRungSpeed } from '@/lib/speed-ladder';
import {
  DEFAULT_VOICE_BY_LANGUAGE,
  getSettings,
  getSettingsSync,
  setAutoEcho as persistAutoEcho,
  setAutoRecord as persistAutoRecord,
  setBlind as persistBlind,
  setReading as persistReading,
  TIMES_MAX,
  type ReadingMode,
} from '@/lib/settings';
import { deleteTakes, resultTier, wordsKeptUp } from '@/lib/takes';
import { invalidateLineAudio, localLineAudio, prefetchLineAudio } from '@/lib/line-audio-cache';
import { useSlideReveal } from '@/lib/slide-reveal';
import { useT } from '@/lib/i18n';

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
// After the open morph's cover is gone, how long the transcript stays narrow.
const TRANSCRIPT_WIDEN_MS = 150;
// After the open morph's cover is gone, how long the first take read waits.
const TAKE_READ_AFTER_COVER_MS = 500;
// After the open morph's cover is gone, how long the cached open's network
// refresh waits, so its download and parse land after the reveal.
const REFRESH_AFTER_COVER_MS = 600;
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
  // Written at commit, not during render: nothing calls a handler between
  // the two, and the compiler needs refs left alone while rendering.
  useLayoutEffect(() => {
    ref.current = fn;
  });
  return useCallback((...args: A) => ref.current(...args), []);
}

// Stands in for a real onLayout on the plain (non-reveal) path, where no
// chunk needs to measure itself into a box.
const noopLayout = () => {};

// A setDragSpan updater that hands back the previous span when nothing moved,
// so React skips the render. Module level: the pan gesture is built once and
// must not close over a render-scoped function.
const spanUpdate = (from: number, to: number) => (prev: PhraseSpan | null) =>
  prev && prev.from === from && prev.to === to ? prev : { from, to };

const noop = () => {};

// languages: short code shown on the Blind dock tile and Home's language pill.
const LANG_CODE: Record<string, string> = { ja: 'JP', es: 'ES', en: 'EN', he: 'HE' };

export default function IslandScreen() {
  const { id, morph } = useLocalSearchParams<{ id: string; morph?: string }>();
  const navigation = useNavigation();
  const sky = useSkyStyle();
  const { t } = useT();
  // Whether the card morph that opened this island covered the screen at
  // mount. Never state: the morph's landing and cover-gone must not render
  // this whole screen. Live checks go through openCoverUp and afterCoverGone.
  const [coveredAtMount] = useState(() => openCoverUp(id));
  // Stable, for TideScene: whether the lines landing now land under the cover.
  const coverUpNow = useCallback(() => openCoverUp(id), [id]);
  // A long island's transcript opens narrow under the cover and widens a
  // moment after the cover is gone, off the landing's busy frames.
  const widenTranscript = useCallback(
    (widen: () => void) => afterCoverGone(id, widen, TRANSCRIPT_WIDEN_MS),
    [id],
  );
  const [cacheMissed, setCacheMissed] = useState(false);

  // Opened by the card morph, the local copy Home's press-in read is usually
  // parsed by the time this screen mounts. It goes into the first render, so
  // the island is on screen when the morph lands instead of one more heavy
  // render later. A long island takes this path only if its saved line is
  // already known too.
  const [warmStart] = useState(() => {
    if (!morphActive()) return null;
    const cached = peekCachedIsland(id);
    if (!cached) return null;
    const n = cached.island.lines.length;
    const saved = n >= LONG_ISLAND ? peekLastLine(id) : 0;
    if (saved === undefined) return null;
    return { ...cached, idx: Math.max(0, Math.min(saved, n - 1)) };
  });
  const warmStartRef = useRef(warmStart);
  const [loadedIsland, setIsland] = useState<api.Island | null>(() => warmStart?.island ?? null);
  // Only ever the island this screen is for: a copy left from another id
  // reads as not loaded yet.
  const island = loadedIsland && loadedIsland.id === id ? loadedIsland : null;
  const [error, setError] = useState('');
  const [idx, setIdx] = useState(() => warmStart?.idx ?? 0);
  // `speed` is what the audio was rendered at; the Speed sheet shows the
  // live drag position, and only a release re-renders the line.
  const [speed, setSpeed] = useState<number>(() => peekRung(id)?.speed ?? getSettingsSync().defaultSpeed);
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
  // Tile boxes, the dock's top and the player's width live in refs: the
  // first layout must not render the screen, and a popover opening renders
  // anyway, which is when they are read.
  const speedTile = useRef<TileBox | null>(null);
  // The readout the Speed popover's ruler follows live; only its settle
  // commits to `speed` and restarts the line, like the Pause ruler's padMs.
  const [speedLive, setSpeedLive] = useState<number>(() => peekRung(id)?.speed ?? getSettingsSync().defaultSpeed);
  // A speed the ladder decided while a line was already loaded: held here
  // until the next line change so it never swaps the audio, and with it the
  // word marks, out from under a playing take. `ladderMove` is the same
  // decision, kept only to show the kept-up line's message until it lands.
  const ladderNext = useRef<number | null>(null);
  const [ladderMove, setLadderMove] = useState<{ dir: 'up' | 'down'; speed: number } | null>(null);
  // The most recent take's `recordedAt` the ladder has already scored, so
  // reopening a line already judged does not score it twice.
  const ladderSeenAt = useRef(Date.now());
  // Bumped by every manual speed pick. `ladderDecision` reads it before its
  // file round trip and drops the answer if it changed while it was away:
  // otherwise a decision that started before the pick would land after it and
  // overwrite the chosen speed at the next line change. The slider wins.
  const ladderEpoch = useRef(0);
  // The Repeat tile's popover and the tile's box, anchored like Blind's.
  const [repeatPopOpen, setRepeatPopOpen] = useState(false);
  const repeatTile = useRef<TileBox | null>(null);
  // The Blind tile's popover, and where to anchor it: the tile's box in the
  // toolbar row, the dock's in the player, and the player's width.
  const [blindPopOpen, setBlindPopOpen] = useState(false);
  const blindTile = useRef<TileBox | null>(null);
  // The Reading tile's popover and the tile's box, anchored like Blind's.
  const [readingPopOpen, setReadingPopOpen] = useState(false);
  const readingTile = useRef<TileBox | null>(null);
  const dockY = useRef(0);
  // An open popover reads those refs at render time, so a tile, dock or width
  // change while one is open renders the screen once more. Closed, it is free.
  const popOpenRef = useRef(false);
  useLayoutEffect(() => {
    popOpenRef.current = speedPopOpen || repeatPopOpen || blindPopOpen || readingPopOpen;
  }, [speedPopOpen, repeatPopOpen, blindPopOpen, readingPopOpen]);
  const [, bumpAnchors] = useState(0);
  const anchorMoved = useCallback((moved: boolean) => {
    if (moved && popOpenRef.current) bumpAnchors((n) => n + 1);
  }, []);
  // The dock's height is layout (the scene's spacer): state, set only on a
  // real change.
  const [dockH, setDockH] = useState(0);
  // The scene's height before its first layout (the window under the header,
  // above the bottom inset), so the water is drawn from the first frame.
  const { height: windowH } = useWindowDimensions();
  const screenInsets = useSafeAreaInsets();
  const sceneEstimateH = Math.max(
    0,
    (Number.isFinite(windowH) ? windowH : 0) - screenInsets.top - screenInsets.bottom - HEADER_ROW_H,
  );
  const playerW = useRef(0);
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
  // Keyed on generation and idx, so a line change (the island moving on,
  // even mid drag-select) clears any held phrase span in the same render
  // instead of carrying an old selection onto the new line.
  const lineKey = `${generation}:${idx}`;
  const enFrosted = !englishShown;
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
  // languages: reading, furigana, pitch, POS underline, romaji, JMdict and
  // mora feedback only apply to Japanese. Defaults to Japanese while the
  // island is still loading so nothing flashes into the wrong gating.
  const isJa = (island?.language ?? 'ja') === 'ja';
  // languages: the translation line reads right to left when the learner's
  // understood language is Hebrew.
  const isRtl = island?.native === 'he';
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
  const firstTakeRead = useCallback(
    (run: () => void) => afterCoverGone(id, run, TAKE_READ_AFTER_COVER_MS),
    [id],
  );
  // The take player's status updates run this (each 50ms tick while a take
  // plays) without a render; assigned below, once the fill it moves exists.
  const takeStatusHandler = useRef<(s: AudioStatus) => void>(() => {});
  const take = useTake(island?.id, idx, generation, coveredAtMount ? firstTakeRead : undefined, (s) =>
    takeStatusHandler.current(s),
  );
  // Auto Echo's own step, and a ref mirror so the effects and listeners below
  // (some subscribed once, some reading state a render behind) always see the
  // current step rather than the one closed over when they were set up.
  const [echoStep, setEchoStep] = useState<PassStep>('idle');
  const echoRef = useRef<PassStep>('idle');
  useLayoutEffect(() => {
    echoRef.current = echoStep;
  }, [echoStep]);
  // Which programme the record button runs: the five-pass ladder or the plain
  // Auto Echo loop. Read once at mount from Settings > Playback; a change
  // made there while this sheet is open only takes effect the next time the
  // player opens, so a run in progress can never end up half in one
  // programme and half in the other.
  const [programme, setProgrammeState] = useState<Programme>(() => getSettingsSync().programme);
  // The island's speed as the current session's line started: every pass plays
  // relative to it (passSpeed) and leaving a session mid-pass restores it. The
  // session itself never writes the rung.
  const sessionBase = useRef(speed);
  // Whether the run in progress is a ladder. `programmeOf` reads the programme
  // off the step's name, which cannot tell the two apart at `idle` and `done`,
  // and both the speed restore and the rung a take is credited to still need
  // it after the last pass.
  const sessionLadder = useRef(false);
  // The Play step's fill: aimed from the take player's status updates rather
  // than a render per tick. Aims once from 0, then re-aims only if the fill
  // has drifted from the real position by more than 0.08.
  const aimTakeFill = (s: AudioStatus) => {
    if (fillKindOf(echoRef.current) !== 'take' || !s.isLoaded) return;
    if (!Number.isFinite(s.duration) || !Number.isFinite(s.currentTime) || s.duration <= 0) return;
    const target = Math.min(1, Math.max(0, s.currentTime / s.duration));
    if (echoFill.value === 0 || Math.abs(echoFill.value - target) > 0.08) {
      cancelAnimation(echoFill);
      echoFill.value = target;
      const remaining = Math.max(0, (s.duration - s.currentTime) * 1000);
      echoFill.value = withTiming(1, { duration: remaining, easing: Easing.linear });
    }
  };
  useLayoutEffect(() => {
    takeStatusHandler.current = aimTakeFill;
  });
  // The last Play step's outcome, shown as a sparkle and word by AutoEchoSheet.
  const [echoResult, setEchoResult] = useState<SparkleResultData>(null);
  // Holds Auto Echo's advance to the next line until the result has had time
  // to show; cleared by stopEcho so closing the sheet or backgrounding never
  // leaves it running.
  const advanceHoldRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [autoEcho, setAutoEchoState] = useState(true);
  // Read when the hold ends, so turning Auto Echo off during it is honoured.
  const autoEchoRef = useRef(autoEcho);
  useLayoutEffect(() => {
    autoEchoRef.current = autoEcho;
  }, [autoEcho]);
  useEffect(
    () => () => {
      if (advanceHoldRef.current) clearTimeout(advanceHoldRef.current);
    },
    [],
  );
  const [autoRecord, setAutoRecordState] = useState(true);
  const autoEchoTouched = useRef(false);
  const autoRecordTouched = useRef(false);
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
  const echoActive = sheet === 'echo' && isActive(echoStep);
  // Auto Echo leaves the text to the Blind setting; the ladder's passes decide
  // it themselves, hiding the sentence for Listen, Mumble and Shadow and
  // showing it for Read along and Compare.
  const passText = textShownAt(echoStep, programme);
  const hidden = passText === null ? blind : !passText;
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
  // Rendered only when the word loads or its playing flag flips, not per tick.
  const { status: wordStatus } = useLineStatus(wordPlayer, noop, (s) => `${s.isLoaded}:${s.playing}`);
  useSessionPlayer(wordPlayer);
  const autoPlayed = useRef<string | null>(null);

  // Play the word once as soon as its audio is ready, for each new selection.
  useEffect(() => {
    const key = wordSource?.uri ?? null;
    if (!key || !wordStatus.isLoaded || autoPlayed.current === key) return;
    autoPlayed.current = key;
    startPlayback(wordPlayer);
  }, [wordSource, wordStatus.isLoaded, wordPlayer]);
  // Under the open morph's cover, the session waits until the cover is gone.
  useEffect(() => {
    const stop = afterCoverGone(id, () => void applyPlaybackMode());
    return () => {
      stop();
      void releaseAudioSession();
    };
  }, [id]);

  const [attempt, setAttempt] = useState(0);
  // A message set just before a deliberate reload survives that reload. Every
  // other error is cleared once the island loads.
  const carryError = useRef('');
  // Opened while a re-voice is still running on the server (a second way in,
  // or Retry): wait for it with the same loader rather than show lines whose
  // audio is half old voice, half new. An effect event, so the load effect
  // does not depend on awaitRevoice, a new function every render.
  const resumeRevoice = useEffectEvent((islandId: string) => {
    if (revoicing || regenerating) return;
    setRevoicing(true);
    void awaitRevoice(islandId);
  });
  useEffect(() => {
    let alive = true;
    // The raw text of what is on screen, once something is: the local copy
    // or the network's answer, whichever lands first.
    let shownText: string | null = null;
    let cachedText: string | null = null;
    // The first render already showed the local copy: only the network
    // refresh is left to run.
    const warm = attempt === 0 && warmStartRef.current?.island.id === id ? warmStartRef.current : null;
    if (warm) {
      shownText = warm.text;
      cachedText = warm.text;
    }
    // Puts an island on screen for the first time on this open.
    async function show(data: api.Island, text: string) {
      // A long island reopens where it was left; short ones still start at line 1.
      if (data.status === 'ready' && data.lines.length >= LONG_ISLAND) {
        const saved = await getLastLine(id);
        if (!alive || shownText !== null) return false;
        setIdx(Math.max(0, Math.min(saved, data.lines.length - 1)));
      } else {
        setIdx((i) => Math.max(0, Math.min(i, data.lines.length - 1)));
      }
      shownText = text;
      setIsland(data);
      setError(carryError.current);
      carryError.current = '';
      return true;
    }
    async function readCache() {
      const cached = await readCachedIsland(id);
      if (!alive) return;
      if (!cached) {
        setCacheMissed(true);
        return;
      }
      cachedText = cached.text;
      if (shownText !== null) return;
      await show(cached.island, cached.text);
    }
    // The local copy is read and parsed after the first frame, so the open
    // transition starts before any of that work. Under a card morph the
    // transition already ran (and Home started this read on press-in), so
    // it is picked up at once.
    const raf = warm
      ? null
      : morphActive()
        ? null
        : requestAnimationFrame(() => {
            setTimeout(() => void readCache(), 0);
          });
    if (!warm && raf === null) void readCache();
    const refresh = async () => {
      try {
        const text = await api.getIslandText(id);
        if (!alive) return;
        // The same bytes as what is on screen (and so in the local copy):
        // nothing to parse, set or write.
        if (shownText !== null && text === shownText) {
          return;
        }
        const data = JSON.parse(text) as api.Island;
        // Lines with a working status: a re-voice is running on the server.
        if (data.status === 'working' && data.lines.length > 0) resumeRevoice(id);
        if (shownText === null && (await show(data, text))) {
          // Nothing left to do here: show() already put the island on screen.
        } else if (!alive) {
          return;
        } else if (shownText !== null && text !== shownText) {
          // The server moved past the local copy: swap it in where the
          // user is now, inside the new line count.
          shownText = text;
          setIdx((i) => Math.max(0, Math.min(i, data.lines.length - 1)));
          setIsland(data);
        }
        if (text && data.status === 'ready') {
          if (text !== cachedText) setTimeout(() => writeCachedIsland(data, text), 0);
        } else {
          invalidateCachedIsland(id);
        }
      } catch (e) {
        if (alive) setError(e instanceof Error ? e.message : t('player.couldNotLoadIsland'));
      }
    };
    // Opened from the local copy under the morph: the refresh waits until the
    // cover is gone and the reveal has run, so its download and any parse
    // stay out of the landing.
    const stopRefresh = warm ? afterCoverGone(id, () => void refresh(), REFRESH_AFTER_COVER_MS) : null;
    if (!warm) void refresh();
    return () => {
      alive = false;
      stopRefresh?.();
      if (raf !== null) cancelAnimationFrame(raf);
    };
  }, [id, attempt]);

  // Tells a covering card morph the player has its first content on screen:
  // the island, an error, or no local copy (the network's answer then fades
  // in on its own). Two frames, so the content is laid out and drawn first.
  const firstContent = island !== null || !!error || cacheMissed;
  const readySentRef = useRef(false);
  // One-shot: fires from commit (not from an effect that waits a tick after
  // it), one frame so the content just committed is laid out and drawn
  // first, then never again for this mount.
  // The ref is set inside the frame, so a cancelled frame (a StrictMode
  // remount) sends again. With the lines in hand the loader is cleared right
  // here, without waiting for the landing render and its effect.
  // Sent straight from the commit, not from a frame: a frame waits out the
  // whole JS backlog, and the morph's landing worklet does the rest on the UI
  // thread. The ref makes it once per mount (a StrictMode re-run sends
  // nothing new).
  // An effect event: island and error are read once, at the first content.
  const sendReady = useEffectEvent(() => {
    if (!firstContent || readySentRef.current) return;
    const waiting = island === null && !error;
    readySentRef.current = true;
    playerReady(id, { waiting });
    if (!waiting) requestLoader(false);
  });
  useLayoutEffect(() => {
    sendReady();
  }, [firstContent, id]);

  // A back morph waits for this before it shrinks into the card.
  useEffect(() => () => playerGone(id), [id]);

  // Remembers the line a long island was left on, so reopening it resumes here.
  useEffect(() => {
    if (island && island.lines.length >= LONG_ISLAND) setLastLine(id, idx);
  }, [id, idx, island]);

  // Loads blind mode and the player defaults from the settings file.
  useEffect(() => {
    let alive = true;
    (async () => {
      const settings = await getSettings();
      if (!alive) return;
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
      setProgrammeState(settings.programme);
      if (!readingTouched.current) setReadingMode(settings.reading);
      if (!pitchTouched.current) setPitchOn(settings.pitch);
      if (!timesTouched.current) setTimes(settings.defaultTimes);
      if (!pauseTouched.current) {
        setPauseMs(settings.defaultPauseMs);
        setPadMs(settings.defaultPauseMs);
      }
      setKeepAwakeState(settings.keepAwake);
      // Last, and after everything the settings file alone answers: the rung
      // is a second file read, and nothing above it should wait for it.
      const rung = await getRung(id, settings.defaultSpeed);
      if (!alive) return;
      if (!speedTouched.current) {
        setSpeed(rung.speed);
        setSpeedLive(rung.speed);
      }
    })();
    return () => {
      alive = false;
    };
  }, []);

  // The chosen voice for this island's language, and its display name, so
  // the re-voice offer can say which voice it would switch to.
  // languages: voices are remembered per learning language, so this waits for
  // the island and runs once per language rather than once per open.
  const voiceLanguage = island?.language;
  useEffect(() => {
    if (!voiceLanguage) return;
    const lang = voiceLanguage;
    let alive = true;
    (async () => {
      const settings = await getSettings();
      if (!alive) return;
      const wantId = settings.voices[lang] ?? DEFAULT_VOICE_BY_LANGUAGE[lang];
      setVoice(wantId);
      try {
        const speakers = await api.listSpeakers(lang);
        for (const sp of speakers) {
          const st = sp.styles.find((s) => s.id === wantId);
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
  }, [voiceLanguage]);

  // Keeps the screen from locking while this player is open, when the
  // setting is on. Off once the screen unmounts either way.
  // Under the open morph's cover it starts once the cover is gone.
  useEffect(() => {
    if (!keepAwake) return;
    const tag = 'island-player';
    let on = false;
    const stop = afterCoverGone(id, () => {
      on = true;
      void activateKeepAwakeAsync(tag);
    });
    return () => {
      stop();
      if (on) void deactivateKeepAwake(tag);
    };
  }, [id, keepAwake]);

  // Polls until the island settles. Returns the ready island, throws with the
  // island's error when it failed, returns null when maxSeconds pass first.
  // A poll can fail while the server is briefly unreachable; that is not the
  // island failing, so keep polling.
  async function waitForIsland(
    islandId: string,
    maxSeconds: number,
    onStage?: (stage: string) => void,
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
      if (data.status === 'failed') throw new Error(api.islandErrorText(data));
    }
    return null;
  }

  // The backend replaces the lines' audio one by one and flips the island to
  // working meanwhile. The scene and dock leave the screen for the wait (the
  // `revoicing` render branch), so no old clip can start, and the screen
  // comes back on the same line with the new voice.
  async function doRevoice() {
    if (!island || voice === null || revoicing || regenerating) return;
    setRevoicing(true);
    setPlayWhenLoaded(false);
    dropTake();
    stopPlayback(player);
    closePanel();
    setDragSpan(null);
    try {
      await api.revoice(island.id, voice);
    } catch (e) {
      // Nothing was started, so the island on the server still matches what
      // is on screen. Say why and go back to it.
      setRevoicing(false);
      setError(e instanceof Error ? e.message : t('player.reVoicingFailed'));
      return;
    }
    invalidateLineAudio(island.id);
    invalidateCachedIsland(island.id);
    await awaitRevoice(island.id);
  }

  // Waits for a running re-voice to land, then swaps the fresh island in on
  // the same line. Shared by doRevoice and the load effect, which finds an
  // island still being re-voiced when the player is opened again mid-way.
  // A failure or the 60 s timeout drops to the error screen, whose Retry
  // reloads (and waits again if the server is still working).
  async function awaitRevoice(islandId: string) {
    // A promise finally, not a try finally: the compiler does not lower those.
    const run = async () => {
      try {
        const data = await waitForIsland(islandId, 60);
        if (!mountedRef.current) return;
        // Once more after the wait: a clip fetched while the server was
        // still speaking would be the old voice.
        invalidateLineAudio(islandId);
        invalidateCachedIsland(islandId);
        if (!data) {
          setIsland(null);
          setError(t('player.reVoicingTakingLong'));
          return;
        }
        // A new generation gives the player a new source URL, so the native
        // player drops the old clip instead of keeping it.
        setGeneration((g) => g + 1);
        resetForNewAudio();
        setIdx((i) => Math.max(0, Math.min(i, data.lines.length - 1)));
        setIsland(data);
        setError('');
      } catch (e) {
        if (!mountedRef.current) return;
        setIsland(null);
        setError(e instanceof Error ? e.message : t('player.reVoicingFailed'));
      }
    };
    await run().finally(() => setRevoicing(false));
  }

  async function renameTitle(title: string) {
    if (!island) return;
    const finalTitle = title.trim() || t('player.untitledIsland');
    try {
      await api.renameIsland(island.id, finalTitle);
      invalidateCachedIsland(island.id);
      // Functional update: this runs after the sheet's exit animation
      // (`onDismissed`), so `island` closed over at call time may already be
      // stale if a build or revoice updated it in the meantime.
      setIsland((cur) => cur && { ...cur, title: finalTitle });
    } catch (e) {
      Alert.alert(t('player.couldNotRename'), e instanceof Error ? e.message : t('player.serverDidNotAnswer'));
    }
  }

  function confirmRegenerate() {
    if (!island || revoicing || regenerating) return;
    const target: api.Complexity = island.complexity === 'simple' ? 'complex' : 'simple';
    Alert.alert(
      target === 'complex' ? t('player.regenerateComplexTitle') : t('player.regenerateSimpleTitle'),
      t('player.regenerateBody'),
      [
        { text: t('common.cancel'), style: 'cancel' },
        { text: t('player.regenerateLabel'), onPress: () => void doRegenerate(target) },
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
    // A promise finally, not a try finally: the compiler does not lower those.
    const run = async () => {
      try {
        try {
          await api.regenerate(island.id, target);
          invalidateLineAudio(island.id);
          invalidateCachedIsland(island.id);
        } catch (e) {
          // Nothing was started, so the island on the server still matches what
          // is on screen. Say why and go back to it.
          setError(e instanceof Error ? e.message : t('player.regenerateFailed'));
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
          const message = t('player.stillBuildingShowsWhatServerHas');
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
        setError(e instanceof Error ? e.message : t('player.regenerateFailed'));
        setAttempt((n) => n + 1);
      }
    };
    await run().finally(() => setRegenerating(false));
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
  const echoFillStep = useRef<PassStep>('idle');
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
    // A position that is not a number would reach the sheet's percentage
    // width, and a NaN in a worklet ends Expo Go without a red box.
    if (!Number.isFinite(s.currentTime)) return;
    const end = lineEndOf(s.duration, breathSec);

    // Auto Echo's Listen fills to the spoken end, where Echo's pad takes over.
    // A ladder pass owns the pad too (it is the breath before the next pass),
    // so its fill runs the whole source instead.
    if (fillKindOf(step) === 'line') {
      const span = step === 'listen' ? end : s.duration;
      if (!s.playing || !Number.isFinite(span) || span <= 0) return;
      const target = Math.min(1, s.currentTime / span);
      if (echoFill.value === 0 || Math.abs(echoFill.value - target) > 0.08) {
        cancelAnimation(echoFill);
        echoFill.value = target;
        const remaining = Math.max(0, (span - s.currentTime) * 1000);
        echoFill.value = withTiming(1, { duration: remaining, easing: Easing.linear });
      }
      return;
    }

    if (fillKindOf(step) === 'pad') {
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
  // An effect event, so the effect below runs for the deps it lists and
  // reads everything else as of that render.
  const aimEchoStep = useEffectEvent(() => {
    if (echoFillStep.current !== echoStep) {
      echoFillStep.current = echoStep;
      cancelAnimation(echoFill);
      echoFill.value = 0;
    }

    const kind = fillKindOf(echoStep);
    if (kind === 'line' || kind === 'pad') {
      aimEchoLine(latestStatus.current);
      return;
    }

    if (kind === 'record') {
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

    // play: takeStatusHandler aims the fill from the take player's own
    // status updates, so nothing to do here.
    // idle, armed, done: nothing to animate. Armed holds at the 0 the step
    // change above just set (Speak has not started yet); done and idle show
    // through the sheet's static full/empty rule instead of this value.
  });
  useEffect(() => {
    aimEchoStep();
  }, [echoStep, lineEnd, breathSec, take.phase, takeLagMs]);

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
  }, [pendingPlay]);

  // Loads a new source into the one player, and starts it when a line switch
  // should keep playing (the native player begins once the item is ready).
  // Everything that used to reset with a new player resets here: the crossing,
  // the play count, the last tick and the highlight.
  // Under the open morph's cover the first load waits until the cover is gone
  // (a Play tap before that loads it at once, see playFromTop).
  // Loads this render's source if the player does not hold it yet. Safe to
  // call more than once. Declared before the effect that runs it so the
  // effect can list it (its identity never changes).
  const loadSource = useStableHandler(() => {
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
  });
  // A continuous run stops the player between plays: see setPendingPlay.
  // Under the open morph's cover the first load waits until the cover is gone
  // (a Play tap before that loads it at once, see playFromTop).
  useEffect(() => {
    if (!sourceUri || sourceUri === loadedUri.current) return;
    if (openCoverUp(id)) return afterCoverGone(id, loadSource);
    loadSource();
  }, [sourceUri, player, id, loadSource]);
  // The lines around the current one download in the background, so the next
  // line change (or a step back) loads a local file. It runs after the change
  // has committed, and a new line, speed or pause replaces what is still
  // queued. The phrase's own render is not fetched ahead: it is only ever
  // played for the line on screen.
  // A ladder waiting to start is warmed at its Listen speed too: that first
  // pass plays under the rung, which is a source none of the above covers, and
  // without it Start would wait on the network before the first sound. Every
  // line after the first is warmed by the Listen of the line before it, which
  // already runs at that speed.
  const warmLadderListen = programme === 'ladder' && !isActive(echoStep);
  useEffect(() => {
    if (!island || island.lines.length === 0) return;
    const t = setTimeout(() => {
      const n = island.lines.length;
      const order = [idx + 1, idx + 2, idx - 1, idx].map((i) => (i + n) % n);
      const version = `${island.speaker}-${generation}`;
      const items = [...new Set(order)].map((i) => {
        const l = island.lines[i]!;
        return { url: api.lineAudioUrl(island.id, l.idx, version, speed, breathMs), tag: l.ja };
      });
      const easy = passSpeed(speed, 'ladderListen');
      if (warmLadderListen && easy !== speed) {
        const l = island.lines[idx]!;
        items.unshift({
          url: api.lineAudioUrl(island.id, l.idx, version, easy, breathMs),
          tag: l.ja,
        });
      }
      prefetchLineAudio(items);
    }, 0);
    return () => clearTimeout(t);
  }, [island, idx, generation, speed, breathMs, warmLadderListen]);
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
    // A promise finally, not a try finally: the compiler does not lower those.
    const run = async () => {
      try {
        await Promise.race([
          player.seekTo(0),
          new Promise<void>((resolve) => {
            timer = setTimeout(resolve, SEEK_WAIT_MS);
          }),
        ]);
      } catch {
        // A seek can fail while the item is still loading; play anyway.
      }
    };
    await run().finally(() => clearTimeout(timer));
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

  // Lock screen / notification text. A hidden sentence never shows the
  // Japanese, whether Blind hid it or a ladder pass did.
  function lockMeta(): AudioMetadata {
    const pos = t('player.lineOfTotal', { index: idx + 1, total: island!.lines.length });
    const artist = island!.title || t('player.island');
    return hidden
      ? { title: pos, artist }
      : { title: phrase.label ?? line!.ja, artist, albumTitle: pos };
  }

  // The line player is the lock screen / notification's active player. It
  // lives as long as the screen, and releasing it on unmount clears the lock
  // screen on both platforms, so there is no explicit clear anywhere here.
  // Under the open morph's cover it waits until the cover is gone, and then
  // carries the metadata of that moment.
  const activateLockScreen = useStableHandler(() => {
    if (!lockScreen || !island || !line) return;
    player.setActiveForLockScreen(true, lockMeta(), { showSeekForward: false, showSeekBackward: false });
  });
  // Effect events: each effect runs for the deps it lists and reads the
  // rest as of that render.
  const activateOnCoverGone = useEffectEvent(() => {
    if (!lockScreen || !island || !line) return;
    return afterCoverGone(id, activateLockScreen);
  });
  useEffect(() => activateOnCoverGone(), [player, island?.id, generation]);

  const updateLockMeta = useEffectEvent(() => {
    if (!lockScreen || !island || !line || openCoverUp(id)) return;
    player.updateLockScreenMetadata(lockMeta());
  });
  useEffect(() => {
    updateLockMeta();
  }, [hidden, idx, island?.title, island?.lines.length, line?.ja, phrase.label]);

  // A take made with the phone in a pocket is not a take, and the microphone
  // must never run in the background: dropped as soon as the app backgrounds.
  // The line stops with it; nothing else about playback changes here. The
  // listener is subscribed once, so everything it calls is read through the
  // ref: the first render's dropTake would close over a take whose cancel()
  // still sees `recording` as false and leaves the microphone running.
  const backgroundRef = useRef({ take, player, dropTake, stopEcho, echoRef });
  useLayoutEffect(() => {
    backgroundRef.current = { take, player, dropTake, stopEcho, echoRef };
  });
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
      scheduleAudioSessionRelease();
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

  // A pass's speed is a different audio source, so a change lands the way a
  // speed commit does: stop, swap, and let the new source play once it has
  // loaded. The rung itself is never written here. Returns false when the
  // speed is already right and there is no swap to ride, and the caller plays
  // the line itself.
  function swapPassSpeed(next: number, play = true): boolean {
    if (next === speed) return false;
    dropTake();
    stopPlayback(player);
    setPlayWhenLoaded(play);
    resetForNewAudio();
    setSpeed(next);
    setSpeedLive(next);
    return true;
  }

  // The same line once more from the top: the source has not changed, so the
  // playWhenLoaded effect never fires and the seek and the play are by hand.
  function replayLine() {
    resetHighlight();
    setPendingPlay(true);
    void (async () => {
      await seekTop();
      // Stopped during the seek: the replay is cancelled.
      if (!pendingPlayRef.current) return;
      crossed.current = false;
      startPlayback(player);
    })();
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
  // An effect event: only the finish flag re-runs it; everything else is
  // read as of that render.
  const onLineFinish = useEffectEvent(() => {
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
      scheduleAudioSessionRelease();
      return;
    }
    const step = echoRef.current;
    const after = nextOnLineFinish(step, autoRecord);
    if (after !== step) {
      // The line's own finish, at the end of the pad, ends this pass (Auto
      // Echo's Listen runs straight to here when the pause is 0s).
      if (isSpeakStep(after)) {
        // Auto Record on opens the mic at once.
        void startSpeak();
        return;
      }
      if (isArmedStep(after)) {
        // Off, the Record button waits and the audio session goes back.
        setEchoStep(after);
        scheduleAudioSessionRelease();
        return;
      }
      if (isPlayStep(after)) {
        // Compare's line half done: the take answers it.
        setEchoStep(after);
        take.playTake();
        return;
      }
      setEchoStep(after);
      // Read along is the first pass at the island's own speed, so the swap
      // to it is what starts the line again; the other passes keep the speed
      // they had and replay by hand.
      const swapped = after === 'ladderRead' && swapPassSpeed(passSpeed(sessionBase.current, after));
      if (!swapped) replayLine();
      return;
    }
    // The rest of a pass never plays the line through to here.
    if (isActive(step)) return;
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
    applyLadderNext();
    setIdx((i) => (i + 1) % island.lines.length);
  });
  useEffect(() => {
    onLineFinish();
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
    setLadderMove(null);
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
    const word = line.words[i]!.text;
    // languages: JMdict only covers Japanese, so es and en skip straight to
    // the context line instead of a dictionary lookup.
    if (isJa) {
      try {
        const g = await api.gloss(word);
        setGlossData(g);
      } catch {
        setGlossData({ word, base: '', reading: '', entries: [], found: false });
      }
    } else {
      setGlossData({ word, base: '', reading: '', entries: [], found: false });
    }
    try {
      const ctx = await api.explainWord(word, line.ja, line.en, island?.language ?? 'ja', island?.native ?? 'en');
      if (wordRequestId.current === requestId) setExplainContext(ctx || null);
    } catch {
      if (wordRequestId.current === requestId) setExplainContext(null);
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
  useLayoutEffect(() => {
    live.current = liveNow;
  });
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
  // Blind mode's only gesture on the sentence is the reveal drag: no word
  // taps, no selection and no swipes while it is frosted.
  const { sentenceGesture } = useMemo(() => {
    const pan = Gesture.Pan()
      .activateAfterLongPress(450)
      .runOnJS(true)
      .onStart((e) => {
        const l = live.current;
        const i = l.hitTest(e.x, e.y);
        if (i === null) return;
        l.closePanel();
        anchorWord.current = i;
        setDragSpan(spanUpdate(i, i));
      })
      .onUpdate((e) => {
        const i = live.current.hitTest(e.x, e.y);
        if (i === null) return;
        const a = anchorWord.current;
        setDragSpan(spanUpdate(Math.min(a, i), Math.max(a, i)));
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
    return { sentenceGesture: Gesture.Exclusive(pan, swipe, tap) };
  }, [dragY]);
  const jaReveal = useSlideReveal(blind, scrollRef);
  const enReveal = useSlideReveal(!englishShown, scrollRef);
  // Follows dragY while a swipe drags the card, with a slight scale down so
  // it reads as lifting off the waterline rather than just sliding.
  const cardDragStyle = useAnimatedStyle(() => ({
    transform: [
      { translateY: dragY.value },
      { scale: interpolate(Math.abs(dragY.value), [0, DRAG_LIMIT], [1, 0.99], Extrapolation.CLAMP) },
    ],
  }));
  // The scene fades and rises 10pt into place as the screen opens, before the
  // island has loaded (TideScene fades the lines in when they land). A
  // style driven from here, not a layout `entering` animation: the wrapper
  // holds the Skia water and nested entering views, and mounting all of that
  // under a layout animation during the push is the likeliest cause of the
  // native crash on open.
  const sceneShown = (!island || !!line) && !regenerating && !revoicing;
  const sceneIn = useSharedValue(0);
  useEffect(() => {
    if (!sceneShown) {
      cancelAnimation(sceneIn);
      sceneIn.value = 0;
      return;
    }
    if (openCoverUp(id)) {
      cancelAnimation(sceneIn);
      sceneIn.value = 1;
      return;
    }
    sceneIn.value = withTiming(1, { duration: reducedMotion ? 200 : 220 });
  }, [sceneShown, reducedMotion, sceneIn]);
  const sceneInStyle = useAnimatedStyle(() => ({
    opacity: sceneIn.value,
    transform: [{ translateY: reducedMotion ? 0 : (1 - sceneIn.value) * 10 }],
  }));
  // The sentence card, transcript rows, toolbar and bottom row. Opened by the
  // card morph they stay hidden under its cover and rise in one after another
  // from the frame it lands (or from when the lines arrive, if later).
  // Anywhere else, and under reduced motion, they fade in together. Styles,
  // not `entering` animations, as above.
  // The root LoadingOverlay in the gap between the morph landing (or the
  // mount, off the morph path) and the lines arriving. While a morph still
  // covers the screen it does nothing: the morph's cover-complete worklet
  // asks for the loader if the player was not ready by then. Once landed, a
  // wait asks for it (the overlay's own grace delays the cat) and anything
  // else clears it.
  const waitingForLines = !island && !error;
  useEffect(() => {
    // Under a covering morph only the clear is sent: its landing worklet asks
    // for the loader if the player still waits then.
    // A morph that lands on its timer before ready clears the loader as it
    // ends, so a wait still going then asks for it again.
    if (waitingForLines && openCoverUp(id)) return afterCoverGone(id, () => requestLoader(true));
    requestLoader(waitingForLines);
  }, [id, waitingForLines]);
  useEffect(() => () => requestLoader(false), []);

  const contentReveal = useContentReveal({
    ready: !!line,
    coveredAtMount,
    staged: morph === '1' && !reducedMotion,
  });
  const revealValues = contentReveal.values;
  const toolbarInStyle = usePieceStyle(revealValues.toolbar, revealValues.rise);
  const bottomInStyle = usePieceStyle(revealValues.dock, revealValues.rise);
  const dockBackdropStyle = useAnimatedStyle(() => ({
    opacity: Number.isFinite(revealValues.toolbar.value) ? revealValues.toolbar.value : 1,
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
    setDragSpan(spanUpdate(Math.min(f, i), Math.max(f, i)));
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

  // The drag selection's popup Copy button: the same surface text Explain
  // marks, joined with no separator, to the clipboard. Unlike Repeat and
  // Explain this leaves the selection in place, so the learner can copy more
  // than once or still hit Repeat or Explain after.
  function copySelection() {
    const span = dragSpan;
    if (!span || !line) return;
    const text = line.words
      .slice(span.from, span.to + 1)
      .map((w) => w.text)
      .join('');
    void Clipboard.setStringAsync(text);
    void hapticImpact();
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

  // A ladder decision lands here, at a line change, never under a playing
  // line: swapping `speed` mid-line would cut the audio and desync the word
  // marks and Auto Echo.
  function applyLadderNext() {
    if (ladderNext.current === null) return;
    setSpeed(ladderNext.current);
    setSpeedLive(ladderNext.current);
    ladderNext.current = null;
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
    applyLadderNext();
    setIdx(clamped);
  }
  const next = () => go(idx + 1);
  const prev = () => go(idx - 1);

  // Starts the line fresh from the top, whether or not it was already
  // playing: shared by the ring's Play tap and a swipe down on the sentence.
  async function playFromTop() {
    // The source may still be waiting for the open morph's cover to go.
    loadSource();
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
    scheduleAudioSessionRelease();
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
    setEnglishShown((v) => !v);
  }

  // Times is not part of the audio: the line playing carries on, and the
  // next finish counts against the new value.
  function pickTimes(next: number) {
    timesTouched.current = true;
    setTimes(Math.min(TIMES_MAX, next));
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
    ladderEpoch.current += 1;
    ladderNext.current = null;
    setLadderMove(null);
    if (island) void setRungSpeed(island.id, next);
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
  // timer in useTake instead of the line's end. `'auto'` (Speak) probes the
  // input route once the recorder starts and resolves to whichever the
  // headset check decides.
  async function beginRecording(mode: TakeMode, silent: boolean | 'auto' = false): Promise<{ silent: boolean } | null> {
    if (!line || startingTake.current) return null;
    startingTake.current = true;
    // A promise finally, not a try finally: the compiler does not lower those.
    const run = async () => {
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
      const result = await take.startTake(lineEnd || undefined, speed, mode, takeLagMs, span, silent);
      if (!result) return null;
      crossed.current = false;
      if (!result.silent) startPlayback(player);
      return result;
    };
    return run().finally(() => {
      startingTake.current = false;
    });
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
  const markTakeLineStartNow = useEffectEvent(() => {
    markTakeLineStart(latestStatus.current);
  });
  useEffect(() => {
    markTakeLineStartNow();
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
  const calibrateOnLoaded = useEffectEvent(() => {
    if (!calibrateWhenLoaded.current || !sourceUri) return;
    calibrateWhenLoaded.current = false;
    void beginRecording('calibrate');
  });
  useEffect(() => {
    calibrateOnLoaded();
  }, [sourceUri]);

  // The Speak step's take: with a headset mic as the input it opens the mic
  // with the line playing under it, exactly like Record my take, so the
  // recording is scored and cleaned the same way. On the speaker the line
  // stays silent and the take is neither cleaned nor scored (see useTake's
  // `silent`). `speakStartedAt` marks the moment so the take-saved effect
  // below only reacts to a take from this pass, not a stale or cancelled one.
  async function startSpeak() {
    // A second tap while the mic is still opening: the first start carries
    // on, and beginRecording would refuse this one anyway.
    if (startingTake.current) return;
    speakStartedAt.current = Date.now();
    setSpeakStopped(false);
    setEchoStep(speakStepOf(programme));
    setEchoResult(null);
    const started = await beginRecording('take', 'auto');
    if (!started) {
      setEchoStep('idle');
      return;
    }
    speakSilent.current = started.silent;
    // The sheet closed (or the app went to the background) while the mic was
    // opening: stopEcho found nothing to cancel yet, so drop this take now.
    if (!isSpeakStep(echoRef.current)) {
      stopPlayback(player);
      void take.cancel();
    }
  }

  // Moves the loop on to the next line (or restarts the only line an island
  // has) after a Play step finishes, and starts its Listen step.
  async function advanceEcho() {
    if (!island) return;
    if (echoRef.current === 'ladderPlay') {
      // The ladder walks the island once and stops at its end: no wrap.
      if (idx >= island.lines.length - 1) {
        setEchoStep('done');
        return;
      }
      // A pending rung decision lands at this line change, so the next line's
      // passes are placed relative to the rung it moves to.
      const base = ladderNext.current ?? speed;
      sessionBase.current = base;
      go(idx + 1);
      // go() reads status.playing, which is false here (the take was the
      // thing playing), so the new line has to be told to play.
      setPlayWhenLoaded(true);
      const easy = passSpeed(base, 'ladderListen');
      if (easy !== base) {
        setSpeed(easy);
        setSpeedLive(easy);
      }
      setEchoStep('ladderListen');
      return;
    }
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

  // Starts (or restarts) the run on the current line: a whole-line phrase
  // selection goes first, so every pass hears the same line.
  function startEcho() {
    // Clearing a held phrase swaps the whole line back in, and that load is
    // what starts it playing: nothing below may play on top of it.
    const hadPhrase = !!phrase.span;
    clearPhrase();
    if (hadPhrase) setPlayWhenLoaded(true);
    sessionLadder.current = programme === 'ladder';
    if (programme === 'echo') {
      setEchoStep('listen');
      if (!hadPhrase) void playFromTop();
      return;
    }
    sessionBase.current = speed;
    setEchoStep('ladderListen');
    // Listen plays under the island's speed, which is a different source, and
    // that swap carries the play. With the rung already at the floor there is
    // no swap, so the line starts here instead, from the top, which also stops
    // a line that was already playing rather than doubling it.
    const swapped = swapPassSpeed(passSpeed(speed, 'ladderListen'));
    if (!swapped && !hadPhrase) void playFromTop();
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
    // The step being left is `done` after the last pass, which does not say
    // which programme ran, so the restore reads the session's own flag.
    const wasLadder = sessionLadder.current;
    sessionLadder.current = false;
    setEchoStep('idle');
    setEchoResult(null);
    setPlayWhenLoaded(false);
    dropTake();
    stopPlayback(player);
    void player.seekTo(0);
    scheduleAudioSessionRelease();
    // A pass left in the middle hands the island's own speed back, silently.
    if (wasLadder) swapPassSpeed(sessionBase.current, false);
  }

  // The Speak step's take, once saved and its player loaded, starts the Play
  // step. `recordedAt` has to be newer than when this pass's Speak began: a
  // Retry's cancel flickers `phase` back to 'ready' with the take it is about
  // to replace, and a line switched away and back still carries its own old
  // take, and neither should be mistaken for the one just recorded. It also
  // waits out the echo cleanup: the cleaned file landing swaps the take
  // player, which would cut a take already playing off mid-word.
  const playSavedTake = useEffectEvent(() => {
    const after = afterTakeSaved(echoRef.current);
    if (
      after !== echoRef.current &&
      take.phase === 'ready' &&
      take.clean.state !== 'working' &&
      take.takeLoaded &&
      take.take &&
      take.take.recordedAt > speakStartedAt.current
    ) {
      setEchoStep(after);
      // Auto Echo plays the take straight back; the ladder's Compare plays the
      // line first and the take answers it at that line's finish.
      if (isPlayStep(after)) take.playTake();
      else replayLine();
    }
  });
  useEffect(() => {
    playSavedTake();
  }, [take.phase, take.take?.recordedAt, take.takeLoaded, take.clean.state]);

  // Feeds a freshly scored take to the island's rung. `ladderSeenAt` keeps a
  // take recorded before this visit, or a line switched away and back, from
  // being scored twice. A move is only written to `ladderNext`, not the
  // audio: it lands at the next line change (see `applyLadderNext`).
  const ladderDecision = useEffectEvent(() => {
    if (!island || take.phase !== 'ready') return;
    const recordedAt = take.take?.recordedAt;
    if (!recordedAt || recordedAt <= ladderSeenAt.current) return;
    const keptUp = wordsKeptUp(take.take?.score ?? null);
    if (!keptUp) return;
    ladderSeenAt.current = recordedAt;
    // A decision is already waiting for the next line change, so this take
    // was spoken at the speed the ladder is stepping away from. Pooling it
    // into the rung it is stepping to would let the next decision skip a
    // rung (0.50 straight to 0.60), so count it as seen and drop it.
    if (ladderNext.current !== null) return;
    const epoch = ladderEpoch.current;
    // The rung this take belongs to, which is also the rung to create when the
    // island has none yet (the device default may be something else entirely).
    // Outside a ladder run that is what the player is playing. Inside one it is
    // the session's base: Listen and Mumble play under the rung, and a score
    // can land after the run has moved on to the next line's Listen, which
    // would otherwise create the rung 0.15 too low.
    const rung = sessionLadder.current ? sessionBase.current : speed;
    void recordTake(island.id, rung, keptUp).then(({ moved, speed: next }) => {
      if (ladderEpoch.current !== epoch || !moved) return;
      ladderNext.current = next;
      setLadderMove({ dir: moved, speed: next });
    });
  });
  useEffect(() => {
    ladderDecision();
  }, [take.phase, take.take?.recordedAt, take.take?.score]);

  // The Play step's take finishing on its own is a stop point: Android gives
  // audio focus back by itself when the take player stops; on iOS the duck
  // lasts as long as the session is active, so a scheduled release hands
  // the volume back a few seconds after this.
  useEffect(() => {
    if (wasTakePlaying.current && !take.takePlaying && !status.playing) {
      scheduleAudioSessionRelease();
    }
    wasTakePlaying.current = take.takePlaying;
  }, [take.takePlaying, status.playing]);

  // The Play step's take finishing on its own moves the loop on: Auto Echo on
  // advances to the next line (wrapping like the player does), off ends the
  // pass at Pass complete.
  const onEchoTakeStopped = useEffectEvent(() => {
    if (wasEchoTakePlaying.current && !take.takePlaying && isPlayStep(echoRef.current)) {
      const expectedSec =
        speakSilent.current && lineEnd > 0 ? lineEnd + (TAIL_MS + takeLagMs) / 1000 : lineEnd;
      const tier = resultTier(take.take?.score ?? null, take.takeDuration, expectedSec);
      setEchoResult({ id: Date.now(), tier });
      // A Compare played back is one sentence ladder finished, which is what
      // a day on the streak counts.
      if (echoRef.current === 'ladderPlay' && island) addLadder(island.id);
      if (autoEcho) {
        advanceHoldRef.current = setTimeout(() => {
          advanceHoldRef.current = null;
          // The toggle turned off during the hold: end the run instead.
          if (!autoEchoRef.current) {
            setEchoStep(afterTakePlayed(echoRef.current, false));
            return;
          }
          void advanceEcho();
        }, ECHO_RESULT_HOLD_MS);
      } else {
        setEchoStep('done');
      }
    }
    wasEchoTakePlaying.current = take.takePlaying;
  });
  useEffect(() => {
    onEchoTakeStopped();
  }, [take.takePlaying]);

  // The word player finishing on its own is also a stop point: Hear it never
  // loops, so once it stops (and the line is not playing) nothing of ours
  // should still be making sound.
  const wasWordPlaying = useRef(false);
  useEffect(() => {
    if (wasWordPlaying.current && !wordStatus.playing && !status.playing) scheduleAudioSessionRelease();
    wasWordPlaying.current = wordStatus.playing;
  }, [wordStatus.playing, status.playing]);

  function openIslandMenu() {
    // The header `…` also shows while the island loads, where there is no
    // sheet to open yet. Without this guard, a tap there sets `sheet` to
    // 'island' and the menu pops open once the island lands.
    if (!line || regenerating || revoicing) return;
    setSheet('island');
  }

  function confirmDelete() {
    if (!island) return;
    Alert.alert(
      t('player.deleteIslandTitle', { title: island.title || t('player.untitledIsland') }),
      t('player.deleteIslandBody'),
      [
        { text: t('common.cancel'), style: 'cancel' },
        { text: t('common.delete'), style: 'destructive', onPress: () => void removeIsland() },
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
      invalidateCachedIsland(island.id);
      deleteTakes(island.id);
      forgetRung(island.id);
      void releaseAudioSession();
      plainBack();
    } catch (e) {
      Alert.alert(t('player.couldNotDelete'), e instanceof Error ? e.message : t('player.serverDidNotAnswer'));
    }
  }

  // Above the dock: Speed, Repeat, Reading and Blind, each opening its own
  // popover. Opening one closes the others, and never touches playback.
  const toolbarItems = useMemo((): ToolbarItem[] => {
    const repeatOn = times > 1 || pauseMs > 0;
    // Lit when this island plays at something other than the person's own
    // default, not other than 1×: the default is 0.5 on a fresh install, which
    // would otherwise light the tile on every island.
    const speedOn = Math.abs(speedLive - getSettingsSync().defaultSpeed) > 0.001;
    const readingOn = readingMode !== 'off';
    // languages: typed here (not just the useMemo return) so the array
    // literal below keeps its contextual typing once .filter() is chained.
    const items: ToolbarItem[] = [
      {
        key: 'speed',
        icon: <SpeedIcon color={speedOn ? verb.listen.c1 : tide.textDim} size={22} />, // prism-player-buttons: verb listen tint
        label: t('player.toolbarSpeed'),
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
          const old = speedTile.current;
          speedTile.current = { x, y, width };
          anchorMoved(!old || old.x !== x || old.y !== y || old.width !== width);
        },
      },
      {
        key: 'repeat',
        icon: <RepeatIcon color={repeatOn ? verb.listen.c1 : tide.textDim} size={22} />, // prism-player-buttons: verb listen tint
        label: t('player.toolbarRepeat'),
        value: repeatTileLabel(t, times, pauseMs),
        active: repeatOn,
        onPress: () => {
          setSpeedPopOpen(false);
          setReadingPopOpen(false);
          setBlindPopOpen(false);
          setRepeatPopOpen((v) => !v);
        },
        onLayout: (e) => {
          const { x, y, width } = e.nativeEvent.layout;
          const old = repeatTile.current;
          repeatTile.current = { x, y, width };
          anchorMoved(!old || old.x !== x || old.y !== y || old.width !== width);
        },
      },
      {
        key: 'reading',
        icon: <ReadingIcon color={readingOn ? verb.listen.c1 : tide.textDim} size={22} />, // prism-player-buttons: verb listen tint
        label: t('player.toolbarReading'),
        value: t(READING_LABEL_KEY[readingMode]),
        active: readingOn,
        onPress: () => {
          setSpeedPopOpen(false);
          setRepeatPopOpen(false);
          setBlindPopOpen(false);
          setReadingPopOpen((v) => !v);
        },
        onLayout: (e) => {
          const { x, y, width } = e.nativeEvent.layout;
          const old = readingTile.current;
          readingTile.current = { x, y, width };
          anchorMoved(!old || old.x !== x || old.y !== y || old.width !== width);
        },
      },
      {
        key: 'blind',
        icon: <BlindIcon color={blind || !englishShown ? verb.listen.c1 : tide.textDim} size={22} />, // prism-player-buttons: verb listen tint
        label: t('player.toolbarBlind'),
        value:
          blind && !englishShown
            ? t('player.blindBoth')
            : blind
              ? LANG_CODE[island?.language ?? 'ja']
              : !englishShown
                ? LANG_CODE[island?.native ?? 'en']
                : t('player.blindOff'),
        active: blind || !englishShown,
        onPress: () => {
          setSpeedPopOpen(false);
          setReadingPopOpen(false);
          setRepeatPopOpen(false);
          setBlindPopOpen((v) => !v);
        },
        onLayout: (e) => {
          const { x, y, width } = e.nativeEvent.layout;
          const old = blindTile.current;
          blindTile.current = { x, y, width };
          anchorMoved(!old || old.x !== x || old.y !== y || old.width !== width);
        },
      },
    ];
    // languages: reading modes (furigana, kana, romaji) only exist for Japanese.
    return items.filter((item) => isJa || item.key !== 'reading');
  }, [t, speedLive, times, pauseMs, readingMode, blind, englishShown, anchorMoved, isJa, island]);

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
  // The three sheets and the header are memoised; these keep their handler
  // props at one identity so a screen render does not render a closed sheet.
  const onEchoClose = useStableHandler(() => {
    stopEcho();
    setSheet(null);
  });
  const onEchoRecord = useStableHandler(() => void startSpeak());
  const onEchoStop = useStableHandler(() => {
    // Before the mic is open there is nothing to stop yet.
    if (take.phase !== 'recording') return;
    setSpeakStopped(true);
    stopPlayback(player);
    void player.seekTo(0);
    take.finishNow();
  });
  const onEchoRetry = useStableHandler(() => void startSpeak());
  const onEchoStart = useStableHandler(startEcho);
  const onToggleAutoEchoStable = useStableHandler(toggleAutoEcho);
  const onToggleAutoRecordStable = useStableHandler(toggleAutoRecord);
  const onSheetDismissed = useStableHandler(runAfterSheet);
  const onMenuClose = useStableHandler(() => setSheet(null));
  const onMenuRename = useStableHandler((t: string) => closeSheetThen(() => void renameTitle(t)));
  const onMenuExport = useStableHandler(() => closeSheetThen(() => void exportNow()));
  const onMenuRevoice = useStableHandler(() => closeSheetThen(() => void doRevoice()));
  const onMenuRegenerate = useStableHandler(() => closeSheetThen(confirmRegenerate));
  const onMenuCalibrate = useStableHandler(() => closeSheetThen(() => void calibrateSpeaker()));
  const onMenuDelete = useStableHandler(() => closeSheetThen(confirmDelete));
  const onExplainClose = useStableHandler(closeExplain);
  const onExplainPlay = useStableHandler(() => void playFromTop());
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
  // How many of the last ready take's scoreable words were kept up with,
  // hidden until there is something to count.
  const keptUp = take.phase === 'ready' ? wordsKeptUp(take.take?.score ?? null) : null;
  // The pending ladder move, while it is still pending. It outlives the take
  // that earned it: discarding or retrying that take clears `keptUp`, but the
  // move still lands at the next line change, so its sentence has to stay up
  // to explain the speed that is about to change.
  const ladderNote = ladderMove && ladderMove.speed !== speed ? ladderMove : null;
  // The last ready take's mora feedback (length and pitch), same gate as marks.
  const feedback = take.phase === 'ready' ? (take.take?.analysis ?? null) : null;
  // Under the sentence: the kana or romaji line by mode, nothing in Furigana
  // mode (the reading is on the kanji). Pitch is drawn over the words
  // themselves, in every mode.
  const modeLine = useMemo(
    () =>
      // languages: es and en have no reading mode; the tile that sets it is
      // already gone from the dock, but a saved kana/romaji pick from an
      // earlier Japanese island must not leak in here.
      !line || !isJa
        ? null
        : readingMode === 'kana'
          ? line.timeline.map((m) => m.kana).join('')
          : readingMode === 'romaji'
            ? lineRomajiText
            : null,
    [line, readingMode, lineRomajiText, isJa],
  );
  const pitches = isJa && pitch ? linePitches : null;

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
  const onCopySelection = useStableHandler(copySelection);
  const onBlockLayout = useCallback((e: LayoutChangeEvent) => setBlockWidth(e.nativeEvent.layout.width), []);
  const onBlockTouch = useCallback(() => {
    blockTouched.current = true;
  }, []);
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
    if (!line) {
      return null;
    }
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

    // Chunks for the wordless fallback's per-character reveal and the
    // English strip's per-word reveal.
    const jaChars = Array.from(line.ja);
    const enWords = line.en ? line.en.split(' ') : [];

    // The sentence sits on the waterline: the tappable block when words are
    // known, the fallback line when they are not, then the reading row and the
    // English strip, all inside one card. Blind keeps all of it in place and
    // frosts the Japanese; dragging a finger across it sharpens whichever
    // words sit under the touch, live, so a line change mid-drag (the island
    // moving on) shows the new line's word under the finger sharp right away.
    // The gesture sits outside the Frost because the frosted copy takes no
    // touches; the Frost adds no offset, so the gesture's coordinates still
    // match the word boxes.
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
              <GestureDetector gesture={blind ? jaReveal.gesture : sentenceGesture}>
                <View collapsable={false}>
                  {hidden ? (
                    <SlideReveal
                      finger={jaReveal.finger}
                      count={line.words.length}
                      rowStyle={styles.words}
                      blur={4.5}
                      renderChunk={(i, sharp) => (
                        <RubyWord
                          key={i}
                          word={line.words[i]!}
                          showRuby={isJa && readingMode === 'furigana'}
                          showPosAndRomaji={isJa}
                          index={i}
                          highlight={highlight}
                          concealed={!sharp}
                          selected={false}
                          dimmed={!!phrase.span && (i < phrase.span.from || i > phrase.span.to)}
                          mark={marks && marks[i] !== 'ok' && marks[i] !== 'none' ? marks[i] : null}
                          pitch={pitches?.[i]}
                          onLayout={noopLayout}
                        />
                      )}
                    />
                  ) : (
                    <>
                      <View style={styles.words}>
                        {line.words.map((w, i) => (
                          <RubyWord
                            key={i}
                            word={w}
                            showRuby={isJa && readingMode === 'furigana'}
                            showPosAndRomaji={isJa}
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
                      <WordOutline highlight={highlight} boxes={wordBoxesUI} />
                    </>
                  )}
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
                  romaji={isJa && readingMode === 'romaji'}
                  dictionary={isJa}
                  onHear={onHearWord}
                  onClose={onClosePanel}
                />
              ) : null}
              {dragSpan && dragUnion && !handleDragging ? (
                <SelectionPopup
                  left={dragPopLeft}
                  top={dragPopTop}
                  onRepeat={onRepeatSelection}
                  onExplain={onOpenExplain}
                  onCopy={onCopySelection}
                />
              ) : null}
            </View>
          </>
        ) : (
          <GestureDetector gesture={jaReveal.gesture}>
            <View collapsable={false}>
              {hidden ? (
                <SlideReveal
                  finger={jaReveal.finger}
                  count={jaChars.length}
                  rowStyle={styles.words}
                  blur={4.5}
                  renderChunk={(i) => (
                    <Text key={i} style={styles.ja}>
                      {jaChars[i]}
                    </Text>
                  )}
                />
              ) : (
                <Text style={styles.ja}>{line.ja}</Text>
              )}
            </View>
          </GestureDetector>
        )}

        {modeLine !== null ? (
          <Frost frosted={hidden} ink={tide.textDim}>
            <Text style={styles.reading}>{modeLine}</Text>
          </Frost>
        ) : null}

        {/* languages: mora feedback only exists for Japanese timelines. */}
        {isJa && feedback && !hidden ? <TakeFeedback moras={line.timeline} analysis={feedback} /> : null}

        {keptUp !== null || ladderNote ? (
          <Text
            style={[
              styles.keptUp,
              ladderNote ? { color: ladderNote.dir === 'up' ? tide.listen : tide.text } : null,
            ]}
          >
            {keptUp !== null ? t('player.keptUpWords', { kept: keptUp.kept, total: keptUp.total }) : ''}
            {ladderNote
              ? `${keptUp !== null ? ' · ' : ''}${t(ladderNote.dir === 'up' ? 'player.ladderUp' : 'player.ladderDown', { speed: speedLabel(ladderNote.speed) })}`
              : ''}
          </Text>
        ) : null}

        {/* The English in its own inset strip at the foot of the card. Blind
            frosts it; dragging a finger across the words sharpens whichever
            ones sit under it and the rest frost again once the finger lifts.
            The Pressable stays outermost (its padding would otherwise offset
            the gesture's x/y from the word boxes, which measure from the
            content inside that padding) and the strip sits above the card's
            tap-to-play fill, so a press here never plays. */}
        {line.en ? (
          <Pressable style={styles.enStrip} accessibilityLabel={englishShown ? line.en : t('player.translationHidden')}>
            <GestureDetector gesture={enReveal.gesture}>
              <View collapsable={false}>
                {enFrosted ? (
                  <SlideReveal
                    finger={enReveal.finger}
                    count={enWords.length}
                    // languages: a Hebrew translation reveals right to left,
                    // so wrapping still fills each row starting from the right.
                    rowStyle={isRtl ? [styles.words, { flexDirection: 'row-reverse' as const }] : styles.words}
                    ink={tide.textDim}
                    blur={3.5}
                    renderChunk={(i) => (
                      <Text key={i} style={[styles.en, isRtl && styles.enRtl]}>
                        {enWords[i]}
                        {i < enWords.length - 1 ? ' ' : ''}
                      </Text>
                    )}
                  />
                ) : (
                  <Text style={[styles.en, isRtl && styles.enRtl]}>{line.en}</Text>
                )}
              </View>
            </GestureDetector>
          </Pressable>
        ) : null}
      </Animated.View>
    );
  }, [
    t,
    line,
    blind,
    hidden,
    readingMode,
    isJa,
    isRtl,
    highlight,
    selected,
    dragSpan,
    phrase.span,
    marks,
    keptUp,
    ladderNote,
    feedback,
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
    jaReveal,
    enReveal,
    // Stable for the screen's life: handlers from useStableHandler or an
    // empty useCallback, and a shared value.
    onBlockLayout,
    onBlockTouch,
    onClosePanel,
    onCopySelection,
    onDragHandle,
    onGrabHandle,
    onHearWord,
    onOpenExplain,
    onReleaseHandle,
    onRepeatSelection,
    onTapEmpty,
    onWordLayout,
    wordBoxesUI,
  ]);

  // Leaves without the card morph. A route opened by the morph does not
  // animate on its own, so it gets its fade back first, or the pop is a cut.
  function plainBack() {
    if (morph !== '1') {
      router.back();
      return;
    }
    navigation.setOptions({ animation: 'fade' });
    requestAnimationFrame(() => router.back());
  }
  // Set once a back has begun fading the content out, so a second tap does
  // not start another; cleared if the screen stays (the back fell through).
  const leavingRef = useRef(false);
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);
  // Runs once the content has faded out: the overlay covers the player, pops
  // it, and shrinks into the card.
  const beginMorphBack = useStableHandler(() => {
    // Gone meanwhile (a swipe back).
    if (!mountedRef.current) return;
    // Still mounted but no longer on top: stay as it was.
    if (!navigation.isFocused()) {
      leavingRef.current = false;
      contentReveal.show();
      return;
    }
    // The same `…` slot rule as the header calls below.
    const menu = island ? !!line && !regenerating && !revoicing : !error;
    const chrome = {
      title: headerTitleText,
      lineIndex: headerLineIndex,
      lineCount: headerLineCount,
      placeholder: !island && !error,
      menu,
    };
    if (startBack(id, () => router.back(), chrome)) return;
    plainBack();
  });
  const onHeaderBack = useStableHandler(() => {
    // A morph already running, or a back already fading out, owns the navigation.
    if (morphActive() || leavingRef.current) return;
    if (!canStartBack(id)) {
      plainBack();
      return;
    }
    leavingRef.current = true;
    // Without lines on screen there is no content to fade first.
    if (!line) beginMorphBack();
    else contentReveal.hide(beginMorphBack);
  });
  const onHeaderMenu = useStableHandler(openIslandMenu);
  const headerTitleText = island?.title || openedTitle(id) || t('player.island');
  // Before the island loads, the line row Home opened the card with, so the
  // header matches the morph's flying copy of it.
  const homeLine = island ? undefined : openedLine(id);
  const headerLineCount = island?.lines.length ?? homeLine?.lineCount ?? 0;
  const headerLineIndex = island ? idx : (homeLine?.lineIndex ?? 0);
  const header = (withMenu: boolean) => (
    <PlayerHeader
      id={id}
      title={headerTitleText}
      lineIndex={headerLineIndex}
      lineCount={headerLineCount}
      placeholder={!island && !error}
      background={sky.top}
      onBack={onHeaderBack}
      onMenu={withMenu ? onHeaderMenu : null}
    />
  );

  // Where the scene ends above the dock. Before the island loads there is no
  // dock yet, so a spacer of the last dock height holds its place: the
  // waterline sits where it will once the lines land. The loading cat, if a
  // wait is real, is the root LoadingOverlay: nothing to render here.
  const dockSpace = dockH > 0 ? dockH : lastDockH;

  if (error && !island) {
    return (
      <SafeAreaView edges={['bottom']} style={StyleSheet.flatten([styles.fill, { backgroundColor: sky.top }])}>
        {header(false)}
        <View style={[styles.fill, styles.center]}>
          <Text style={[styles.body, { color: tide.record }]}>{error}</Text>
          {/* icon-buttons: Retry */}
          <View style={{ alignItems: 'center' }}>
            <PrismButton
              shape="round"
              size={prism.sizes.roundSm}
              verb="tools"
              onPress={() => setAttempt((n) => n + 1)}
              accessibilityLabel={t('player.retryLabel')}>
              <SymbolView name={{ ios: 'arrow.clockwise', android: 'refresh' }} size={16} weight="regular" tintColor={verb.tools.c1} />
            </PrismButton>
            <Text style={{ fontFamily: fonts.ui, fontSize: 11, color: tide.textDim, marginTop: 4, textAlign: 'center' }}>{t('player.retryLabel')}</Text>
          </View>
        </View>
      </SafeAreaView>
    );
  }
  if (!island) {
    // No loading view: the scene opens at once with the same tree the player
    // below renders, so nothing remounts when the island lands and TideScene
    // fades its lines in.
    return (
      <SafeAreaView edges={['bottom']} style={StyleSheet.flatten([styles.fill, { backgroundColor: sky.top }])}>
        <StatusBar style="light" />
        {header(true)}

        <Animated.View
          style={[styles.fill, sceneInStyle]}
          onLayout={(e) => {
            const w = e.nativeEvent.layout.width;
            anchorMoved(w !== playerW.current);
            playerW.current = w;
          }}>
          <TideScene
            lineIndex={0}
            lineCount={0}
            lines={lines}
            blind={hidden}
            busy={false}
            countdown={null}
            banner={banner}
            sentence={null}
            scrollRef={scrollRef}
            onLineTap={onLineTap}
            instantReveal={coverUpNow}
            widenWhen={coveredAtMount ? widenTranscript : undefined}
            contentReveal={revealValues}
            initialHeight={Math.max(0, sceneEstimateH - dockSpace)}
          />
          <View pointerEvents="none" style={{ height: dockSpace }} />
        </Animated.View>
      </SafeAreaView>
    );
  }
  if (!line) {
    // Still building, failed, or interrupted with nothing left: never a
    // silent spinner. Offer the way out.
    const busy = island.status === 'pending' || island.status === 'working';
    return (
      <SafeAreaView edges={['bottom']} style={StyleSheet.flatten([styles.fill, { backgroundColor: sky.top }])}>
        {header(false)}
        <View style={[styles.fill, styles.center]}>
          {busy ? (
            <CatConstellation label={t('player.stillBuildingThisIsland')} />
          ) : (
            <Text style={[styles.body, { color: tide.record }]}>
              {api.islandErrorText(island)}
            </Text>
          )}
          {!busy ? (
            // icon-buttons: Regenerate
            <View style={{ alignItems: 'center' }}>
              <PrismButton
                shape="round"
                size={prism.sizes.roundSm}
                verb="read"
                onPress={async () => {
                  try {
                    await api.regenerate(island.id, island.complexity);
                    invalidateLineAudio(island.id);
                    invalidateCachedIsland(island.id);
                    deleteTakes(island.id);
                    setAttempt((n) => n + 1);
                  } catch (e) {
                    setError(e instanceof Error ? e.message : t('player.couldNotRegenerate'));
                  }
                }}
                accessibilityLabel={t('player.regenerateLabel')}>
                <SymbolView name={{ ios: 'sparkles', android: 'auto_awesome' }} size={16} weight="regular" tintColor={verb.read.c1} />
              </PrismButton>
              <Text style={{ fontFamily: fonts.ui, fontSize: 11, color: tide.textDim, marginTop: 4, textAlign: 'center' }}>{t('player.regenerateLabel')}</Text>
            </View>
          ) : (
            // icon-buttons: Refresh
            <View style={{ alignItems: 'center' }}>
              <PrismButton
                shape="round"
                size={prism.sizes.roundSm}
                verb="tools"
                onPress={() => setAttempt((n) => n + 1)}
                accessibilityLabel={t('player.refreshLabel')}>
                <SymbolView name={{ ios: 'arrow.clockwise', android: 'refresh' }} size={16} weight="regular" tintColor={verb.tools.c1} />
              </PrismButton>
              <Text style={{ fontFamily: fonts.ui, fontSize: 11, color: tide.textDim, marginTop: 4, textAlign: 'center' }}>{t('player.refreshLabel')}</Text>
            </View>
          )}
        </View>
      </SafeAreaView>
    );
  }

  if (regenerating || revoicing) {
    return (
      <SafeAreaView edges={['bottom']} style={StyleSheet.flatten([styles.fill, { backgroundColor: sky.top }])}>
        {header(false)}
        <View style={[styles.fill, styles.center]}>
          <CatConstellation
            label={
              revoicing ? t('player.reVoicing') : api.stageLabel(buildStage).replace(/…$/, '')
            }
          />
        </View>
      </SafeAreaView>
    );
  }

  const ringMode: RingMode = status.playing || pendingPlay ? (inBreath ? 'breath' : 'playing') : 'idle';

  return (
    <SafeAreaView edges={['bottom']} style={StyleSheet.flatten([styles.fill, { backgroundColor: sky.top }])}>
      <StatusBar style="light" />
      {header(true)}

      <Animated.View
        style={[styles.fill, sceneInStyle]}
        onTouchStart={onSceneTouch}
        onLayout={(e) => {
          const w = e.nativeEvent.layout.width;
          anchorMoved(w !== playerW.current);
          playerW.current = w;
        }}>
        <TideScene
          lineIndex={idx}
          lineCount={island.lines.length}
          lines={lines}
          blind={hidden}
          busy={status.playing || take.phase === 'recording' || countdown !== null}
          countdown={countdown}
          banner={banner}
          sentence={sentence}
          below={below}
          scrollRef={scrollRef}
          onLineTap={onLineTap}
          instantReveal={coverUpNow}
          widenWhen={coveredAtMount ? widenTranscript : undefined}
          contentReveal={revealValues}
          initialHeight={Math.max(0, sceneEstimateH - dockSpace)}
        />

        <View
          style={styles.dock}
          onLayout={(e) => {
            const { y, height } = e.nativeEvent.layout;
            anchorMoved(y !== dockY.current);
            dockY.current = y;
            if (Number.isFinite(height) && height > 0) {
              // What the scene already holds for it: the last player's dock
              // height until this one's is set. Equal, nothing renders.
              const held = dockH > 0 ? dockH : lastDockH;
              lastDockH = height;
              if (Math.abs(held - height) > 0.5) setDockH(height);
            }
          }}>
          <Animated.View pointerEvents="none" style={[StyleSheet.absoluteFill, styles.dockBackdrop, dockBackdropStyle]} />
          <Animated.View style={toolbarInStyle}>
            <Toolbar items={toolbarItems} />
          </Animated.View>
          <Animated.View style={bottomInStyle}>
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
          </Animated.View>
        </View>
        {speedPopOpen && speedTile.current && playerW.current > 0 ? (
          <SpeedPopover
            anchorX={speedTile.current.x + speedTile.current.width / 2}
            anchorTop={dockY.current + speedTile.current.y}
            width={playerW.current}
            speed={speedLive}
            onSpeed={pickSpeed}
            onSettle={commitSpeed}
            onClose={() => setSpeedPopOpen(false)}
          />
        ) : null}
        {readingPopOpen && readingTile.current && playerW.current > 0 ? (
          <ReadingPopover
            anchorX={readingTile.current.x + readingTile.current.width / 2}
            anchorTop={dockY.current + readingTile.current.y}
            width={playerW.current}
            value={readingMode}
            onChange={pickReading}
            onClose={() => setReadingPopOpen(false)}
          />
        ) : null}
        {blindPopOpen && blindTile.current && playerW.current > 0 ? (
          <BlindPopover
            anchorX={blindTile.current.x + blindTile.current.width / 2}
            anchorTop={dockY.current + blindTile.current.y}
            width={playerW.current}
            jaHidden={blind}
            enHidden={!englishShown}
            onToggleJa={toggleBlind}
            onToggleEn={toggleEnglish}
            onClose={() => setBlindPopOpen(false)}
          />
        ) : null}
        {repeatPopOpen && repeatTile.current && playerW.current > 0 ? (
          <RepeatPopover
            anchorX={repeatTile.current.x + repeatTile.current.width / 2}
            anchorTop={dockY.current + repeatTile.current.y}
            width={playerW.current}
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
        onClose={onEchoClose}
        onDismissed={onSheetDismissed}
        sentence={hidden ? null : (phrase.label ?? line.ja)}
        english={englishShown ? line.en : null}
        native={island?.native ?? 'en'} // languages: RTL translation line for Hebrew.
        language={island?.language ?? 'ja'} // The help's Read along sample is in the island's language.
        moras={line.timeline}
        analysis={hidden ? null : feedback}
        step={echoStep}
        programme={programme}
        countdown={countdown}
        level={take.level}
        fill={echoFill}
        result={echoResult}
        error={take.error}
        autoEcho={autoEcho}
        autoRecord={autoRecord}
        onToggleAutoEcho={onToggleAutoEchoStable}
        onToggleAutoRecord={onToggleAutoRecordStable}
        headset={take.headset}
        onStart={onEchoStart}
        onRecord={onEchoRecord}
        stopping={speakStopped && !take.error}
        onStop={onEchoStop}
        onRetry={onEchoRetry}
      />
      <IslandMenuSheet
        open={sheet === 'island'}
        onClose={onMenuClose}
        onDismissed={onSheetDismissed}
        title={island.title}
        complexity={island.complexity}
        busy={revoicing || regenerating}
        recording={take.phase === 'recording'}
        exporting={exporting}
        revoiceName={voice !== null && island.speaker !== voice ? voiceName || t('player.chosenVoice') : null}
        onRename={onMenuRename}
        onExport={onMenuExport}
        onRevoice={onMenuRevoice}
        onRegenerate={onMenuRegenerate}
        onCalibrate={onMenuCalibrate}
        onDelete={onMenuDelete}
      />
      <ExplainSheet
        open={explainOpen}
        onClose={onExplainClose}
        sentenceJa={line?.ja ?? ''}
        sentenceEn={line?.en ?? ''}
        language={island?.language ?? 'ja'}
        native={island?.native ?? 'en'}
        words={line.words}
        span={explainSpan}
        highlight={highlight}
        blind={blind}
        marked={explainMarked}
        whole={explainWhole}
        generation={chatGeneration}
        onPlaySentence={onExplainPlay}
      />
    </SafeAreaView>
  );
}

const HEADER_ROW_H = PLAYER_HEADER_ROW_H;
type TileBox = { x: number; y: number; width: number };
/** The dock's height the last time a player laid it out, so the next open
 * can hold its place before the lines (and the dock) arrive. 0 until then. */
let lastDockH = 0;

type PlayerHeaderProps = {
  id: string;
  title: string;
  lineIndex: number;
  lineCount: number;
  /** Loading: the line row shows with a stand-in for the unknown count. */
  placeholder: boolean;
  background: string;
  onBack: () => void;
  /** The `…` island menu; null leaves an empty slot of the same size. */
  onMenu: (() => void) | null;
};

/**
 * The player's header, drawn in the screen rather than as native bar items
 * (those get the system's glass button background, which replays its appear
 * animation whenever the options change). The title stays hidden while the
 * card morph's flying title stands in for it.
 */
const PlayerHeader = memo(function PlayerHeader({
  id,
  title,
  lineIndex,
  lineCount,
  placeholder,
  background,
  onBack,
  onMenu,
}: PlayerHeaderProps) {
  const { t } = useT();
  const insets = useSafeAreaInsets();
  // The title and both buttons: the overlay draws them while a morph runs.
  const titleHidden = useMorphHidesTitle(id, 'header');
  const barRef = useRef<View>(null);
  const reportBar = () => {
    barRef.current?.measureInWindow((x, y, width, height) => setHeaderBoxRect({ x, y, width, height }));
  };
  return (
    <View
      ref={barRef}
      onLayout={reportBar}
      style={[styles.header, { paddingTop: insets.top, height: insets.top + HEADER_ROW_H, backgroundColor: background }]}>
      <View pointerEvents="none" style={[styles.headerTitle, { top: insets.top }]}>
        <PlayerTitle
          title={title}
          lineIndex={lineIndex}
          lineCount={lineCount}
          placeholder={placeholder}
          hidden={titleHidden}
          onTitleRect={setHeaderTitleRect}
        />
      </View>
      <PressScale onPress={onBack} hitSlop={12} accessibilityLabel={t('player.back')} style={styles.headerButton}>
        <Text style={[styles.backGlyph, titleHidden ? styles.hiddenChrome : null]}>‹</Text>
      </PressScale>
      {onMenu ? (
        <PressScale onPress={onMenu} hitSlop={12} accessibilityLabel={t('player.islandMenu')} style={styles.headerButton}>
          <Text style={[styles.menuGlyph, titleHidden ? styles.hiddenChrome : null]}>…</Text>
        </PressScale>
      ) : (
        <View style={styles.headerButton} />
      )}
    </View>
  );
});

const styles = StyleSheet.create({
  fill: { flex: 1 },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: Spacing.sm,
  },
  headerTitle: {
    position: 'absolute',
    left: Spacing.sm + 44,
    right: Spacing.sm + 44,
    bottom: 0,
    alignItems: 'center',
    justifyContent: 'center',
  },
  headerButton: { width: 44, height: 44, alignItems: 'center', justifyContent: 'center' },
  hiddenChrome: { opacity: 0 },
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
  keptUp: { fontFamily: fonts.ui, fontSize: 12, textAlign: 'center', color: tide.textDim, marginTop: 2 },
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
  // languages: iOS honours writingDirection; Android ignores it and falls
  // back to the string's own first-strong direction, which is right for
  // Hebrew text anyway.
  enRtl: { writingDirection: 'rtl' },
  menuGlyph: { fontFamily: fonts.ui, fontSize: 22, color: tide.text },
  backGlyph: { fontFamily: fonts.ui, fontSize: 28, color: tide.text },
  dock: { borderTopLeftRadius: Radius.lg, borderTopRightRadius: Radius.lg },
  dockBackdrop: { backgroundColor: 'rgba(0,0,0,0.18)', borderTopLeftRadius: Radius.lg, borderTopRightRadius: Radius.lg },
  body: { fontSize: 15, lineHeight: 22, textAlign: 'center', padding: Spacing.xl },
  inlineError: { fontSize: 13, lineHeight: 18, textAlign: 'center' },
  retry: { paddingVertical: Spacing.md, paddingHorizontal: Spacing.xxl, borderRadius: Radius.pill, marginTop: Spacing.md },
  secondaryBtn: { paddingVertical: Spacing.md, marginTop: Spacing.sm },
  retryText: { fontSize: 15, fontWeight: '700' },
});
