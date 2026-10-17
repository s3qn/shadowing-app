import { useAudioPlayer } from 'expo-audio';
import * as Haptics from 'expo-haptics';
import { Stack, useFocusEffect, useLocalSearchParams, useRouter } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { SymbolView } from 'expo-symbols';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AppState, Pressable, StyleSheet, Text, useWindowDimensions, View } from 'react-native';
import type { ScrollView } from 'react-native-gesture-handler';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { CatConstellation } from '@/components/cat-constellation';
import { ExplainSheet } from '@/components/explain-sheet';
import { PressScale } from '@/components/press-scale';
import { PrismButton } from '@/components/prism';
import { BlindPopover, blindValueLabel } from '@/components/tide/blind-popover';
import { PassHelpSheet } from '@/components/tide/pass-help-sheet';
import { PassStrip } from '@/components/tide/pass-strip';
import { CompactDock, DOCK_GOLD_INK, type DockPill } from '@/components/tide/compact-dock';
import { READING_LABEL_KEY, ReadingPopover } from '@/components/tide/reading-popover';
import { SpeedPopover } from '@/components/tide/speed-popover';
import { BlindIcon, ReadingIcon } from '@/components/tide/toolbar-icons';
import { TappableSentence, type ExplainSelection } from '@/components/tide/tappable-sentence';
import { TideScene } from '@/components/tide/tide-scene';
import { SaveStar } from '@/components/save-star';
import { fonts } from '@/constants/fonts';
import { Spacing, tide } from '@/constants/theme';
import { snapRate, type useLadder } from '@/hooks/use-ladder';
import { useDockPopovers } from '@/hooks/use-dock-popovers';
import { useLadderWiring } from '@/hooks/use-ladder-wiring';
import { useSavedCards } from '@/hooks/use-saved-cards';
import { useTake } from '@/hooks/use-take';
import { usePracticeClock } from '@/hooks/use-practice-clock';
import { useTrackHighlight } from '@/hooks/use-track-highlight';
import * as api from '@/lib/api';
import { scheduleAudioSessionRelease, startPlayback, stopPlayback, useSessionPlayer } from '@/lib/audio-mode';
import { useT } from '@/lib/i18n';
import { hapticImpact, hapticSelection } from '@/lib/haptics';
import { getLastLine, resumeLine, setLastLine } from '@/lib/last-line';
import { COUNT_IN_BEATS, COUNT_IN_BEAT_MS } from '@/lib/pass-programme';
import { getSettingsSync } from '@/lib/settings';

type ShadowStep = 'idle' | 'count' | 'recording' | 'compare';

/** The track stops this far before a line's end. It has to stay above the
 * highlight's LEAD_CAP_S (0.25) so the extrapolated clock never crosses into the
 * next line and moves activeLine while a take runs. */
const STOP_EARLY_S = 0.35;
/** A stop point arms only after a status this far before it, so a late status
 * still carrying the pre-seek position cannot fire it. */
const STOP_ARM_S = 0.3;

type StopAt = { at: number; armAt: number; armed: boolean };

