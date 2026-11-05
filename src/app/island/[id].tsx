import {
  type AudioMetadata,
  type AudioStatus,
  useAudioPlayer,
} from 'expo-audio';
import * as Haptics from 'expo-haptics';
import { activateKeepAwakeAsync, deactivateKeepAwake } from 'expo-keep-awake';
import { router, useLocalSearchParams, useNavigation } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { memo, useCallback, useEffect, useEffectEvent, useLayoutEffect, useMemo, useRef, useState } from 'react';
import {
  AppState,
  type LayoutChangeEvent,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  useWindowDimensions,
  View,
} from 'react-native';
import { Gesture, ScrollView } from 'react-native-gesture-handler';
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

import { PassHelpSheet } from '@/components/tide/pass-help-sheet';
import { IslandMenuSheet } from '@/components/tide/island-menu-sheet';
import { PlayerTitle } from '@/components/tide/player-title';
import { LadderStageView } from '@/components/tide/ladder-stage';
import { STAGE_SPEEDS } from '@/components/tide/ladder/stage-model';
import { StagePreview } from '@/components/tide/ladder/stage-preview';
import { useIslandHop,type HopActions } from '@/hooks/island/use-island-hop'; // focus-stories
import { useStageWord } from '@/hooks/island/use-stage-word'; // focus-stories
import type { LadderIo } from '@/hooks/ladder/ladder-types';
import { takeRoomSec, takeWatchSec, useLadder } from '@/hooks/use-ladder';
import { TideScene } from '@/components/tide/tide-scene';
import { useContentReveal, usePieceStyle } from '@/components/tide/use-content-reveal';
import { CompactDock } from '@/components/tide/compact-dock';
import { DockPopovers } from '@/components/tide/dock-popovers';
import { useDockPopovers } from '@/hooks/use-dock-popovers';
import { useTrayPills } from '@/hooks/use-tray-pills';
import { fitScale } from '@/lib/fit-line';
import { PressScale } from '@/components/press-scale';
import { CatConstellation } from '@/components/cat-constellation';
import { ExplainSheet } from '@/components/explain-sheet';
import { PhraseBar } from '@/components/phrase-bar';
import { type RingMode } from '@/components/ring-button';
import { GRAMMAR_LILAC } from '@/components/ruby-word';
import { useWordHighlight } from '@/components/word-highlight';
import { SymbolView } from 'expo-symbols'; // icon-buttons: retry/regenerate/refresh
import { PrismButton } from '@/components/prism'; // icon-buttons: retry/regenerate/refresh
import { fonts } from '@/constants/fonts';
// prism-player-buttons and icon-buttons: verb tokens
import { Radius, Spacing, prism, tide, tideSkies, verb } from '@/constants/theme';
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
import { alertSheet, confirmSheet } from '@/lib/confirm-sheet';
import { hapticImpact, hapticSelection } from '@/lib/haptics';
import { invalidateCachedIsland, peekCachedIsland, readCachedIsland, writeCachedIsland } from '@/lib/island-cache';
import { requestLoader } from '@/lib/loading-overlay';
import { IslandGuide } from '@/components/onboarding/island-guide';
import { useBetaFeatures } from '@/lib/beta'; // beta-gate
import { getGuideStep, setGuideStep, useGuideAnchor, useGuideLock, useGuideStep } from '@/lib/guide'; // bl57-intro-round2
import { GuideBubble } from '@/components/onboarding/guide-bubble'; // bl58-easy-for-me
import { useEasyMark } from '@/hooks/island/use-easy-mark';
import { EasyOffer } from '@/components/island/easy-offer';
import { useIslandExport } from '@/hooks/use-island-export';
import { getLastLine, peekLastLine, resumeLine, setLastLine } from '@/lib/last-line';
import { useSkyStyle } from '@/lib/sky';
import { usePhrase } from '@/hooks/use-phrase';
import { useLineStatus } from '@/hooks/use-line-status';
import { usePracticeClock } from '@/hooks/use-practice-clock';
import { TAIL_MS, useTake, WATCHDOG_FALLBACK_MS, type TakeMode } from '@/hooks/use-take';
import * as api from '@/lib/api';
import { isDownloaded, preloadOfflineGlosses, snapOffline } from '@/lib/offline-islands'; // offline-islands
import {
  applyPlaybackMode,
  lockArtwork,
  releaseAudioSession,
  scheduleAudioSessionRelease,
  startPlayback,
  stopPlayback,
  useSessionPlayer,
} from '@/lib/audio-mode';
import {
  fillKindOf,
  helpPassOf,
  isActive,
  isArmedStep,
  isSpeakStep,
  TAKE_VOICE_VOLUME, // bl57-intro-round2
  textShownAt,
  type PassStep,
} from '@/lib/pass-programme';
import { wordPitches } from '@/lib/pitch';
import { addLadder } from '@/lib/practice';
import {
  autoPlaceOf,
  finishSession,
  noteSessionLine,
  routeFor,
  sessionLines,
  endAutoPractice,
  finishAutoIsland,
  type AutoChain,
} from '@/lib/auto-practice'; // auto-practice
import { lineRomaji } from '@/lib/romaji';
import { forgetRung, getRung, peekRung, recordTake, setRungSpeed } from '@/lib/speed-ladder';
import {
  DEFAULT_VOICE_BY_LANGUAGE,
  getSettings,
  getSettingsSync,
  TIMES_MAX,
} from '@/lib/settings';
import { deleteTakes, wordsKeptUp } from '@/lib/takes';
import { invalidateLineAudio, localLineAudio, prefetchLineAudio } from '@/lib/line-audio-cache';
import { useSlideReveal } from '@/lib/slide-reveal';
import { breathOf, DRAG_LIMIT, lineEndOf, rubberBandDragY } from '@/lib/island/player-timing';
import { useStableHandler } from '@/hooks/use-stable-handler';
import { IslandSentenceCard } from '@/components/island/island-sentence-card';
import { HEADER_ROW_H, Leaf, PlayerHeader } from '@/components/island/player-header';
import { useDir, useT } from '@/lib/i18n'; // offline-islands: useDir
import { AUTO_NEXT_HOLD_MS, CONTEXT_LINES, EASY_OFFER_HOLD_MS,EXPORT_GAP_MS, FINISH_GUARD_MS, GUIDE_AUDIO_MS, OFFLINE_RETRY_MS, OPEN_HOLD_MAX_MS, PENDING_PLAY_MS, RATE_MAX, RATE_MIN, REFRESH_AFTER_COVER_MS, SEEK_WAIT_MS, SPEED_LOAD_WAIT_MS, SWAP_STALE_MS, TAKE_LAG_MAX_MS, TAKE_READ_AFTER_COVER_MS, TRANSCRIPT_WIDEN_MS, lockScreen } from '@/lib/island/island-consts';
import { useIslandWordPanel } from '@/hooks/island/use-island-word-panel';
import type { IslandCore } from '@/hooks/island/island-core';
import { readWarmStart, useIslandLoad } from '@/hooks/island/use-island-load';
import { useIslandRebuild } from '@/hooks/island/use-island-rebuild';

// languages: short code shown on the Blind dock tile and Home's language pill.