/** A podcast episode as one continuous track, the text flowing on its timeline. */
export default function PodcastScreen() {
  const { t } = useT();
  const router = useRouter();
  const { id, line, review } = useLocalSearchParams<{ id: string; line?: string; review?: string }>();

  const [island, setIsland] = useState<api.Island | null>(null);
  const [error, setError] = useState(false);
  // review-deck: saved sentences of this island, line idx to card id.
  const { savedCards, saveError, reviewSet, loadReviewCards, toggleSaved, gradeOnce } = useSavedCards(island?.id, id, !!review);
  const [loaded, setLoaded] = useState(false);
  const [playing, setPlaying] = useState(false);
  const [failed, setFailed] = useState(false);
  // Starts at the Settings default speed, never a rung.
  const [rate, setRate] = useState(() => snapRate(getSettingsSync().defaultSpeed));
  const [speedLive, setSpeedLive] = useState(() => snapRate(getSettingsSync().defaultSpeed));
  const { width: playerW } = useWindowDimensions();

  const player = useAudioPlayer(null, { updateInterval: 50, keepAudioSessionActive: true });
  useSessionPlayer(player);
  usePracticeClock(island?.id, player);

  const scrollRef = useRef<ScrollView>(null);
  const lines = useMemo(() => {
    const all = island?.lines ?? [];
    return reviewSet ? all.filter((l) => reviewSet.idx.has(l.idx)) : all;
  }, [island, reviewSet]);
  const sceneLines = useMemo(() => lines.map((l) => l.ja), [lines]);
  const { highlight, activeLine, seekToLine } = useTrackHighlight(player, lines);

  const [generation, setGeneration] = useState(0);
  const {
    explainOpen, setExplainOpen, explainSpan, explainMarked, explainWhole, openExplain,
    readingMode, blind, englishShown, pickReading, toggleBlind, toggleEnglish,
    speedPopOpen, setSpeedPopOpen, readingPopOpen, setReadingPopOpen, blindPopOpen, setBlindPopOpen,
    trayOpen, setTrayOpen, anchors, dockY, dockH, onAnchor, onDockLayout,
  } = useDockPopovers();
  const insets = useSafeAreaInsets();

  // In-place take: pause, count in, record the line, play it next to the original.
  // The line and generation are pinned while a take runs, so the highlight
  // drifting near the line's end cannot switch the take to the next line.
  const [shadowStep, setShadowStepState] = useState<ShadowStep>('idle');
  const [pin, setPinState] = useState<{ line: number; gen: number } | null>(null);
  const pinRef = useRef(pin);
  const setPin = useCallback((p: { line: number; gen: number } | null) => {
    pinRef.current = p;
    setPinState(p);
  }, []);
  const pinned = shadowStep !== 'idle' && pin !== null;
  const take = useTake(
    island?.id,
    lines[pinned ? pin.line : activeLine]?.idx ?? 0,
    pinned ? pin.gen : generation,
    undefined,
    undefined,
    { localOnly: true },
  );
  const takeRef = useRef(take);
  takeRef.current = take;
  const stepRef = useRef<ShadowStep>('idle');
  const setShadowStep = useCallback((s: ShadowStep) => {
    stepRef.current = s;
    setShadowStepState(s);
  }, []);
  const [countIn, setCountIn] = useState<number | null>(null);
  const countTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const stopAt = useRef<StopAt | null>(null);

  useEffect(() => {
    let alive = true;
    Promise.all([api.getIsland(id), review ? api.listReviewCards(id) : null])
      .then(([i, cards]) => {
        if (!alive) return;
        if (cards) loadReviewCards(cards);
        setIsland(i);
        player.replace({ uri: api.withUser(api.episodeAudioUrl(id)) });
      })
      .catch(() => alive && setError(true));
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  // One listener, coarse state only: a 50 ms status must not re-render this screen.
  const ended = useRef(false);
  const ladderRef = useRef<ReturnType<typeof useLadder> | null>(null);
  useEffect(() => {
    const sub = player.addListener('playbackStatusUpdate', (s) => {
      setLoaded(s.isLoaded);
      setPlaying(s.playing);
      setFailed(!!s.error);
      const stop = stopAt.current;
      if (stop && !stop.armed && s.currentTime < stop.armAt) stop.armed = true;
      // The last line has no next offset: the track can finish before the stop point.
      if (stop && stop.armed && (s.currentTime >= stop.at || s.didJustFinish)) {
        stopAt.current = null;
        stopPlayback(player);
        if (s.didJustFinish) ended.current = true;
        if (ladderRef.current?.active) {
          ladderRef.current.lineFinished();
          return;
        }
        if (stepRef.current === 'recording') takeRef.current.scheduleStop();
        else if (stepRef.current === 'compare') takeRef.current.playTake();
        return;
      }
      if (s.didJustFinish) {
        ended.current = true;
        setPlaying(false);
      }
    });
    return () => sub.remove();
  }, [player]);

  // Opens where the person left off, shared with the shadowing player.
  const started = useRef(false);
  const ladderOpened = useRef(false);
  const openLadderRef = useRef(() => {});
  const lineRef = useRef(0);
  const resuming = useRef(false);
  useEffect(() => {
    if (started.current || resuming.current || !loaded || lines.length === 0) return;
    if (review) {
      started.current = true;
      const first = lines.findIndex((l) => reviewSet?.due.has(l.idx));
      seekToLine(Math.max(0, first));
      if (!ladderOpened.current) {
        ladderOpened.current = true;
        lineRef.current = Math.max(0, first);
        openLadderRef.current();
      }
      return;
    }
    const n = Number(line);
    if (line !== undefined && Number.isFinite(n)) {
      started.current = true;
      seekToLine(Math.max(0, Math.min(Math.floor(n), lines.length - 1)));
      return;
    }
    // The flag flips only after the read, so the save effect below never
    // writes line 0 over the saved line.
    resuming.current = true;
    void getLastLine(id).then((saved) => {
      seekToLine(resumeLine(saved, lines.length));
      started.current = true;
    });
  }, [loaded, lines.length, line, id, seekToLine, review, reviewSet]);

  useEffect(() => {
    if (!review && started.current) setLastLine(id, activeLine);
    setExplainOpen(false);
    setGeneration((g) => g + 1);
  }, [id, activeLine, review]);

  useEffect(() => {
    if (loaded) player.setPlaybackRate(rate, 'high');
  }, [player, loaded, rate]);

  const pause = useCallback(() => {
    stopPlayback(player);
    scheduleAudioSessionRelease();
  }, [player]);

  const cancelShadow = useCallback(() => {
    if (countTimer.current) clearTimeout(countTimer.current);
    countTimer.current = null;
    setCountIn(null);
    stopAt.current = null;
    const t = takeRef.current;
    if (stepRef.current === 'recording' || t.phase === 'recording') void t.cancel();
    t.stopTake();
    setShadowStep('idle');
  }, [setShadowStep]);

  useFocusEffect(
    useCallback(
      () => () => {
        ladderRef.current?.stop();
        cancelShadow();
        stopPlayback(player);
        scheduleAudioSessionRelease();
      },
      [player, cancelShadow],
    ),
  );

  useEffect(() => {
    const sub = AppState.addEventListener('change', (state) => {
      // Not 'inactive': the first mic permission prompt sends it mid-take.
      if (state === 'background') cancelShadow();
    });
    return () => sub.remove();
  }, [cancelShadow]);

  /** The line a take runs on: the pinned one while a take is in progress. */
  const shadowLine = () => (stepRef.current !== 'idle' && pinRef.current ? pinRef.current.line : activeLine);
  const lineBounds = (i = shadowLine()) => {
    const l = lines[i];
    const start = l?.offset ?? 0;
    // In review the next line is not the next saved line, so use the duration.
    const end = (!review && lines[i + 1]?.offset) || start + (l?.duration ?? 0);
    return { start, end, sec: end - start };
  };
  const armStop = (i = shadowLine()) => {
    const { start, end } = lineBounds(i);
    const at = Math.max(start + 0.1, end - STOP_EARLY_S);
    // A line too short for the margin arms on any status near its start.
    stopAt.current = { at, armAt: Math.max(at - STOP_ARM_S, start + 0.05), armed: false };
  };

  async function beginTake() {
    const { sec } = lineBounds();
    setShadowStep('recording');
    // The watchdog wants wall-clock seconds: the line plays at `rate`.
    const res = await take.startTake(sec / rate, rate, 'take', 0, null, 'auto');
    if (stepRef.current !== 'recording') {
      if (res) void takeRef.current.cancel();
      return;
    }
    if (!res) {
      setShadowStep('idle');
      return;
    }
    if (!res.silent) {
      seekToLine(shadowLine());
      startPlayback(player);
      armStop();
    }
  }
  const beginRef = useRef(beginTake);
  beginRef.current = beginTake;

  function countBeat(n: number) {
    setCountIn(n);
    if (n < COUNT_IN_BEATS) void hapticSelection();
    countTimer.current = setTimeout(() => {
      countTimer.current = null;
      if (n > 1) {
        countBeat(n - 1);
        return;
      }
      setCountIn(null);
      void hapticImpact(Haptics.ImpactFeedbackStyle.Medium);
      void beginRef.current();
    }, COUNT_IN_BEAT_MS);
  }

  function startShadow() {
    take.stopTake();
    pause();
    ended.current = false;
    seekToLine(activeLine);
    setPin({ line: activeLine, gen: generation });
    setShadowStep('count');
    countBeat(COUNT_IN_BEATS);
  }

  // lineRef leads activeLine, which lags one render behind a seek.
  lineRef.current = activeLine;
  const { ladder, helpOpen, setHelpOpen, helpPass, onPassHelp } = useLadderWiring({
    take, speedLive, lines, lineRef, ladderRef, island, activeLine, seekToLine, setRate, gradeOnce,
    playLine: (snapped) => {
      player.setPlaybackRate(snapped, 'high');
      const at = lineRef.current;
      ended.current = false;
      seekToLine(at);
      startPlayback(player);
      armStop(at);
    },
    record: (snapped) => startLineTake(snapped),
    stop: () => {
      stopAt.current = null;
      stopPlayback(player);
    },
  });
  const openLadder = () => ladder.start();
  openLadderRef.current = openLadder;

  async function startLineTake(speed: number): Promise<boolean> {
    take.stopTake();
    const at = lineRef.current;
    const snapped = snapRate(speed);
    setRate(snapped);
    player.setPlaybackRate(snapped, 'high');
    const res = await take.startTake(lineBounds(at).sec / snapped, snapped, 'take', 0, null, 'auto');
    if (!res) return false;
    if (!res.silent) {
      ended.current = false;
      seekToLine(at);
      startPlayback(player);
      armStop(at);
    }
    return true;
  }

  const onRecord = () => {
    if (review) {
      ladder.dock.onRecord();
      return;
    }
    switch (shadowStep) {
      case 'idle':
        startShadow();
        break;
      case 'count':
        cancelShadow();
        break;
      case 'recording':
        void take.finishNow();
        break;
      case 'compare':
        stopPlayback(player);
        cancelShadow();
        break;
    }
  };

  // The recording ended: play the original line, then the take.
  useEffect(() => {
    if (take.phase !== 'ready' || stepRef.current !== 'recording') return;
    setShadowStep('compare');
    seekToLine(shadowLine());
    startPlayback(player);
    armStop();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [take.phase]);

  // The take finished playing: the track sits just before the next line.
  const wasTakePlaying = useRef(false);
  useEffect(() => {
    if (wasTakePlaying.current && !take.takePlaying && stepRef.current === 'compare') setShadowStep('idle');
    wasTakePlaying.current = take.takePlaying;
  }, [take.takePlaying, setShadowStep]);

  /** Plays one line from its start; in review it stops at the line's end. */
  const playLine = (i: number) => {
    cancelShadow();
    ended.current = false;
    seekToLine(i);
    startPlayback(player);
    if (review) armStop(i);
  };
  const toggle = () => {
    if (ladder.active) ladder.stop();
    if (shadowStep === 'idle' && playing) {
      pause();
      return;
    }
    if (review) {
      playLine(activeLine);
      return;
    }
    if (shadowStep !== 'idle') cancelShadow();
    if (ended.current) {
      ended.current = false;
      seekToLine(0);
    }
    startPlayback(player);
  };
  const playLineRef = useRef(playLine);
  playLineRef.current = playLine;
  const onLineTap = useCallback((i: number) => playLineRef.current(i), []);
  const onExplain = useCallback(
    (sel: ExplainSelection) => {
      cancelShadow();
      pause();
      openExplain(sel);
    },
    [pause, cancelShadow, openExplain],
  );
  const onExplainClose = useCallback(() => setExplainOpen(false), []);
  const onExplainPlay = useCallback(() => onLineTap(activeLine), [onLineTap, activeLine]);

  const onPrev = () => {
    if (ladder.active) ladder.stop();
    playLine(Math.max(0, activeLine - 1));
  };
  const onNext = () => {
    if (ladder.active) ladder.stop();
    playLine(Math.min(lines.length - 1, activeLine + 1));
  };
  const commitSpeed = (v: number) => {
    setSpeedLive(v);
    setRate(v);
  };
  const trayPills = useMemo((): DockPill[] => {
    const ink = (on: boolean) => (on ? DOCK_GOLD_INK : tide.textDim);
    const readingOn = readingMode !== 'off';
    const blindOn = blind || !englishShown;
    const pills: DockPill[] = [];
    if ((island?.language ?? 'ja') === 'ja') {
      pills.push({
        key: 'reading',
        icon: <ReadingIcon color={ink(readingOn)} size={15} />,
        value: t(READING_LABEL_KEY[readingMode]),
        on: readingOn,
        selected: readingPopOpen,
        onPress: () => {
          setSpeedPopOpen(false);
          setBlindPopOpen(false);
          setReadingPopOpen((v) => !v);
        },
      });
    }
    pills.push({
      key: 'blind',
      icon: <BlindIcon color={ink(blindOn)} size={15} />,
      value: blindValueLabel(t, blind, englishShown, island?.language ?? 'ja', island?.native ?? 'en'),
      on: blindOn,
      selected: blindPopOpen,
      onPress: () => {
        setSpeedPopOpen(false);
        setReadingPopOpen(false);
        setBlindPopOpen((v) => !v);
      },
    });
    return pills;
  }, [t, readingMode, blind, englishShown, island, readingPopOpen, blindPopOpen]);

  const onSpeedChip = () => {
    setReadingPopOpen(false);
    setBlindPopOpen(false);
    setSpeedPopOpen((v) => !v);
  };
  function shadow(withLine: boolean) {
    cancelShadow();
    stopPlayback(player);
    scheduleAudioSessionRelease();
    router.push({
      pathname: '/island/[id]',
      params: withLine ? { id, line: String(activeLine) } : { id },
    });
  }

  const language = island?.language ?? 'ja';

  // The dock floats over the transcript's bottom, above the home indicator;
  // the transcript runs on under it to the screen's edge.
  return (
    <View style={[styles.fill, { backgroundColor: tide.sky[0] }]}>
      <StatusBar style="light" />
      <Stack.Screen
        options={{
          title: island?.title ?? '',
          headerRight: () =>
            review ? null : (
            <PressScale
              onPress={() => shadow(true)}
              accessibilityRole="button"
              accessibilityLabel={t('podcast.shadowInstead')}
              style={styles.headerBtn}>
              <SymbolView name={{ ios: 'waveform', android: 'graphic_eq' }} size={22} tintColor={tide.text} />
            </PressScale>
          ),
        }}
      />
      {error || failed ? (
        <View style={styles.center}>
          <Text style={styles.hint}>{t('podcast.loadFailed')}</Text>
          <PrismButton shape="pill" verb="speak" label={t('podcast.shadowInstead')} onPress={() => shadow(false)} />
        </View>
      ) : !island || !loaded || (review && !reviewSet) ? (
        <View style={styles.center}>
          <CatConstellation size={120} />
        </View>
      ) : (
        <>
          <View style={styles.fill}>
            <TideScene
              lineIndex={activeLine}
              lineCount={lines.length}
              lines={sceneLines}
              blind={blind}
              busy={playing || take.phase === 'recording' || countIn !== null}
              countdown={countIn}
              sentence={
                lines[activeLine] ? (
                  <View style={styles.slot}>
                    <TappableSentence
                      key={lines[activeLine]!.idx}
                      line={lines[activeLine]!}
                      language={language}
                      native={island.native}
                      islandId={island.id}
                      highlight={highlight}
                      scrollRef={scrollRef}
                      onExplain={onExplain}
                      onInteract={pause}
                      readingMode={readingMode}
                      blind={blind}
                      englishShown={englishShown}
                    />
                    <SaveStar saved={savedCards.has(lines[activeLine]!.idx)} onToggle={() => toggleSaved(lines[activeLine]!.idx)} />
                  </View>
                ) : null
              }
              scrollRef={scrollRef}
              onLineTap={onLineTap}
              bottomInset={lines.length > 0 ? dockH + insets.bottom : insets.bottom}
            />
            {lines.length === 0 ? (
              <View style={[StyleSheet.absoluteFill, styles.center]} pointerEvents="none">
                <Text style={styles.hint}>{t('video.noTranscript')}</Text>
              </View>
            ) : null}
          </View>
          {lines.length > 0 ? (
            <>
              {trayOpen ? (
                <Pressable
                  style={[StyleSheet.absoluteFill, styles.trayBackdrop]}
                  onPress={() => setTrayOpen(false)}
                  accessibilityElementsHidden
                  importantForAccessibility="no"
                />
              ) : null}
              <View
                style={[styles.dock, { bottom: insets.bottom }]}
                pointerEvents="box-none"
                onLayout={onDockLayout}>
                <CompactDock
                  playMode={playing ? 'playing' : 'idle'}
                  onToggle={toggle}
                  onPrev={onPrev}
                  onNext={onNext}
                  prevDisabled={activeLine === 0}
                  nextDisabled={activeLine >= lines.length - 1}
                  recording={take.phase === 'recording'}
                  level={take.level}
                  onRecord={onRecord}
                  face={ladder.dock.face}
                  countIn={ladder.dock.countIn}
                  ringDisabled={ladder.dock.ringDisabled}
                  locked={ladder.active}
                  recordLabel={review ? ladder.dock.recordLabel : t(
                    shadowStep === 'count'
                      ? 'player.cancelCountIn'
                      : shadowStep === 'recording'
                        ? 'player.stopRecording'
                        : shadowStep === 'compare'
                          ? 'player.stop'
                          : 'player.recordMyTake',
                  )}
                  speed={speedLive}
                  speedOn={Math.abs(speedLive - snapRate(getSettingsSync().defaultSpeed)) > 0.001}
                  onSpeed={onSpeedChip}
                  pills={trayPills}
                  trayOpen={trayOpen}
                  onTrayToggle={() => setTrayOpen((v) => !v)}
                  onAnchor={onAnchor}
                  slot={
                    ladder.step !== 'idle' || take.error || saveError || take.phase === 'ready' ? (
                      <View style={styles.bottom} pointerEvents="box-none">
                        {ladder.step !== 'idle' ? <PassStrip {...ladder.strip} onHelp={onPassHelp} /> : null}
                        {take.error ? <Text style={styles.error}>{take.error}</Text> : null}
                        {saveError ? <Text style={styles.hint}>{saveError}</Text> : null}
                        {take.phase === 'ready' && ladder.step === 'idle' ? (
                          <PrismButton
                            shape="pill"
                            verb="listen"
                            flat
                            press="light"
                            label={t('video.playTake')}
                            onPress={() => (take.takePlaying ? take.stopTake() : take.playTake())}
                          />
                        ) : null}
                      </View>
                    ) : undefined
                  }
                />
              </View>
            </>
          ) : null}
          {speedPopOpen && anchors.current.speed ? (
            <SpeedPopover
              anchorX={anchors.current.speed.x + anchors.current.speed.width / 2}
              anchorTop={dockY.current + anchors.current.speed.y}
              width={playerW}
              speed={speedLive}
              onSpeed={setSpeedLive}
              onSettle={commitSpeed}
              onClose={() => setSpeedPopOpen(false)}
            />
          ) : null}
          {readingPopOpen && anchors.current.reading ? (
            <ReadingPopover
              anchorX={anchors.current.reading.x + anchors.current.reading.width / 2}
              anchorTop={dockY.current + anchors.current.reading.y}
              width={playerW}
              value={readingMode}
              onChange={pickReading}
              onClose={() => setReadingPopOpen(false)}
            />
          ) : null}
          {blindPopOpen && anchors.current.blind ? (
            <BlindPopover
              anchorX={anchors.current.blind.x + anchors.current.blind.width / 2}
              anchorTop={dockY.current + anchors.current.blind.y}
              width={playerW}
              jaHidden={blind}
              enHidden={!englishShown}
              onToggleJa={toggleBlind}
              onToggleEn={toggleEnglish}
              onClose={() => setBlindPopOpen(false)}
            />
          ) : null}
        </>
      )}
      {review && island ? (
        <PassHelpSheet
          open={helpOpen}
          pass={helpPass}
          learning={island.language ?? 'ja'}
          understood={island.native}
          onClose={() => setHelpOpen(false)}
        />
      ) : null}
      {island && lines.length > 0 ? (
        <ExplainSheet
          open={explainOpen}
          onClose={onExplainClose}
          sentenceJa={lines[activeLine]?.ja ?? ''}
          sentenceEn={lines[activeLine]?.en ?? ''}
          language={language}
          native={island.native}
          words={lines[activeLine]?.words ?? []}
          span={explainSpan}
          highlight={highlight}
          blind={blind}
          marked={explainMarked}
          whole={explainWhole}
          generation={generation}
          onPlaySentence={onExplainPlay}
        />
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1 },
  center: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    gap: Spacing.lg,
    paddingHorizontal: 16,
  },
  hint: {
    fontSize: 14,
    lineHeight: 20,
    color: tide.textDim,
    fontFamily: fonts.ui,
    textAlign: 'center',
  },
  slot: { position: 'relative' },
  bottom: { alignItems: 'center', gap: Spacing.sm },
  headerBtn: { width: 44, height: 44, alignItems: 'center', justifyContent: 'center' },
  error: {
    fontSize: 14,
    lineHeight: 20,
    color: tide.record,
    fontFamily: fonts.ui,
    textAlign: 'center',
    paddingHorizontal: 16,
  },
  // Above the tray backdrop (15) so the pills and the gear take taps; popovers sit at 20.
  // Floats over the transcript: only the capsule, the tray and the slot draw.
  dock: { position: 'absolute', left: 0, right: 0, zIndex: 16 },
  trayBackdrop: { zIndex: 15 },
});