export default function IslandScreen() {
  const { id, morph, auto, line: ytLine, hop: hopParam } = useLocalSearchParams<{ id: string; morph?: string; auto?: string; line?: string; hop?: string }>(); // auto-practice, youtube-shadowing, focus-stories
  const navigation = useNavigation();
  const sky = useSkyStyle();
  const { t, lang: uiLang } = useT();
  const dir = useDir(); // offline-islands
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
  const [offline, setOffline] = useState(false); // offline-islands
  const refreshRef = useRef<(() => Promise<void>) | null>(null); // offline-islands: the load effect's refresh, for the offline retry
  useEffect(() => void preloadOfflineGlosses(id), [id]); // offline-islands: read the stored meanings before the first word tap

  // Opened by the card morph, the local copy Home's press-in read is usually
  // parsed by the time this screen mounts. It goes into the first render, so
  // the island is on screen when the morph lands instead of one more heavy
  // render later. It takes this path only if the saved line is already known.
  // focus-stories: a cube hop takes it too: the hop hook kept the neighbour's copy read and parsed.
  const [warmStart] = useState(() => readWarmStart(id, hopParam));
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
  // offline-islands: offline, a speed or pad that was not downloaded jumps to the nearest one that was.
  useEffect(() => {
    if (!offline) return;
    const s = snapOffline(id, speed, padMs);
    if (s.speed !== speed) setSpeed(s.speed);
    if (s.padMs !== padMs) setPadMs(s.padMs);
  }, [offline, id, speed, padMs]);
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
  // A speed picked while the line plays (commitSpeed): the line carries on over the file it has
  // at the native rate `ahead / speed`, and the file rendered at `ahead` takes over at the next
  // play (landSpeedAhead). `ahead` mirrors the ref for the prefetch; `liveRate` is that rate.
  const speedAhead = useRef<number | null>(null);
  const [ahead, setAheadState] = useState<number | null>(null);
  const rateRef = useRef(1);
  const [liveRate, setLiveRateState] = useState(1);
  function setAhead(v: number | null) {
    speedAhead.current = v;
    setAheadState(v);
  }
  function setLiveRate(r: number) {
    rateRef.current = r;
    setLiveRateState(r);
  }
  // bl56-first-run-flow: the guide's first island parks each played line and shows IslandGuide.
  const guideStep = useGuideStep();
  const beta = useBetaFeatures().beta; // beta-gate: Drive in the menu
  // bl57-intro-round2: four moments on the 3-line starter island (listen, shadow, prep, solo).
  const guideOn =
    (guideStep === 'listen' || guideStep === 'shadow' || guideStep === 'prep' || guideStep === 'solo') &&
    id === getSettingsSync().guideIslandId;
  // bl57-intro-round2: no way out while the guide runs here, nor during its Practice 5 session.
  // A failed load (or line audio that never loads) unlocks it, so the error and its Retry are never a dead end.
  const [guideAudioFailed, setGuideAudioFailed] = useState(false);
  // Whether the audio load error is up for this outage; a line that loads re-arms it.
  const audioFailShown = useRef(false);
  const guideLocked = (guideOn && !!island && island.lines.length > 0 && !error && !guideAudioFailed) || guideStep === 'practice';
  useGuideLock(guideLocked);
  // The guide lights the current line card too, so its text stays readable under the dim.
  const cardAnchor = useGuideAnchor('lineCard', guideOn);
  // bl58-easy-for-me: the Easy chip is a second lit hole under the guide.
  const chipAnchor = useGuideAnchor('easyChip', guideOn);
  const remeasureCard = cardAnchor.onLayout;
  const remeasureChip = chipAnchor.onLayout;
  // Measures the card and the chip together, now and once the card has settled (a glide, a spring, the transcript's
  // own re-aim): a transform or a scroll fires no onLayout, so the chip's hole would stay where the chip was.
  // Called on a line change, on the card's layout and when the transcript stops scrolling. It only writes the
  // guide's anchor store, which nothing here renders from, so it cannot feed back into the scroll.
  const guideMeasureTimers = useRef<ReturnType<typeof setTimeout>[]>([]);
  const remeasureGuide = useCallback(() => {
    guideMeasureTimers.current.forEach(clearTimeout);
    guideMeasureTimers.current = [];
    if (!guideOn) return;
    remeasureCard();
    remeasureChip();
    guideMeasureTimers.current = [250, 600, 1100].map((ms) =>
      setTimeout(() => {
        remeasureCard();
        remeasureChip();
      }, ms),
    );
  }, [guideOn, remeasureCard, remeasureChip]);
  useEffect(() => {
    if (!guideOn) return;
    remeasureGuide();
    // eslint-disable-next-line react-hooks/exhaustive-deps
    return () => guideMeasureTimers.current.forEach(clearTimeout);
  }, [guideOn, idx, remeasureGuide]);
  // bl58-easy-for-me: the lines marked Easy for me (backend idx, from GET /islands and the mark replies), the 90+
  // offer (the line's position here) and the reaction after a mark. `offered` keeps the offer to once per line per open.
  const [known, setKnown] = useState<ReadonlySet<number>>(() => new Set());
  const offerClearRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [easyOffer, setEasyOffer] = useState<number | null>(null);
  const [easyDone, setEasyDone] = useState<{ count: number } | null>(null);
  const offeredRef = useRef(new Set<string>());
  const easyTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const glideTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (easyTimer.current) clearTimeout(easyTimer.current);
      if (glideTimer.current) clearTimeout(glideTimer.current);
    },
    [],
  );
  // Every GET carries the list; a copy cached before this build has none and shows nothing marked until the next one.
  const knownFromServer = island?.known;
  useEffect(() => {
    if (knownFromServer) setKnown(new Set(knownFromServer));
  }, [knownFromServer]);
  // A guide state saved by an older build can point at a non-starter island: start over, never lock the user there.
  useEffect(() => {
    if (guideOn && island && island.source !== 'starter') setGuideStep('home');
  }, [guideOn, island]);
  const [, bumpGuide] = useState(0); // first-run guide: re-place the spotlight when a dock control moves
  // The dock's popovers, tile anchors, dock height and the reading, blind and
  // English toggles. The touched refs keep a slow settings load from overriding
  // a choice made on this visit.
  const dock = useDockPopovers({
    onAnchorExtra: (key) => {
      if (key === 'play' || key === 'record') bumpGuide((n) => n + 1);
    },
    onPickReading: () => {
      readingTouched.current = true;
    },
    onToggleBlind: (next) => {
      blindTouched.current = true;
      if (next) {
        closePanel();
        clearDragSpan();
      }
    },
    onToggleEnglish: () => {
      englishTouched.current = true;
    },
  });
  const {
    setSpeedPopOpen, repeatPopOpen, setRepeatPopOpen, blindPopOpen, setBlindPopOpen,
    readingPopOpen, setReadingPopOpen, trayOpen, setTrayOpen, anchors, dockY, dockH, setDockH, onAnchor, anchorMoved,
    englishShown, setEnglishShown, blind, setBlind, readingMode, setReadingMode,
    explainOpen, setExplainOpen, explainMarked, setExplainMarked, explainWhole, setExplainWhole, explainSpan, setExplainSpan,
  } = dock;
  // The scene's height before its first layout (the window under the header,
  // above the bottom inset), so the water is drawn from the first frame.
  const { height: windowH, width: windowW } = useWindowDimensions();
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
  const sheetRef = useRef<'echo' | 'island' | null>(null);
  useLayoutEffect(() => {
    sheetRef.current = sheet;
  });
  function closeSheetThen(fn: () => void) {
    // No sheet open (the run lives in the dock now): nothing to wait for.
    if (sheetRef.current === null) {
      fn();
      return;
    }
    afterSheet.current = fn;
    setSheet(null);
  }
  function runAfterSheet() {
    const fn = afterSheet.current;
    afterSheet.current = null;
    if (fn) fn();
  }
  // The ladder's active stage fill, 0..1, animated on the UI thread the same
  // way: one shared value, aimed with withTiming over the step's real
  // duration, re-aimed only on drift. Which segment reads it is decided by
  // the step (see the effect below).
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
  // Set once the user taps Blind, so a slow settings load does not overwrite
  // the choice.
  const blindTouched = useRef(false);
  const englishTouched = useRef(false);
  // How the reading is shown (furigana over the kanji, the kana line, or
  // romaji) and whether pitch marks are drawn. Remembered like Blind.
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

  const line = island?.lines[idx];
  // bl58-easy-for-me: from the first Easy mark on an island, every later line (backend order) runs Listen, Shadow,
  // Compare without the prep passes; unmarking restores them. Line 1 under the guide skips them too (BL-57).
  const lineKnown = !!line && known.has(line.idx);
  const prepOn = !(guideOn && idx === 0) && !(line && [...known].some((k) => k < line.idx));
  // The line's own index on the server. `idx` is the position on screen,
  // which differs from it when a session shows only its picked lines.
  const lineIdx = line?.idx ?? idx;
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
  // Grammar island: the point's level for the tag above the card (GR2-B3).
  const isGrammar = island?.source === 'grammar';
  const grammarId = isGrammar ? island?.source_name : undefined;
  const [grammarPoint, setGrammarPoint] = useState<api.GrammarPoint | null>(null);
  useEffect(() => {
    if (!grammarId) return;
    let live = true;
    api
      .grammarPoint(grammarId)
      .then((p) => {
        if (live) setGrammarPoint(p);
      })
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [grammarId]);
  const grammarLevel = grammarPoint?.level ? `${grammarPoint.level_guess ? '~' : ''}${grammarPoint.level}` : '';
  const grammarMeaning = grammarPoint?.meaning_short ?? '';
  const islandTitle = island?.title ?? '';
  // Pinned above the card, outside `sentence`, so it stays put as lines change.
  const grammarTag = useMemo(() => {
    if (!isGrammar || !grammarId) return null;
    const label = [`～${grammarId}`, grammarMeaning || islandTitle].filter(Boolean).join(' · ');
    return (
      <View style={[styles.gTag, dir.rtl && styles.gTagRtl]} accessibilityLabel={[grammarLevel, label].filter(Boolean).join(' · ')}>
        {grammarLevel ? (
          <View style={styles.gChip}>
            <Text style={styles.gChipText}>{grammarLevel}</Text>
          </View>
        ) : null}
        <Text style={[styles.gTagText, { writingDirection: 'auto' }]} numberOfLines={1}>
          {grammarLevel ? (dir.rtl ? `${label} · ` : ` · ${label}`) : label}
        </Text>
      </View>
    );
  }, [isGrammar, grammarId, grammarLevel, grammarMeaning, islandTitle, dir.rtl]);
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
  const take = useTake(
    island?.id,
    lineIdx,
    generation,
    coveredAtMount ? firstTakeRead : undefined,
    (s) => takeStatusHandler.current(s),
    { guide: guideOn && guideStep !== 'listen' }, // bl57-intro-round2
  );
  // bl57-intro-round2: the original voice sits at half volume under the Shadow take.
  useEffect(() => {
    player.volume = take.phase === 'recording' ? TAKE_VOICE_VOLUME : 1;
  }, [take.phase, player]);
  // A ref mirror of the ladder's step (set under the hook call below), so the
  // effects and listeners that are subscribed once, or read state a render
  // behind, always see the current step.
  const echoRef = useRef<PassStep>('idle');
  // The blind take is read once at mount from Settings > Playback, so a change
  // made there never lands halfway through a run.
  const [blindTake] = useState(() => getSettingsSync().blindTake);
  // The pass help sheet behind the strip's ? glyph: open flag and the pass it
  // explains (kept while it closes).
  const [helpOpen, setHelpOpen] = useState(false);
  const [helpPass, setHelpPass] = useState<0 | 1 | 2 | 3 | 4>(0);
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
  // auto-practice: the chain this player is part of, if any. Read once at
  // mount; a stale `auto` param with no live session is ignored.
  const [autoStartPlace] = useState(() => (auto === '1' ? autoPlaceOf(id) : null));
  const autoRunRef = useRef(autoStartPlace !== null);
  const autoHoldRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // auto-practice: the island the hold moves on to; set for the whole hold,
  // also while backgrounding has paused its timer.
  const pendingNextRef = useRef<{ id: string; kind: api.SessionKind } | null>(null);
  const autoLeavingRef = useRef(false);
  const autoStartedRef = useRef(false);
  // auto-practice: a session opens straight into the ladder stage, so the loader stands in for
  // the player until the stage is up (or OPEN_HOLD_MAX_MS passes), and the player's own line never
  // shows between the two.
  // focus-stories D3: the neighbours for the cube swipe and the hop to one of them. `hopActions` is filled
  // once `endRun` and `goToIsland` exist below. A hop (`hop.starts`) opens this island straight into its
  // run, under the same hold as a session.
  const hopActions = useRef<HopActions | null>(null);
  // night-split: what the extracted island hooks call back into, assigned just before the return.
  const core = useRef<IslandCore | null>(null);
  const hop = useIslandHop({ id, auto, hop: hopParam, actions: hopActions });
  const [openHold, setOpenHold] = useState(autoStartPlace !== null || hop.starts);
  const openHoldRef = useRef(openHold);
  openHoldRef.current = openHold;
  useEffect(() => {
    if (!openHold) return;
    const timer = setTimeout(() => setOpenHold(false), OPEN_HOLD_MAX_MS);
    return () => clearTimeout(timer);
  }, [openHold]);
  // focus-stories: a hop opens under the hop cover, the still stage (StagePreview) the cube just turned to,
  // drawn over everything until the live stage's sentence has fitted under it, so the turn lands on one
  // picture and the run's count-in starts on it. A wait past OPEN_HOLD_MAX_MS drops it as well.
  const [hopCover, setHopCover] = useState(hop.starts);
  useEffect(() => {
    if (!hopCover) return;
    const timer = setTimeout(() => setHopCover(false), OPEN_HOLD_MAX_MS);
    return () => clearTimeout(timer);
  }, [hopCover]);
  const onStageFitted = useCallback(() => setHopCover(false), []);
  const [autoUi, setAutoUi] = useState<AutoChain | null>(
    autoStartPlace ? { at: autoStartPlace.at, total: autoStartPlace.total, next: null } : null,
  );
  // auto-practice: when the current line's ladder started, for the session's seconds per line.
  const lineStartRef = useRef(0);
  // auto-practice: the line already noted on this visit, null once the run moves to another line.
  const notedLineRef = useRef<number | null>(null);
  // The session's picked lines only; the full island otherwise.
  const forSession = <T extends { lines: api.Line[] }>(data: T): T => (auto === '1' ? sessionLines(id, data) : data);
  useEffect(
    () => () => {
      if (autoHoldRef.current) clearTimeout(autoHoldRef.current);
    },
    [],
  );
  const [autoEcho, setAutoEchoState] = useState(true);
  const autoEchoTouched = useRef(false);
  // A take and a line played from Explain stop the line where the pad begins
  // (the crossing effect below), so no pause follows. The stop lands a status
  // or two after the crossing, and without this the countdown would flash
  // for that moment. With a 0s pause there is no pad to count down. `echoRef`
  // runs a render behind the hook below; this only tunes the countdown.
  const stopsAtLineEnd = take.phase === 'recording' || explainOpen || (guideOn && !isActive(echoRef.current));
  // The line's status renders the screen only when something drawn from it
  // changes: playing, loaded, the duration, a finish, the breath and its
  // countdown second. Each 50ms position update runs onLineStatus (below)
  // instead, which moves the stage fill on the UI thread and watches for
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
  // The line's wall-clock length: `lineEnd` is in the file's seconds, and a mid-play speed pick
  // runs the file at `liveRate` until the next play.
  const lineSecLive = liveRate > 0 && Number.isFinite(liveRate) ? lineEnd / liveRate : lineEnd;
  const { inBreath, countdown } = breathOf(status, breathMs, stopsAtLineEnd);
  const wasTakePlaying = useRef(false);

  // The ladder run. The shared hook owns the steps, the prelude, the take's
  // room, the hold on the score, Pause, Loop and the line bar; the island hands
  // it its audio through `io` (built per render, as the wiring's is) and keeps
  // the rung speed ladder, the guide and the session to itself.
  const ladderRef = useRef<ReturnType<typeof useLadder> | null>(null);
  const context = useMemo(
    () => ({
      before: lines.slice(Math.max(0, idx - CONTEXT_LINES), idx),
      after: lines.slice(idx + 1, idx + 1 + CONTEXT_LINES),
    }),
    [lines, idx],
  );
  // Silences the line and drops a take in progress: the hook's stop, and the
  // start of a run.
  function silenceLine() {
    stopPlayback(player);
    setPlayWhenLoaded(false);
    dropTake();
    // Freeze the highlight where it is now: the paused status lands a moment
    // later, and running on until then could start lighting the next word.
    holdHighlight();
    // A speed picked mid-play loads now, while the run announces or counts.
    landSpeedAhead();
  }
  // focus-stories D8: the stage's word tap; its panel's Hear plays through `wordSource` below.
  const stageWord = useStageWord(island ?? null, () => void hearWord());
  const io: LadderIo = {
    // The audio is pre-rendered at the rung, so the pass speed is ignored.
    playLine: () => void playFromTop(),
    // Headset: the mic opens with the line playing under it, exactly like Record my take, so the
    // take is uploaded, cleaned of the line's bleed and scored. Speaker: turn-taking, the take is
    // silent (no line under it) and scored on the clock.
    record: async () => {
      const ok = (await beginRecording('take', 'auto', true)) !== null;
      // The run ended or moved on while the mic was opening: the line it
      // started falls silent here, and the hook drops the take.
      if (ok && !isSpeakStep(echoRef.current)) stopPlayback(player);
      return ok;
    },
    stop: silenceLine,
    // The pace sheet's speed ruler: the same settle as the dock's Speed popover.
    setSpeed: commitSpeed,
    onLineDone: (score) => {
      if (!island) return;
      // A Compare played back is one sentence ladder finished, which is what
      // a day on the streak counts.
      addLadder(island.id);
      // auto-practice: a line counts once per visit, so a looped Compare adds neither a line nor its seconds again.
      if (autoRunRef.current && line && notedLineRef.current !== line.idx) {
        notedLineRef.current = line.idx;
        noteSessionLine(island.id, line.idx, lineStartRef.current ? (Date.now() - lineStartRef.current) / 1000 : 0, line);
      }
      lineStartRef.current = Date.now();
      if (guideOn) return;
      // bl58-easy-for-me: a 90+ Compare on a line not yet known offers Easy, once per line per open. Only a tap marks.
      const key = line ? `${island.id}:${line.idx}` : null;
      if (key === null || !line || typeof score !== 'number' || score < 90 || known.has(line.idx) || offeredRef.current.has(key)) return;
      offeredRef.current.add(key);
      setEasyOffer(idx);
      if (!autoEcho) {
        // Without Auto Echo nothing else ends the offer: it clears by itself, never marking.
        if (offerClearRef.current) clearTimeout(offerClearRef.current);
        offerClearRef.current = setTimeout(() => {
          offerClearRef.current = null;
          setEasyOffer(null);
        }, EASY_OFFER_HOLD_MS);
        return;
      }
      // Auto Echo holds the run on the score while the offer is up.
      return { holdMs: EASY_OFFER_HOLD_MS };
    },
    advance: () => {
      if (!island) return false;
      if (guideOn) {
        // bl57-intro-round2: under the guide a finished Compare parks the next line instead of running it. The run
        // rests on done and the dock reads Shadow there (onDockRecord), which runs the parked line.
        const step = getGuideStep();
        if (step === 'solo') {
          setGuideStep('topics');
          router.replace('/phrases');
          return false;
        }
        go(idx + 1, false);
        if (step === 'shadow') setGuideStep('prep');
        else if (step === 'prep') setGuideStep('solo');
        return false;
      }
      // The ladder walks the island once and stops at its end: no wrap.
      if (idx >= island.lines.length - 1) {
        setEasyOffer(null);
        if (autoRunRef.current) autoIslandDone(); // auto-practice
        return false;
      }
      lineStartRef.current = Date.now();
      notedLineRef.current = null;
      go(idx + 1, false);
      return true;
    },
    // go() is a no-op on the same line, so Loop and prev on the first line restart it in place.
    // Refused only past the ends; with Explain open the line stays put and the ladder restarts it.
    goTo: (i) => {
      if (!island || i < 0 || i >= island.lines.length) return false;
      if (explainOpen) return true;
      if (i !== idx) notedLineRef.current = null;
      lineStartRef.current = Date.now();
      go(i, false);
      return true;
    },
    lineIndex: idx,
    lineCount: island?.lines.length ?? 0,
    context,
    title: island?.title,
    lineText: line?.ja ?? '',
    line: line ?? null,
    prep: prepOn, // bl57-intro-round2, bl58-easy-for-me
    // The guide parks the next line through advance, so its run never ends on done before that.
    autoEcho: autoEcho || guideOn,
    armOnMicFail: true,
    // focus-stories: D8 `word`, D3 `neighbours` and `onHop`, from their hooks.
    ...stageWord.io,
    ...hop.io,
  };
  // `base` is 1: the rung speeds (0.6, 0.7) are not quarter steps and the
  // audio already runs at them, so the hook never sets a rate and the speed
  // ruler stays off the island (the pace chip is on).
  const ladder = useLadder(take, 1, lineSecLive, io);
  ladderRef.current = ladder;
  useLayoutEffect(() => {
    echoRef.current = ladder.step;
  }, [ladder.step]);
  const echoActive = ladder.active;
  // A line played from the Explain sheet, or by Play under the first-run guide
  // outside a ladder run, plays once and parks at its top (watchLineEnd), so
  // the guide never chases a player running on into the next lines.
  const playsOnce = explainOpen || (guideOn && !echoActive);
  // Outside a run the Blind setting decides; the ladder's passes decide it
  // themselves, keeping the sentence in view except for the blind take.
  const passText = textShownAt(ladder.step, blindTake, ladder.stage?.round === 2);
  const hidden = passText === null ? blind : !passText;
  // Lifted once the stage has mounted (behind the loader), not when it is asked for, so the
  // player's line cannot start its reveal in the renders between.
  const stageUp = ladder.stage !== null;
  useEffect(() => {
    if (openHold && stageUp) setOpenHold(false);
  }, [openHold, stageUp]);
  // Shadow from idle (or Start again): a held phrase is cleared first, so every
  // pass hears the whole line, and the line falls silent for the announce and
  // the count.
  function startRun() {
    clearPhrase();
    silenceLine();
    lineStartRef.current = Date.now();
    notedLineRef.current = null;
    ladder.start();
  }
  // Ends the run: the stage's back chevron, an Easy mark, a session hop, Back
  // and the app going to the background.
  function endRun() {
    ladder.stop();
    setEasyOffer(null);
    void player.seekTo(0);
    scheduleAudioSessionRelease();
  }
  // Restarts the run on line `i` at its first pass; past the ends, nothing.
  function runLine(i: number) {
    if (!island || i < 0 || i >= island.lines.length) return;
    ladder.goLine(i);
  }
  // Stop mid-line: the mic closing silences the line at once (the take hook
  // saves what was said).
  const wasRecordingRef = useRef(false);
  useEffect(() => {
    if (wasRecordingRef.current && take.phase !== 'recording' && isSpeakStep(echoRef.current)) {
      stopPlayback(player);
      void player.seekTo(0);
    }
    wasRecordingRef.current = take.phase === 'recording';
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [take.phase]);
  // The run's rest points hand the audio session back: paused, finished, or
  // waiting on the Record tap.
  useEffect(() => {
    if (ladder.paused || ladder.step === 'done' || (isArmedStep(ladder.step) && ladder.prelude === null)) scheduleAudioSessionRelease();
  }, [ladder.step, ladder.paused, ladder.prelude]);

  // The word panel: the tapped word, its gloss and its own player, the drag selection and its handles.
  const {
    selected, glossData, explainContext, wordBoxes, blockWidth, scrollRef, dragSpan, handleDragging, blockTouched,
    chatGeneration, wordPlayer, wordStatus,
    closePanel, resetPanel, clearDragSpan, tapWord, hearWord, hitTest, startDrag, dragTo,
    grabHandle, dragHandle, releaseHandle, clearSelection, onSceneTouch, copySelection, onBlockLayout,
  } = useIslandWordPanel({ core, player, status, hidden, line, island, isJa, stageWord });
  // auto-practice: the sheet opens by itself once this island is ready.
  useEffect(() => {
    // focus-stories D3: a hop (`hop.starts`) starts the run the same way, without forcing hands-free on.
    if ((!autoRunRef.current && !hop.starts) || autoStartedRef.current) return;
    if (!island || !line || !status.isLoaded || sheet !== null || ladder.step !== 'idle') return;
    autoStartedRef.current = true;
    if (autoRunRef.current) {
      autoEchoTouched.current = true;
      setAutoEchoState(true);
    }
    startRun();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [island, line, status.isLoaded, sheet, ladder.step]);
  // bl57-intro-round2: line audio that never loads under the guide (offline, a server error) unlocks
  // the screen and shows the load error, so Back is not a dead end.
  useEffect(() => {
    if (status.isLoaded) {
      setGuideAudioFailed(false);
      audioFailShown.current = false;
    }
    if (!guideOn || !island || status.isLoaded) return;
    const timer = setTimeout(() => {
      setGuideAudioFailed(true);
      setError(t('player.couldNotLoadIsland'));
    }, GUIDE_AUDIO_MS);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [guideOn, island, status.isLoaded]);
  // Under the open morph's cover, the session waits until the cover is gone.
  useEffect(() => {
    const stop = afterCoverGone(id, () => void applyPlaybackMode());
    return () => {
      stop();
      void releaseAudioSession();
    };
  }, [id]);

  const [attempt, setAttempt] = useState(0);
  // night-wave: auto-practice reached an island it cannot load offline (not
  // downloaded). It counts as skipped and the chain moves on at once; no sheet
  // is open, so this navigates directly. With no island left the chain is
  // dropped and the load error shows. Returns whether it moved on.
  const skipUnloadedIsland = useStableHandler((): boolean => {
    if (!autoRunRef.current || autoLeavingRef.current || !autoPlaceOf(id)) return false;
    const next = finishAutoIsland(id, 'skipped');
    if (!next) {
      dropChain();
      return false;
    }
    autoLeavingRef.current = true;
    router.replace(routeFor(next.nextId, next.nextKind));
    return true;
  });
  // A message set just before a deliberate reload survives that reload. Every
  // other error is cleared once the island loads.
  const carryError = useRef('');
  const { doRevoice, awaitRevoice, renameTitle, confirmRegenerate, confirmDelete } = useIslandRebuild({
    core,
    island,
    voice,
    revoicing,
    regenerating,
    player,
    carryError,
    isMounted: () => mountedRef.current,
    forSession,
    resetHighlight,
    removeIsland,
    setIdx,
    setIsland,
    setError,
    setRevoicing,
    setRegenerating,
    setBuildStage,
    setGeneration,
    setAttempt,
    // The rebuild hook only ever clears the span; the word panel exposes no raw setter.
    setDragSpan: clearDragSpan,
  });
  // Opened while a re-voice is still running on the server (a second way in,
  // or Retry): wait for it with the same loader rather than show lines whose
  // audio is half old voice, half new. An effect event, so the load effect
  // does not depend on awaitRevoice, a new function every render.
  const resumeRevoice = useEffectEvent((islandId: string) => {
    if (revoicing || regenerating) return;
    setRevoicing(true);
    void awaitRevoice(islandId);
  });
  useIslandLoad({
    id,
    attempt,
    auto,
    ytLine,
    island,
    error,
    cacheMissed,
    offline,
    lineIdx,
    warmStartRef,
    refreshRef,
    carryError,
    openHoldRef,
    autoRunRef,
    forSession,
    setIdx,
    setIsland,
    setError,
    setOffline,
    setCacheMissed,
    resumeRevoice,
    skipUnloadedIsland,
  });

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
          clearDragSpan();
        }
      }
      if (!englishTouched.current) setEnglishShown(!settings.hideEnglish);
      if (!autoEchoTouched.current) setAutoEchoState(settings.autoEcho);
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

  // Speed is baked into the audio by VOICEVOX, so the player runs at 1.0,
  // except between a mid-play speed pick and its landing (rateRef, see
  // commitSpeed). The native loop is only for a phrase picked from the selection
  // popup, which repeats until cleared (the pad's silence becomes the pause,
  // with no gap at the wrap). Whole lines repeat and advance by hand from the
  // finish effect below. Both settings live on the native player and survive
  // a source swap.
  const phraseLoop = !!phrase.span;
  useEffect(() => {
    player.setPlaybackRate(rateRef.current, 'high');
    // The ladder advances by hand between its own stages, so the native loop
    // must stay off for the whole run even on a phrase.
    // A line played from the Explain sheet plays once, so no native loop
    // either while that sheet is open.
    player.loop = phraseLoop && !echoActive && !explainOpen;
  }, [player, phraseLoop, echoActive, explainOpen]);

  // The stage fill: which stage is "active" is `step` itself, so this only
  // has to animate `echoFill`
  // toward 1 over that step's real duration. Reset to 0 on every step change,
  // which is also what makes a finished step's fill hold at full: the sheet
  // renders segments before the active one as always full, so once the step
  // moves on this value stops mattering for it.
  const echoFillStep = useRef<PassStep>('idle');
  // The Speak segment has no natural end event to key off (the learner or the
  // watchdog can stop it early), so it is aimed once per recording attempt:
  // the mic opening after a Retry's cancel is a new attempt.
  const echoFillRecAimed = useRef(false);
  // The listening passes follow the line's own position, so they are aimed from
  // onLineStatus on each status as well as from the step effect below. A
  // status landing between a step change's render and that effect leaves the
  // fill alone: the effect resets it to 0 first, then aims it.
  // `force` re-aims at once: a mid-play speed pick changes how fast the rest runs.
  function aimEchoLine(s: AudioStatus, force = false) {
    const step = echoRef.current;
    if (echoFillStep.current !== step) return;
    // A position that is not a number would reach the sheet's percentage
    // width, and a NaN in a worklet ends Expo Go without a red box.
    if (!Number.isFinite(s.currentTime)) return;
    // A pass owns the pad too (it is the breath before the next pass), so its
    // fill runs the whole source.
    if (fillKindOf(step) !== 'line') return;
    const span = s.duration;
    if (!s.playing || !Number.isFinite(span) || span <= 0) return;
    const target = Math.min(1, s.currentTime / span);
    if (force || echoFill.value === 0 || Math.abs(echoFill.value - target) > 0.08) {
      cancelAnimation(echoFill);
      echoFill.value = target;
      // File seconds over the live rate: the wall-clock time the rest takes.
      const rate = rateRef.current > 0 && Number.isFinite(rateRef.current) ? rateRef.current : 1;
      const remaining = Math.max(0, ((span - s.currentTime) * 1000) / rate);
      echoFill.value = withTiming(1, { duration: remaining, easing: Easing.linear });
    }
  }
  // An effect event, so the effect below runs for the deps it lists and
  // reads everything else as of that render.
  const aimEchoStep = useEffectEvent(() => {
    if (echoFillStep.current !== ladder.step) {
      echoFillStep.current = ladder.step;
      cancelAnimation(echoFill);
      echoFill.value = 0;
    }
    if (ladder.paused) {
      // Pause silences the line: the bar rests empty until Resume replays the pass.
      cancelAnimation(echoFill);
      echoFill.value = 0;
      return;
    }

    const kind = fillKindOf(ladder.step);
    if (kind === 'line') {
      aimEchoLine(latestStatus.current);
      return;
    }

    if (kind === 'record') {
      // Still opening the mic, or the previous take's cleanup finishing:
      // hold empty until this attempt is actually recording.
      if (take.phase !== 'recording') {
        echoFillRecAimed.current = false;
        return;
      }
      if (echoFillRecAimed.current) return;
      echoFillRecAimed.current = true;
      cancelAnimation(echoFill);
      echoFill.value = 0;
      // The ladder take's room past the line, plus the lag the tail adds.
      const expected = (lineSecLive > 0 ? takeRoomSec(lineSecLive) * 1000 : WATCHDOG_FALLBACK_MS + TAIL_MS) + takeLagMs;
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
  }, [ladder.step, ladder.paused, lineSecLive, breathSec, take.phase, takeLagMs]);

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
  // A play that never loads its audio (offline mid-play, a server error) says
  // so once instead of going quiet; see audioFailShown.
  useEffect(() => {
    if (!pendingPlay) return;
    const timer = setTimeout(() => {
      setPendingPlay(false);
      if (latestStatus.current.isLoaded || audioFailShown.current) return;
      audioFailShown.current = true;
      setError(t('player.couldNotLoadIsland'));
    }, PENDING_PLAY_MS);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
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
    // (loadedUri, kickUri, finishUri) keeps the logical URL, not the file,
    // and the logical URL has no access token, so a refresh is not a swap.
    const local = line ? localLineAudio(sourceUri, line.ja) : null;
    try {
      player.replace({ uri: local ?? api.withUser(sourceUri) });
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
  // With the focus stage up, the line on screen is fetched at each of the
  // stage chip's speeds right after the next line, so the file a chip tap
  // asks for is local by the next play. The neighbours follow the speed
  // picked last, also one still waiting to land.
  useEffect(() => {
    if (!island || island.lines.length === 0) return;
    const t = setTimeout(() => {
      const n = island.lines.length;
      const order = [idx + 1, idx + 2, idx - 1, idx].map((i) => (i + n) % n);
      const version = `${island.speaker}-${generation}`;
      const at = ahead ?? speed;
      const item = (i: number, s: number) => {
        const l = island.lines[i]!;
        return { url: api.withUser(api.lineAudioUrl(island.id, l.idx, version, s, breathMs)), tag: l.ja };
      };
      const items = [...new Set(order)].map((i) => item(i, at));
      const chip = stageUp ? STAGE_SPEEDS.filter((s) => s !== at).map((s) => item(idx, s)) : [];
      // focus-stories: last, the line each cube neighbour opens on, at the speed it will open at, so a hop's
      // run starts on a local file.
      const hopAhead = hop.ahead.flatMap((n) => {
        const l = n.lines[resumeLine(peekLastLine(n.id), n.lines.length)];
        if (!l) return [];
        const s = peekRung(n.id)?.speed ?? getSettingsSync().defaultSpeed;
        return [{ url: api.withUser(api.lineAudioUrl(n.id, l.idx, `${n.speaker}-0`, s, breathMs)), tag: l.ja }];
      });
      prefetchLineAudio([...items.slice(0, 1), ...chip, ...items.slice(1), ...hopAhead]);
    }, 0);
    return () => clearTimeout(t);
  }, [island, idx, generation, speed, ahead, breathMs, stageUp, hop.ahead]);
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

  // Resolves once the source swap the last render asked for has loaded (a
  // status with a duration of its own), or after SPEED_LOAD_WAIT_MS.
  async function waitForSwap() {
    const from = loadedUri.current;
    const until = Date.now() + SPEED_LOAD_WAIT_MS;
    while (Date.now() < until) {
      await new Promise<void>((resolve) => setTimeout(resolve, 50));
      const s = latestStatus.current;
      if (loadedUri.current !== from && !swap.current && s.isLoaded && s.duration > 0) return;
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

  // Lock screen / notification text. A hidden sentence never shows the
  // Japanese, whether Blind hid it or a ladder pass did.
  function lockMeta(): AudioMetadata {
    const pos = t('player.lineOfTotal', { index: idx + 1, total: island!.lines.length });
    const artist = island!.title || t('player.island');
    const artworkUrl = lockArtwork();
    return hidden
      ? { title: pos, artist, artworkUrl }
      : { title: phrase.label ?? line!.ja, artist, albumTitle: pos, artworkUrl };
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
  const backgroundRef = useRef({ take, player, dropTake, endRun, echoRef, startAutoHold });
  useLayoutEffect(() => {
    backgroundRef.current = { take, player, dropTake, endRun, echoRef, startAutoHold };
  });
  useEffect(() => {
    const sub = AppState.addEventListener('change', (state) => {
      // auto-practice: the hold between islands pauses in the background and
      // starts over on return, so the chain never moves on unseen.
      if (state === 'active') {
        const next = pendingNextRef.current;
        if (next && !autoHoldRef.current && autoRunRef.current) backgroundRef.current.startAutoHold(next.id, next.kind);
        return;
      }
      if (state !== 'background') return;
      if (autoHoldRef.current) {
        clearTimeout(autoHoldRef.current);
        autoHoldRef.current = null;
      }
      const { take: t, player: p, dropTake: drop, endRun: stopE, echoRef } = backgroundRef.current;
      // The ladder stops the whole run on backgrounding, not just a take in
      // progress: the island is back at idle with Shadow in the dock.
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
  // finished" moment for a take and a line played from the Explain sheet. `status.currentTime` is native and keeps arriving with
  // the app in the background, unlike UI frames, so the word highlight's
  // extrapolated position must not be used here. `crossed` resets on a wrap (the
  // native loop) or a seek, and whenever the source swaps (the swap effect).
  const crossed = useRef(false);
  // The line under a take has ended. A ladder take stays open for its room
  // (the hook's lineFinished: the line × 1.6 + 1.5s from the mic opening),
  // then ends after the tail scheduleStop adds; any other take ends after the tail.
  function endTakeAfterLine() {
    if (isSpeakStep(echoRef.current)) ladderRef.current?.lineFinished();
    else take.scheduleStop();
  }
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
      endTakeAfterLine();
      return;
    }
    // Played from the Explain sheet or under the starter guide: once, then
    // parked at the top of the same line, whatever Repeat says. Advancing
    // would change the line, and a line change closes the sheet.
    if (playsOnce) {
      stopPlayback(player);
      void player.seekTo(0);
      scheduleAudioSessionRelease();
      return;
    }
  }

  // Every native status of the line player lands here, 20 times a second
  // while it plays, without rendering the screen (see useLineStatus). The
  // work is what used to run in effects keyed on the position, in the same
  // order, and only when the position, playing, duration or line end
  // actually changed, as those effects would.
  const lastTick = useRef<{ time: number; playing: boolean; duration: number; end: number } | null>(null);
  const tr = t; // onLineStatus below shadows t with the last tick
  function onLineStatus(s: AudioStatus) {
    // The player reports a failed load (offline, a server error) at once: say
    // so now, once per outage, instead of waiting out PENDING_PLAY_MS.
    if (s.error && !s.isLoaded && !audioFailShown.current) {
      audioFailShown.current = true;
      setPendingPlay(false);
      setError(tr('player.couldNotLoadIsland'));
    }
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
        endTakeAfterLine();
      }
      return;
    }
    // A speed picked during this play loads now, for the next play.
    const swapped = landSpeedAhead() !== null;
    // A finish that slips past the crossing stop above (or a 0s pause, which
    // has no crossing) still must not advance the line.
    if (playsOnce) {
      void player.seekTo(0);
      scheduleAudioSessionRelease();
      return;
    }
    // A ladder run: the hook takes the finish (a repeat, the next stage, or Compare's take).
    if (ladderRef.current?.active) {
      ladderRef.current.lineFinished();
      return;
    }
    if (phrase.span) return;
    playsDone.current += 1;
    if (playsDone.current < times || island.lines.length === 1) {
      if (playsDone.current >= times) playsDone.current = 0;
      // Same line again: the source stays the same, so the playWhenLoaded
      // effect never fires. Seek and play by hand instead.
      resetHighlight();
      if (swapped) {
        // The file at the picked speed starts as soon as it is swapped in.
        setPlayWhenLoaded(true);
        return;
      }
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

  // A new line or speed means new audio, so the panel, any drag selection and
  // the Explain thread (which is about the old line's sentence) no longer apply.
  // Called by every handler that changes the line or the speed, next to that
  // change, so React batches all of it into the change's one render.
  function resetForNewAudio() {
    resetPanel();
    setExplainOpen(false);
    setLadderMove(null);
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
    // A tap beside an open word popover closes it, like any popover.
    if (selected !== null) {
      closePanel();
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
    startDrag,
    dragTo,
    clearSelection,
    go,
    runLine,
    echoActive,
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
        l.startDrag(i);
      })
      .onUpdate((e) => {
        const l = live.current;
        const i = l.hitTest(e.x, e.y);
        if (i === null) return;
        l.dragTo(i);
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
        if (e.translationY < -40 || e.velocityY < -500) {
          // Mid-run the next line starts at its first pass.
          if (l.echoActive) l.runLine(l.idx + 1);
          else l.go(l.idx + 1);
        } else if (e.translationY > 40 || e.velocityY > 500) {
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
  // bl58-easy-for-me: E4's glide after an Easy tap: the card sinks into the water, the next line rises from the waterline.
  const glideY = useSharedValue(0);
  const glideOp = useSharedValue(1);
  const cardDragStyle = useAnimatedStyle(() => ({
    opacity: glideOp.value,
    transform: [
      { translateY: dragY.value + glideY.value },
      { scale: interpolate(Math.abs(dragY.value), [0, DRAG_LIMIT], [1, 0.99], Extrapolation.CLAMP) * (0.97 + 0.03 * glideOp.value) },
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
    // A hop lands on its cover: the stage under it is in place at once, no rise.
    if (openCoverUp(id) || hop.starts) {
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
  // The ladder stage's layer, over the header too: it rises with the scene as it did inside it.
  const stageInStyle = useAnimatedStyle(() => ({
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
  // The hop cover stands in for the loader while the island is in hand: the root loader would draw over it.
  const waitingForLines = (!island || (openHold && !hopCover)) && !error;
  // A layout effect, ahead of the reveal's below, so a reveal that starts in the same commit sees
  // the loader still drawn and waits out its fade.
  useLayoutEffect(() => {
    // Under a covering morph only the clear is sent: its landing worklet asks
    // for the loader if the player still waits then.
    // A morph that lands on its timer before ready clears the loader as it
    // ends, so a wait still going then asks for it again.
    if (waitingForLines && openCoverUp(id)) return afterCoverGone(id, () => requestLoader(true));
    requestLoader(waitingForLines);
  }, [id, waitingForLines]);
  useEffect(() => () => requestLoader(false), []);

  const contentReveal = useContentReveal({
    ready: !!line && !openHold,
    coveredAtMount,
    staged: morph === '1' && !reducedMotion,
  });
  const revealValues = contentReveal.values;
  const bottomInStyle = usePieceStyle(revealValues.dock, revealValues.rise);

  // The drag selection's popup Repeat button: same follow-up as picking a
  // phrase used to run, then the selection (and its popup) is done.
  function repeatSelection() {
    const span = dragSpan;
    clearDragSpan();
    if (offline) { // offline-islands
      setError(t('player.offlinePhrase'));
      return;
    }
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
    clearDragSpan();
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
    clearDragSpan();
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
  function go(target: number, keepPlaying = true) {
    // The line never changes under the Explain sheet (see openExplain).
    if (!island || explainOpen) return;
    const clamped = Math.max(0, Math.min(island.lines.length - 1, target));
    if (clamped === idx) return;
    // The ladder loads its new line quietly (`status` can still read playing
    // in the tick its stop lands): the stage's own count plays it.
    const wasActive = keepPlaying && (status.playing || pendingPlayRef.current);
    dropTake();
    // Leaving the line clears its phrase, and with it a take recorded on it.
    if (phrase.span) take.discardTake();
    stopPlayback(player);
    resetHighlight();
    resetForNewAudio();
    setPlayWhenLoaded(wasActive);
    landSpeedAhead();
    applyLadderNext();
    setEasyOffer(null); // bl58-easy-for-me
    setIdx(clamped);
  }

  const { glideTo, markEasy, unmarkEasy, easyChipAction } = useEasyMark({
    island, setIsland, idx, line, lineKnown, known, setKnown, setEasyOffer, setEasyDone, easyTimer, glideTimer, glideY, glideOp,
    reducedMotion, go, ladderActive: ladder.active, auto, guideOn, endRun, runLine, autoRunRef, autoIslandDone, t,
  });
  // A new run takes the offer with it.
  useEffect(() => {
    if (isActive(ladder.step)) setEasyOffer(null);
  }, [ladder.step]);
  // E4's quiet pill: a 26 pt face with a 44 pt hit area. The island card wraps it in the guide's anchor; the stage view draws it as is.
  // Memoised (D54): a fresh element every render would re-render the stage view with it.
  const hasLine = !!line;
  const easyChipButton = useMemo(
    () =>
      hasLine ? (
        <PressScale
          onPress={() => (lineKnown ? unmarkEasy(idx) : markEasy(idx))}
          hitSlop={{ top: 9, bottom: 9, left: 8, right: 8 }}
          accessibilityRole="button"
          accessibilityState={{ selected: lineKnown }}
          accessibilityLabel={lineKnown ? t('ladder.easyMarked') : t('ladder.easy')}
          style={[styles.easyChip, lineKnown && styles.easyChipOn]}>
          <Leaf size={14} />
          <Text style={styles.easyChipText}>{lineKnown ? t('ladder.easyMarked') : t('ladder.easy')}</Text>
        </PressScale>
      ) : null,
    [hasLine, lineKnown, idx, t, markEasy, unmarkEasy],
  );
  // Inside a run the neighbours restart it from their first pass.
  const next = () => (ladder.active ? runLine(idx + 1) : go(idx + 1));
  const prev = () => (ladder.active ? runLine(idx - 1) : go(idx - 1));

  // Starts the line fresh from the top, whether or not it was already
  // playing: shared by the ring's Play tap and a swipe down on the sentence.
  async function playFromTop() {
    // The source may still be waiting for the open morph's cover to go.
    loadSource();
    dropTake();
    // A restart mid-word fades the highlight in again from the top instead
    // of snapping the lit word off.
    resetHighlight();
    if (landSpeedAhead() !== null) {
      // A speed picked during the last play: its file starts once swapped in.
      stopPlayback(player);
      crossed.current = false;
      playsDone.current = 0;
      setPlayWhenLoaded(true);
      return;
    }
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
    clearDragSpan();
    if (active) {
      pausePlayback();
      return;
    }
    await playFromTop();
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

  // The Speed popover's ruler follows every step live; only used to update
  // the readout and the tile, never the audio.
  function pickSpeed(next: number) {
    speedTouched.current = true;
    setSpeedLive(next);
  }

  // The Speed ruler's settle and the focus stage's speed chip. A line playing
  // carries on from where it is: the player's rate takes it to the new speed
  // over the file it has, the highlight keeps its word, and the file rendered
  // at the new speed takes over at the next play (landSpeedAhead). A take
  // (or the mic opening for one) hears nothing change until its next play.
  // Otherwise the line is re-rendered now, and a play still waiting starts
  // once it is swapped in.
  function commitSpeed(next: number) {
    speedTouched.current = true;
    ladderEpoch.current += 1;
    ladderNext.current = null;
    setLadderMove(null);
    if (island) void setRungSpeed(island.id, next);
    setSpeedLive(next);
    if (take.phase === 'recording' || startingTake.current) {
      setAhead(next);
      return;
    }
    const s = latestStatus.current;
    const rate = next / speed;
    if (s.playing && s.isLoaded && Number.isFinite(rate) && rate >= RATE_MIN && rate <= RATE_MAX) {
      setAhead(next);
      player.setPlaybackRate(rate, 'high');
      setLiveRate(rate);
      aimEchoLine(s, true);
      return;
    }
    if (rateRef.current !== 1) {
      player.setPlaybackRate(1, 'high');
      setLiveRate(1);
    }
    setAhead(null);
    if (next === speed) return;
    const wasActive = s.playing || pendingPlayRef.current;
    // Only a rate the player cannot take reaches here playing: re-rendered from the top, as before.
    if (s.playing) stopPlayback(player);
    dropTake();
    setPlayWhenLoaded(wasActive);
    resetForNewAudio();
    setSpeed(next);
  }

  // A speed picked mid-play lands: the rate goes back to 1 and the file
  // rendered at that speed is loaded. Called where the next play starts or
  // the line stops (never under a playing line or a take). Returns the new
  // speed when the source changes, else null.
  function landSpeedAhead(): number | null {
    const next = speedAhead.current;
    if (next === null) return null;
    setAhead(null);
    if (rateRef.current !== 1) {
      player.setPlaybackRate(1, 'high');
      setLiveRate(1);
    }
    if (next === speed) return null;
    setSpeed(next);
    return next;
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
  async function beginRecording(
    mode: TakeMode,
    silent: boolean | 'auto' = false,
    room = false,
  ): Promise<{ silent: boolean } | null> {
    if (!line || startingTake.current) return null;
    startingTake.current = true;
    // A promise finally, not a try finally: the compiler does not lower those.
    const run = async () => {
      setPlayWhenLoaded(false);
      closePanel();
      clearDragSpan();
      // dropTake(), but waiting for the cancel: it stops a take still
      // recording and releases the session, and that must be done before the
      // new recorder is prepared rather than land under it.
      take.stopTake();
      stopPlayback(player);
      await take.cancel();
      // A speed picked mid-play that has not landed yet: the take runs over
      // the file at that speed at rate 1, so wait for it to load and time the
      // take from its own length.
      const landed = landSpeedAhead();
      if (landed !== null) await waitForSwap();
      const end = landed !== null ? lineEndOf(latestStatus.current.duration, breathSec) : lineEnd;
      await seekTop();
      // The spoken line's length (without the pad) is the watchdog's base: a
      // take that is never ended by the line stops itself a few seconds past it.
      // A calibration is always the whole line (calibrateSpeaker clears a
      // phrase first): the speaker profile is global and a slice is too short
      // to learn it from.
      const span = mode === 'calibrate' ? null : phrase.audio;
      // A ladder take (`room`) gets the ladder's room past the line instead.
      // The rate is 1 under a take (commitSpeed never changes it there), so
      // the file's length is the wall-clock length; divided anyway in case.
      const rate = rateRef.current > 0 && Number.isFinite(rateRef.current) ? rateRef.current : 1;
      const endSec = end / rate;
      const lineSec = room && endSec > 0 ? takeWatchSec(endSec) : endSec || undefined;
      const result = await take.startTake(lineSec, landed ?? speed, mode, takeLagMs, span, silent);
      if (!result) return null;
      crossed.current = false;
      if (!result.silent) startPlayback(player);
      return result;
    };
    return run().finally(() => {
      startingTake.current = false;
    });
  }

  // The take hook's message (microphone access off, the recorder failed, a save failed) was never
  // shown on the island: the alert sheet shows each new one once, when it lands.
  const shownTakeError = useRef(0);
  useEffect(() => {
    if (!take.error || take.errorSeq === shownTakeError.current) return;
    shownTakeError.current = take.errorSeq;
    void alertSheet(take.error);
  }, [take.error, take.errorSeq]);

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
  // A speed picked during a take loads once the take is over and the line is
  // quiet, so the next play (Compare, the final take) already has its file.
  const landAfterTake = useEffectEvent(() => {
    if (take.phase === 'recording' || startingTake.current || latestStatus.current.playing) return;
    landSpeedAhead();
  });
  useEffect(() => {
    landAfterTake();
  }, [take.phase]);

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

  // auto-practice: the island's last line finished. Hold on the next title,
  // then move on; the last island ends the chain.
  function autoIslandDone() {
    const place = autoPlaceOf(id);
    if (!autoRunRef.current || !place) return;
    void hapticSelection();
    const next = finishAutoIsland(id, 'shadowed');
    if (!next) {
      endChain();
      return;
    }
    setAutoUi({ at: place.at, total: place.total, next: next.nextTitle });
    startAutoHold(next.nextId, next.nextKind);
  }

  // auto-practice: (re)starts the hold on the next island's title.
  function startAutoHold(nextId: string, nextKind: api.SessionKind) {
    pendingNextRef.current = { id: nextId, kind: nextKind };
    if (autoHoldRef.current) clearTimeout(autoHoldRef.current);
    autoHoldRef.current = setTimeout(() => {
      autoHoldRef.current = null;
      pendingNextRef.current = null;
      goToIsland(nextId, nextKind);
    }, AUTO_NEXT_HOLD_MS);
  }

  function goToIsland(nextId: string, nextKind: api.SessionKind, hopped = false) {
    if (autoLeavingRef.current) return;
    autoLeavingRef.current = true;
    if (hopped && nextKind === 'island') {
      // A cube hop: the replace first, so the stage never fades out over the island chrome, and the next
      // island opens under its hop cover.
      router.replace({ pathname: '/island/[id]', params: { id: nextId, auto: '1', hop: '1' } });
      endRun();
      return;
    }
    endRun();
    closeSheetThen(() => router.replace(routeFor(nextId, nextKind)));
  }
  // focus-stories D3: what a committed cube turn calls, refreshed after every render (a turn is an event, never a render).
  useEffect(() => {
    hopActions.current = { endRun, goToIsland };
  });

  function endChain() {
    endRun();
    void hapticImpact(Haptics.ImpactFeedbackStyle.Medium);
    finishSession(true);
    closeSheetThen(plainBack);
  }

  // Drops the chain: the player carries on as a normal one.
  function dropChain() {
    if (!autoRunRef.current) return;
    if (autoHoldRef.current) {
      clearTimeout(autoHoldRef.current);
      autoHoldRef.current = null;
    }
    pendingNextRef.current = null; // auto-practice
    endAutoPractice();
    setAutoUi(null);
    autoRunRef.current = false;
  }

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
    // the rung the line is playing at.
    const rung = speed;
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

  async function removeIsland() {
    if (!island) return;
    dropChain(); // auto-practice
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
      void alertSheet(t('player.couldNotDelete'), e instanceof Error ? e.message : t('player.serverDidNotAnswer'));
    }
  }

  // The dock's settings tray: Repeat, Reading and Blind, each opening its own
  // popover. Opening one closes the others, and never touches playback.
  const repeatOpts = useMemo(() => ({ times, pauseMs }), [times, pauseMs]);
  const { trayPills, onSpeedChip } = useTrayPills({
    t,
    language: island?.language ?? 'ja',
    native: island?.native ?? 'en',
    readingMode,
    blind,
    englishShown,
    readingPopOpen,
    blindPopOpen,
    repeatPopOpen,
    setSpeedPopOpen,
    setRepeatPopOpen,
    setReadingPopOpen,
    setBlindPopOpen,
    repeat: repeatOpts,
  });
  const speedOn = Math.abs(speedLive - getSettingsSync().defaultSpeed) > 0.001;

  // A tapped transcript line jumps there and plays it, even from a paused
  // state (go alone would leave a paused line paused).
  function jumpToLine(i: number) {
    if (explainOpen) return;
    if (ladder.active) {
      runLine(i);
      return;
    }
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
  // The red button by state: start, start again, count, stop, or record.
  const onDockRecord = useStableHandler(() => {
    if (ladder.step === 'idle') {
      if (take.phase === 'recording') void toggle();
      else startRun();
      return;
    }
    if (ladder.step === 'done') {
      // Under the guide the run rests on done with the next line parked: Shadow
      // runs it. Elsewhere Start again is line 1.
      if (guideOn) startRun();
      else runLine(0);
      return;
    }
    // Stopping a take silences the line under it on the tap, not when the mic has closed.
    if (isSpeakStep(ladder.step) && take.phase === 'recording') stopPlayback(player);
    ladder.dock.onRecord();
  });
  const onPassHelp = useStableHandler(() => {
    setHelpPass(helpPassOf(ladder.step));
    setHelpOpen(true);
  });
  const onHelpClose = useStableHandler(() => setHelpOpen(false));
  const onClearPhrase = useStableHandler(clearPhrase);
  // The three sheets and the header are memoised; these keep their handler
  // props at one identity so a screen render does not render a closed sheet.
  const onEchoClose = useStableHandler(() => {
    dropChain(); // auto-practice
    endRun();
    setSheet(null);
  });
  // auto-practice: Skip moves on at once, Done leaves the finished chain.
  const onAutoSkip = useStableHandler(() => {
    if (!autoRunRef.current || autoLeavingRef.current) return;
    // During the hold this island is already recorded: Skip just cuts the hold short.
    const pending = pendingNextRef.current;
    if (pending) {
      if (autoHoldRef.current) {
        clearTimeout(autoHoldRef.current);
        autoHoldRef.current = null;
      }
      pendingNextRef.current = null;
      goToIsland(pending.id, pending.kind);
      return;
    }
    const place = autoPlaceOf(id);
    if (!place) return;
    const next = finishAutoIsland(id, 'skipped');
    if (next) goToIsland(next.nextId, next.nextKind);
    else endChain();
  });
  const onSheetDismissed = useStableHandler(runAfterSheet);
  const onMenuClose = useStableHandler(() => setSheet(null));
  const onMenuRename = useStableHandler((t: string) => closeSheetThen(() => void renameTitle(t)));
  const onMenuExport = useStableHandler(() => closeSheetThen(() => void exportNow()));
  const onMenuRevoice = useStableHandler(() => closeSheetThen(() => void doRevoice()));
  const onMenuRegenerate = useStableHandler(() => closeSheetThen(confirmRegenerate));
  const onMenuCalibrate = useStableHandler(() => closeSheetThen(() => void calibrateSpeaker()));
  const onMenuDrive = useStableHandler(() =>
    closeSheetThen(() => {
      stopPlayback(player);
      if (island) router.replace({ pathname: '/drive', params: { id: island.id, line: String(lineIdx) } });
    }),
  );
  // before-after
  const onMenuBeforeAfter = useStableHandler(() =>
    closeSheetThen(() => {
      stopPlayback(player);
      void player.seekTo(0);
      take.stopTake();
      if (island) router.push({ pathname: '/before-after', params: { id: island.id, idx: String(lineIdx) } });
    }),
  );
  const onMenuWatch = useStableHandler(() => // youtube-shadowing
    closeSheetThen(() => {
      stopPlayback(player);
      take.stopTake();
      if (island) router.push({ pathname: '/video/[id]', params: { id: island.id, line: String(lineIdx) } });
    }),
  );
  const onMenuListen = useStableHandler(() => // podcast-listen
    closeSheetThen(() => {
      stopPlayback(player);
      take.stopTake();
      if (island) router.push({ pathname: '/podcast/[id]', params: { id: island.id, line: String(lineIdx) } });
    }),
  );
  const onMenuDelete = useStableHandler(() => closeSheetThen(confirmDelete));
  const onExplainClose = useStableHandler(closeExplain);
  const onExplainPlay = useStableHandler(() => void playFromTop());
  const banner = useMemo(
    () =>
      error ? (
        <Pressable onPress={() => setError('')}>
          <Text style={[styles.inlineError, { color: tide.record }]}>{error}</Text>
        </Pressable>
      ) : offline ? ( // offline-islands
        <Text style={[{ fontFamily: fonts.ui, fontSize: 12, color: tide.textDim, textAlign: 'left' }, dir.text]}>{t('player.offlineBanner')}</Text>
      ) : undefined,
    [error, offline, t, dir.text],
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
  const total = take.phase === 'ready' ? (take.take?.score?.total ?? null) : null;
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
  const onHeaderTouch = useStableHandler(onSceneTouch);
  const onRepeatSelection = useStableHandler(repeatSelection);
  const onOpenExplain = useStableHandler(openExplain);
  const onCopySelection = useStableHandler(copySelection);
  const onBlockTouch = useCallback(() => {
    blockTouched.current = true;
  }, []);
  // Each word's box lands in wordBoxes at once, for the JS hit-testing.
  const onWordLayout = useStableHandler((i: number, e: LayoutChangeEvent) => {
    wordBoxes.current[i] = e.nativeEvent.layout;
  });

  const fit = useMemo(
    () => (line ? fitScale(line, blockWidth, { base: 22, min: 18, em: isJa ? 1 : 0.6 }) : 1),
    [line, blockWidth, isJa],
  );
  // The card is memo'd on these props, the same containment the useMemo had:
  // the chip element (memo'd on lineKnown) stands in for the old lineKnown dep.
  const sentence = line ? (
    <IslandSentenceCard
      line={line}
      blind={blind}
      hidden={hidden}
      readingMode={readingMode}
      isJa={isJa}
      isRtl={isRtl}
      isGrammar={isGrammar}
      highlight={highlight}
      selected={selected}
      dragSpan={dragSpan}
      phraseSpan={phrase.span}
      marks={marks}
      keptUp={keptUp}
      total={total}
      ladderNote={ladderNote}
      feedback={feedback}
      pitches={pitches}
      glossData={glossData}
      explainContext={explainContext}
      blockWidth={blockWidth}
      fit={fit}
      handleDragging={handleDragging}
      modeLine={modeLine}
      enFrosted={enFrosted}
      englishShown={englishShown}
      t={t}
      gesture={sentenceGesture}
      dragStyle={cardDragStyle}
      jaReveal={jaReveal}
      enReveal={enReveal}
      cardRef={cardAnchor.ref}
      onCardLayout={remeasureGuide}
      chipRef={chipAnchor.ref}
      onChipLayout={chipAnchor.onLayout}
      easyChip={easyChipButton}
      wordBoxes={wordBoxes}
      scrollRef={scrollRef}
      onBlockLayout={onBlockLayout}
      onBlockTouch={onBlockTouch}
      onTapEmpty={onTapEmpty}
      onWordLayout={onWordLayout}
      onGrabHandle={onGrabHandle}
      onDragHandle={onDragHandle}
      onReleaseHandle={onReleaseHandle}
      onHearWord={onHearWord}
      onClosePanel={onClosePanel}
      onRepeatSelection={onRepeatSelection}
      onOpenExplain={onOpenExplain}
      onCopySelection={onCopySelection}
    />
  ) : null;

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
    // bl57: the guide's island failed to load or play (the chevron came back): Home lights the + again, not nothing.
    if (guideOn && !guideLocked) setGuideStep('home');
    if (autoRunRef.current || autoUi) {
      // auto-practice: Back ends the chain and goes Home in one step.
      if (leavingRef.current) return;
      leavingRef.current = true;
      dropChain();
      endRun();
      plainBack();
      return;
    }
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
  // While a ladder stage shows, it covers this header: its own header carries back and the `?`.
  const header = (withMenu: boolean) => (
    <PlayerHeader
      id={id}
      title={headerTitleText}
      lineIndex={headerLineIndex}
      lineCount={headerLineCount}
      placeholder={!island && !error}
      background={sky.top}
      onBack={guideLocked ? null : onHeaderBack} // bl57-intro-round2
      onMenu={withMenu && !guideLocked ? onHeaderMenu : null} // bl57-intro-round2
      known={known.size} // bl58-easy-for-me
      onTouch={onHeaderTouch}
    />
  );

  // The scene's giant digit: the breath's countdown, or a listening stage's
  // count (a take's count rides the dock's button).
  const sceneCountdown = countdown ?? (ladder.prelude?.phase === 'count' && !isArmedStep(ladder.step) ? ladder.beat : null);
  // D54: the stage view is memoised, so its props are built once per change of what they read, not per render.
  // The hook's stage, with the island's status-driven fill (aimEchoLine, aimTakeFill: this player loads its
  // audio per line, so the hook's timed fill would drift), the word highlight, the Easy chip and the session's hold title.
  const stageHoldTitle = autoUi?.next ?? null;
  const stageProps = useMemo(
    () =>
      ladder.stage && {
        ...ladder.stage,
        fill: echoFill,
        highlight,
        chip: easyChipButton, // bl58-easy-for-me: E3, a mark ends the run
        easy: easyChipAction,
        // This player plays at its own rate (the hook runs at 1 here), so the speed chip and the sheet read
        // that one: the speed picked last, heard at once even before its file lands (commitSpeed).
        speed: speedLive,
        holdTitle: stageHoldTitle,
        onEnd: onEchoClose,
        onHelp: onPassHelp,
      },
    [ladder.stage, echoFill, highlight, easyChipButton, easyChipAction, speedLive, stageHoldTitle, onEchoClose, onPassHelp],
  );
  // bl58-easy-for-me (D55): the 90+ offer lives in the dock, which the opaque stage view covers, and Auto Echo holds the
  // run on Compare while it is up. The stage stays mounted and goes hidden for the offer's hold, so the bubble and the
  // choices show, and No brings the stage back with no fade.
  const stageCovers = stageProps !== null && easyOffer === null;
  // focus-stories: the hop cover, opaque and over the header, the scene and the stage, laid out as the stage
  // root lays out its page (under the top inset). TideScene waits under a hop until the cover drops (the
  // live stage has fitted, or the cover timed out): the stage hides it anyway, and its mount stays out of the landing.
  const hopFace =
    hopCover && !error ? (
      <View style={[StyleSheet.absoluteFill, styles.hopCover, { paddingTop: screenInsets.top }]} pointerEvents="none">
        <StagePreview id={id} />
      </View>
    ) : null;
  // Only the cover holds it: `hop.starts` stays true for the whole visit, so a stage test here would keep the
  // scene away once the run ends.
  const sceneDeferred = hop.starts && hopCover && !error;

  // What the floating dock covers at the scene's bottom: the dock and the
  // home indicator under it. The scene draws to the screen's edge, under the
  // dock, and keeps its waterline above it. Before the island loads there is
  // no dock yet, so the last dock height holds its place: the waterline sits
  // where it will once the lines land. The loading cat, if a wait is real, is
  // the root LoadingOverlay: nothing to render here.
  const dockSpace = dockH > 0 ? dockH : lastDockH;
  const dockCover = dockSpace + screenInsets.bottom;

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
      <View style={[styles.fill, { backgroundColor: sky.top }]}>
        <StatusBar style="light" />
        {header(true)}

        <Animated.View
          style={[styles.fill, sceneInStyle]}
          onLayout={(e) => {
            const w = e.nativeEvent.layout.width;
            anchorMoved(w !== playerW.current);
            playerW.current = w;
          }}>
          {sceneDeferred ? null : (
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
              bottomInset={dockCover}
            />
          )}
        </Animated.View>
        {hopFace}
      </View>
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

  // The red button by run state: the hook's dock, with two island overrides (see onDockRecord).
  const dockRun = ((): { label: string; face: 'dot' | 'count' | 'stop' | 'dim' } => {
    const d = ladder.dock;
    // A plain take (Record my take) records at idle: the button is its Stop.
    if (ladder.step === 'idle' && take.phase === 'recording') return { label: t('player.stopRecording'), face: 'stop' };
    // Under the guide a finished Compare parks the next line: the button runs it, not Start again on line 1.
    if (ladder.step === 'done' && guideOn) return { label: t('player.shadow'), face: d.face };
    return { label: d.recordLabel, face: d.face };
  })();

  const ringMode: RingMode = status.playing || pendingPlay ? (inBreath ? 'breath' : 'playing') : 'idle';

  core.current = { dropTake, setPlayWhenLoaded, resetForNewAudio, go, closePanel, endRun, playFromTop };

  return (
    <View style={[styles.fill, { backgroundColor: sky.top }]}>
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
        {sceneDeferred ? null : (
          <TideScene
            lineIndex={idx}
            lineCount={island.lines.length}
            lines={lines}
            blind={hidden}
            busy={status.playing || take.phase === 'recording' || sceneCountdown !== null || ladder.prelude !== null}
            countdown={sceneCountdown}
            banner={banner}
            sentence={sentence}
            below={below}
            pinned={grammarTag}
            scrollRef={scrollRef}
            onLineTap={onLineTap}
            instantReveal={coverUpNow}
            widenWhen={coveredAtMount ? widenTranscript : undefined}
            contentReveal={revealValues}
            initialHeight={Math.max(0, sceneEstimateH - dockSpace)}
            bottomInset={dockCover}
            onScrollSettled={guideOn ? remeasureGuide : undefined}
            scrollLocked={guideOn && guideLocked}
          />
        )}

        {/* bl58-easy-for-me: the reaction after a mark (E4 b) and the 90+ offer's bubble (E4 c), above the dock. */}
        {easyDone ? (
          // The count sits in the empty sky under the header, clear of the lines below the waterline.
          <View pointerEvents="none" style={[styles.easyToastTop, { top: screenInsets.top + 64 }]}>
            <View style={styles.easyToast}>
              <Leaf size={14} />
              <Text style={styles.easyToastText}>{t('ladder.alreadyYours', { count: easyDone.count })}</Text>
            </View>
          </View>
        ) : null}
        {easyDone || easyOffer !== null ? (
          <View pointerEvents="none" style={[styles.easyLayer, { bottom: dockCover + 4 }]}>
            <GuideBubble kind="proud" text={easyDone ? t('guide.easyDone') : t('guide.easyOffer')} width={330} />
          </View>
        ) : null}
        {trayOpen ? (
          <Pressable
            style={styles.trayBackdrop}
            onPress={() => setTrayOpen(false)}
            accessibilityLabel={t('player.dockSettings')}
          />
        ) : null}
        <View
          // Hidden, not only covered, while the stage view is up.
          style={[styles.dock, { bottom: screenInsets.bottom }, stageCovers && styles.underStage]}
          pointerEvents={stageCovers ? 'none' : 'box-none'}
          onLayout={(e) => {
            const { y, height } = e.nativeEvent.layout;
            anchorMoved(y !== dockY.current);
            if (guideOn && y !== dockY.current) bumpGuide((n) => n + 1);
            dockY.current = y;
            if (Number.isFinite(height) && height > 0) {
              // What the scene already holds for it: the last player's dock
              // height until this one's is set. Equal, nothing renders.
              const held = dockH > 0 ? dockH : lastDockH;
              lastDockH = height;
              if (Math.abs(held - height) > 0.5) setDockH(height);
            }
          }}>
          <Animated.View style={bottomInStyle} pointerEvents="box-none">
            {easyOffer !== null ? (
              <EasyOffer onYes={() => markEasy(easyOffer)} onNo={() => setEasyOffer(null)} />
            ) : (
            <CompactDock
              playMode={ringMode === 'idle' ? 'idle' : 'playing'}
              onToggle={onToggle}
              onPrev={onPrev}
              onNext={onNext}
              prevDisabled={idx === 0}
              nextDisabled={idx >= island.lines.length - 1}
              recording={take.phase === 'recording'}
              level={take.level}
              onRecord={onDockRecord}
              recordLabel={dockRun.label}
              // bl56-shadow-button
              stageIndex={ladder.dock.stageIndex}
              face={dockRun.face}
              countIn={ladder.dock.countIn}
              beatMs={ladder.dock.beatMs}
              ringDisabled={ladder.dock.ringDisabled}
              locked={echoActive}
              slot={
                // auto-practice: the hold on the next island's title; a tap moves on now.
                autoUi?.next && ladder.step === 'done' ? (
                  <PrismButton
                    shape="pill"
                    verb="listen"
                    flat
                    press="light"
                    label={t('player.autoNext', { title: autoUi.next })}
                    onPress={onAutoSkip}
                  />
                ) : undefined
              }
              speed={speedLive}
              speedOn={speedOn}
              onSpeed={onSpeedChip}
              pills={trayPills}
              trayOpen={trayOpen}
              onTrayToggle={() => setTrayOpen((v) => !v)}
              onAnchor={onAnchor}
            />
            )}
          </Animated.View>
        </View>
        {playerW.current > 0 ? (
          <DockPopovers
            dock={dock}
            width={playerW.current}
            language={island?.language ?? 'ja'}
            native={island?.native ?? 'en'}
            speed={speedLive}
            onSpeed={pickSpeed}
            onSpeedSettle={commitSpeed}
            repeat={{ times, pauseMs, onTimes: pickTimes, onPause: pickPause, onPauseSettle: commitPause }}
          />
        ) : null}
      </Animated.View>

      {/* The stage covers the island's header as well (its own header has back and the `?`): one header on screen.
          The header stays laid out under it, so the scene never shifts when the stage comes or goes. */}
      {stageProps ? (
        <Animated.View style={[StyleSheet.absoluteFill, stageInStyle]} pointerEvents="box-none" onTouchStart={onSceneTouch}>
          <LadderStageView {...stageProps} top={0} ownsHeader followsReveal hidden={easyOffer !== null} still={hopCover} onFitted={onStageFitted} />
        </Animated.View>
      ) : null}
      {/* A cube hop lands on the still stage face it turned to, over everything, until the live stage has fitted under it. */}
      {hopFace}

      <PassHelpSheet
        open={helpOpen}
        pass={helpPass}
        learning={island?.language ?? 'ja'}
        understood={island?.native ?? 'en'}
        onClose={onHelpClose}
      />
      <IslandMenuSheet
        open={sheet === 'island'}
        onClose={onMenuClose}
        onDismissed={onSheetDismissed}
        title={island.title}
        complexity={island.complexity}
        busy={revoicing || regenerating}
        offline={offline} // offline-islands
        recording={take.phase === 'recording'}
        exporting={exporting}
        revoiceName={voice !== null && island.speaker !== voice ? voiceName || t('player.chosenVoice') : null}
        recorded={(island.source ?? 'voice') === 'voice'} // night-wave
        onRename={onMenuRename}
        onExport={onMenuExport}
        onBeforeAfter={onMenuBeforeAfter} // before-after
        onDrive={beta && (island as { has_audio?: boolean }).has_audio !== false ? onMenuDrive : undefined}
        onWatch={island.source === 'youtube' ? onMenuWatch : undefined} // youtube-shadowing
        onListen={island.source === 'podcast' ? onMenuListen : undefined} // podcast-listen
        onRevoice={onMenuRevoice}
        onRegenerate={island.source_name === 'say' ? undefined : onMenuRegenerate} // say-it: re-said, not rewritten
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
      {guideOn && guideLocked ? (
        <IslandGuide
          anchors={anchors}
          dockY={dockY}
          sceneTop={screenInsets.top + HEADER_ROW_H}
          playing={ringMode !== 'idle'}
          echoStep={ladder.step}
          stageActive={stageCovers}
        />
      ) : null}
    </View>
  );
}

/** The dock's height the last time a player laid it out, so the next open
 * can hold its place before the lines (and the dock) arrive. 0 until then. */
let lastDockH = 0;

const styles = StyleSheet.create({
  fill: { flex: 1 },
  // Above the stage's own layer (zIndex 20): the stage fits under it.
  hopCover: { zIndex: 40, elevation: 40, backgroundColor: tideSkies.night[0] },
  center: { alignItems: 'center', justifyContent: 'center' },
  scroll: { padding: Spacing.xl, gap: Spacing.lg, flexGrow: 1, justifyContent: 'center' },
  gTag: {
    alignSelf: 'flex-start',
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    height: 30,
    paddingLeft: 5,
    paddingRight: 12,
    borderRadius: 15,
    backgroundColor: 'rgba(185,166,255,0.16)',
  },
  // Hebrew: the tag sits on the right edge, its level chip first from the right.
  gTagRtl: { alignSelf: 'flex-end', flexDirection: 'row-reverse', paddingLeft: 12, paddingRight: 5 },
  gChip: { height: 20, paddingHorizontal: 7, borderRadius: 10, justifyContent: 'center', backgroundColor: 'rgba(185,166,255,0.28)' },
  gChipText: { fontFamily: fonts.uiMedium, fontSize: 11, fontWeight: '700', color: GRAMMAR_LILAC },
  gTagText: { fontFamily: fonts.uiMedium, fontSize: 12.5, fontWeight: '600', color: GRAMMAR_LILAC, flexShrink: 1 },
  // bl58-easy-for-me: E4's pill, counter, toast and offer. Mint is verb.along (#3DDC97, #9AEFC9).
  easyChip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    height: 26,
    paddingHorizontal: 10,
    borderRadius: 13,
    backgroundColor: 'rgba(61,220,151,0.12)',
    borderWidth: 1,
    borderColor: 'rgba(61,220,151,0.45)',
    borderTopColor: 'rgba(255,255,255,0.25)',
  },
  easyChipOn: { backgroundColor: 'rgba(61,220,151,0.14)' },
  easyChipText: { fontFamily: fonts.uiMedium, fontSize: 12, fontWeight: '600', color: verb.along.c2 },
  easyLayer: { position: 'absolute', left: 0, right: 0, alignItems: 'center', zIndex: 17 },
  easyToastTop: { position: 'absolute', left: 0, right: 0, alignItems: 'center', zIndex: 17 },
  easyToast: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    height: 38,
    paddingHorizontal: 16,
    borderRadius: 19,
    backgroundColor: 'rgba(61,220,151,0.16)',
    borderWidth: 1,
    borderColor: 'rgba(61,220,151,0.55)',
    marginBottom: 6,
  },
  easyToastText: { fontFamily: fonts.uiMedium, fontSize: 14, fontWeight: '600', color: '#C9F7E0' },
  // Above the tray backdrop (15) so the pills and the gear take taps; popovers sit at 20.
  // Floats over the scene's bottom: only the capsule, the tray and the slot draw.
  underStage: { opacity: 0 },
  dock: { position: 'absolute', left: 0, right: 0, zIndex: 16 },
  trayBackdrop: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, zIndex: 15 },
  body: { fontSize: 15, lineHeight: 22, textAlign: 'center', padding: Spacing.xl },
  inlineError: { fontSize: 13, lineHeight: 18, textAlign: 'center' },
  retry: { paddingVertical: Spacing.md, paddingHorizontal: Spacing.xxl, borderRadius: Radius.pill, marginTop: Spacing.md },
  secondaryBtn: { paddingVertical: Spacing.md, marginTop: Spacing.sm },
  retryText: { fontSize: 15, fontWeight: '700' },
});
