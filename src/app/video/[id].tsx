import { Stack, useFocusEffect, useLocalSearchParams, useRouter } from 'expo-router';
import * as ScreenOrientation from 'expo-screen-orientation';
import { StatusBar } from 'expo-status-bar';
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { AppState, BackHandler, Linking, Pressable, StyleSheet, Text, useWindowDimensions, View } from 'react-native';
import type { ScrollView } from 'react-native-gesture-handler';
import { SymbolView } from 'expo-symbols';
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';
import { Easing, cancelAnimation, useSharedValue, withTiming } from 'react-native-reanimated';
import YoutubePlayer, { type YoutubeIframeRef } from 'react-native-youtube-iframe';

import { CatConstellation } from '@/components/cat-constellation';
import { PrismButton } from '@/components/prism';
import { ExplainSheet } from '@/components/explain-sheet';
import { BlindPopover, blindValueLabel } from '@/components/tide/blind-popover';
import { CompactDock, DOCK_GOLD_INK, type DockPill } from '@/components/tide/compact-dock';
import { READING_LABEL_KEY, ReadingPopover } from '@/components/tide/reading-popover';
import { RepeatPopover, repeatTileLabel } from '@/components/tide/repeat-popover';
import { SpeedPopover } from '@/components/tide/speed-popover';
import { BlindIcon, ReadingIcon, RepeatIcon } from '@/components/tide/toolbar-icons';
import { TappableSentence, type ExplainSelection } from '@/components/tide/tappable-sentence';
import { TideScene } from '@/components/tide/tide-scene';
import { useListeningCat } from '@/components/cat/listening-cat';
import { SaveStar } from '@/components/save-star';
import { PassHelpSheet } from '@/components/tide/pass-help-sheet';
import { LadderHelpButton, LadderStageView } from '@/components/tide/ladder-stage';
import { fonts } from '@/constants/fonts';
import { Spacing, tide } from '@/constants/theme';
import { snapRate, takeWatchSec, type useLadder } from '@/hooks/use-ladder';
import { useDockPopovers } from '@/hooks/use-dock-popovers';
import { useLadderWiring } from '@/hooks/use-ladder-wiring';
import { autoPlaceOf, endAutoPractice } from '@/lib/auto-practice';
import { parsePick, pickBestBits } from '@/lib/best-bits';
import { confirmSheet } from '@/lib/confirm-sheet';
import { useSavedCards } from '@/hooks/use-saved-cards';
import { useTake } from '@/hooks/use-take';
import { useWatchClock } from '@/hooks/use-watch-clock';
import { playIntent, useVideoHighlight } from '@/hooks/use-video-highlight';
import * as api from '@/lib/api';
import { syncVideoAudio } from '@/lib/video-audio';
import { useT } from '@/lib/i18n';
import { getLastLine, resumeLine, setLastLine } from '@/lib/last-line';
import { getSettingsSync, TIMES_MAX } from '@/lib/settings';
import { CC_OFF_SCRIPT, PLAYER_BRIDGE_SCRIPT, fullscreenPlayerSize, watchUrl } from '@/lib/youtube';

/** The video on top, the Tide scene under it: water, the current line on the waterline with tappable words, the other lines faded around it. */
export default function VideoScreen() {
  const { t } = useT();
  const router = useRouter();
  const win = useWindowDimensions();
  const { id, line, preview, review, session, pick } = useLocalSearchParams<{
    id: string;
    line?: string;
    preview?: string;
    review?: string;
    session?: string;
    pick?: string;
  }>();
  // A practice session hops here with the lines the plan picked; a stale param with no live session is ignored.
  const [inSession] = useState(() => session === '1' && autoPlaceOf(id) !== null);
  useEffect(() => () => endAutoPractice(id), [id]); // leaving mid-session reports the lines done

  // Fullscreen is landscape. The layout only switches once the window has
  // actually rotated, so the player is never sized from stale portrait numbers.
  const [full, setFull] = useState(false);
  const fs = full && win.width > win.height;
  const playerSize = fs ? fullscreenPlayerSize(win) : { width: win.width, height: (win.width * 9) / 16 };
  const width = fs ? win.width - playerSize.width : win.width;

  useEffect(() => {
    void ScreenOrientation.lockAsync(
      full ? ScreenOrientation.OrientationLock.LANDSCAPE : ScreenOrientation.OrientationLock.PORTRAIT_UP,
    ).catch(() => undefined);
  }, [full]);

  useEffect(
    () => () => {
      void ScreenOrientation.lockAsync(ScreenOrientation.OrientationLock.PORTRAIT_UP).catch(() => undefined);
    },
    [],
  );

  useEffect(() => {
    if (!full) return;
    const sub = BackHandler.addEventListener('hardwareBackPress', () => {
      setFull(false);
      return true;
    });
    return () => sub.remove();
  }, [full]);

  const fullButton = (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={t(full ? 'video.exitFullscreen' : 'video.enterFullscreen')}
      onPress={() => setFull((f) => !f)}
      hitSlop={3}
      style={({ pressed }) => [styles.fullBtn, pressed && { opacity: 0.7 }]}>
      <SymbolView
        name={
          full
            ? { ios: 'arrow.down.right.and.arrow.up.left', android: 'fullscreen_exit' }
            : { ios: 'arrow.up.left.and.arrow.down.right', android: 'fullscreen' }
        }
        size={16}
        tintColor={tide.textDim}
      />
    </Pressable>
  );

  const [island, setIsland] = useState<api.Island | null>(null);
  const [video, setVideo] = useState<api.IslandVideo | null>(null);
  const [error, setError] = useState('');
  // review-deck: saved sentences of this island, line idx to card id.
  // "Shadow the best bits" hops here as a review of three picked lines.
  const picked = useMemo(() => parsePick(pick), [pick]);
  const { savedCards, saveError, reviewSet, loadReviewCards, toggleSaved, gradeOnce } = useSavedCards(island?.id, id, !!review, inSession, picked);
  const [playing, setPlaying] = useState(false);
  const stateRef = useRef('unstarted');
  const [cannotPlay, setCannotPlay] = useState(false);

  const playerRef = useRef<YoutubeIframeRef>(null);
  const scrollRef = useRef<ScrollView>(null);
  const lines = useMemo(() => {
    const all = island?.lines ?? [];
    return reviewSet ? all.filter((l) => reviewSet.idx.has(l.idx)) : all;
  }, [island, reviewSet]);
  const sceneLines = useMemo(() => lines.map((l) => l.ja), [lines]);
  const [generation, setGeneration] = useState(0);

  // Dock state, the same shape as the audio player's. Speed starts at the
  // Settings default (snapped to a rate the embed plays), never a rung.
  const [speedLive, setSpeedLive] = useState(() => snapRate(getSettingsSync().defaultSpeed));
  // The embed's rate, set only when the Speed ruler settles.
  const [rate, setRate] = useState(() => snapRate(getSettingsSync().defaultSpeed));
  const [times, setTimes] = useState(() => getSettingsSync().defaultTimes);
  const [pauseMs, setPauseMs] = useState(() => getSettingsSync().defaultPauseMs);
  const {
    explainOpen, setExplainOpen, explainSpan, explainMarked, explainWhole, openExplain,
    readingMode, blind, englishShown, pickReading, toggleBlind, toggleEnglish,
    speedPopOpen, setSpeedPopOpen, repeatPopOpen, setRepeatPopOpen, readingPopOpen, setReadingPopOpen, blindPopOpen, setBlindPopOpen,
    trayOpen, setTrayOpen, anchors, dockY, dockH, onAnchor, onDockLayout,
  } = useDockPopovers();
  const insets = useSafeAreaInsets();

  useEffect(() => {
    if (preview) return;
    let alive = true;
    Promise.all([api.getIsland(id), api.getIslandVideo(id), review ? api.listReviewCards(id) : null])
      .then(([i, v, cards]) => {
        if (!alive) return;
        if (cards) loadReviewCards(cards);
        setIsland(i);
        setVideo(v);
        // bl36-align: kick off forced alignment once, then poll below.
        if (v.align === '' || v.align === 'failed') {
          void syncVideoAudio(id, v.video_id).then((ok) => ok && alive && setAlignWait(true));
        } else if (v.align === 'queued' || v.align === 'running') setAlignWait(true);
      })
      .catch((e) => alive && setError(e instanceof Error ? e.message : t('video.loadFailed')));
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, preview]);

  // --- bl36-align ---
  // Poll while the server aligns the audio; reload the lines when it lands.
  const [alignWait, setAlignWait] = useState(false);
  useEffect(() => {
    if (!alignWait) return;
    let alive = true;
    const t0 = Date.now();
    const timer = setInterval(async () => {
      if (Date.now() - t0 > 15 * 60 * 1000) return setAlignWait(false);
      try {
        const v = await api.getIslandVideo(id);
        if (!alive) return;
        if (v.align === 'done') {
          setAlignWait(false);
          const i = await api.getIsland(id);
          if (alive) setIsland(i);
        } else if (v.align === 'failed' || v.align === 'closed') setAlignWait(false);
      } catch {}
    }, 5000);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [alignWait, id]);
  // --- /bl36-align ---

  // Repeat. The highlight clock stops at the end of each line and calls
  // onLineEnd before the next line shows: a count left seeks back to the
  // line's start, a pause holds the video with the line still on screen. A
  // manual jump and a new line refill the count.
  const loopLeft = useRef(0);
  const loopTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const secsTimer = useRef<ReturnType<typeof setInterval> | null>(null);
  const [repeatPass, setRepeatPass] = useState(1);
  const [secsLeft, setSecsLeft] = useState<number | null>(null);
  const ringProgress = useSharedValue(0);
  // Ring to rest and seconds cleared: a pause ended or was aborted.
  const endPauseUi = () => {
    if (secsTimer.current) {
      clearInterval(secsTimer.current);
      secsTimer.current = null;
    }
    cancelAnimation(ringProgress);
    ringProgress.value = 0;
    setSecsLeft(null);
  };
  const clearLoopTimer = () => {
    if (loopTimer.current) {
      clearTimeout(loopTimer.current);
      loopTimer.current = null;
    }
    endPauseUi();
  };
  const onLineEnd = (i: number) => {
    if (ladder.active) {
      setPlaying(false);
      ladder.lineFinished();
      return;
    }
    clearLoopTimer();
    const replay = loopLeft.current > 0;
    if (replay) loopLeft.current -= 1;
    setRepeatPass(replay ? times - loopLeft.current : times + 1);
    // Review: the line stays held at its end until Play.
    if (review && !replay) {
      setPlaying(false);
      return;
    }
    if (pauseMs <= 0) {
      // No pause: the embed keeps playing and only the position jumps back.
      if (replay) seekToLineRef.current(i);
      else releaseLineRef.current();
      return;
    }
    setPlaying(false);
    let secs = Math.ceil(pauseMs / 1000);
    setSecsLeft(secs);
    ringProgress.value = 1;
    ringProgress.value = withTiming(0, { duration: pauseMs, easing: Easing.linear });
    secsTimer.current = setInterval(() => {
      secs = Math.max(1, secs - 1);
      setSecsLeft(secs);
    }, 1000);
    loopTimer.current = setTimeout(() => {
      loopTimer.current = null;
      endPauseUi();
      if (replay) seekToLineRef.current(i);
      else releaseLineRef.current();
      setPlaying(true);
    }, pauseMs);
  };
  // A running ladder needs each line's end too, so it holds the line between passes.
  const [ladderOn, setLadderOn] = useState(false);
  const { highlight, activeLine, onChangeState, onPlaybackRateChange, seekToLine, releaseLine } = useVideoHighlight(
    playerRef,
    lines,
    video?.start_s ?? 0,
    { on: !!review || ladderOn || times > 1 || pauseMs > 0, onLineEnd, ownEnds: !!review },
  );
  const seekToLineRef = useRef(seekToLine);
  seekToLineRef.current = seekToLine;
  const releaseLineRef = useRef(releaseLine);
  releaseLineRef.current = releaseLine;

  // Captions-only videos have no reference audio on the server, so takes are
  // only saved and played back (the embed is the reference).
  const take = useTake(island?.id, lines[activeLine]?.idx ?? 0, generation, undefined, undefined, { localOnly: video?.captions_only !== false, countPass: true });
  const takeRef = useRef(take);
  takeRef.current = take;

  // The video stops when this screen loses focus (Shadow, Watch back and forth).
  const ladderRef = useRef<ReturnType<typeof useLadder> | null>(null);
  useFocusEffect(
    useCallback(
      () => () => {
        setPlaying(false);
        ladderRef.current?.stop();
        void takeRef.current.cancel();
      },
      [],
    ),
  );

  useEffect(() => {
    const sub = AppState.addEventListener('change', (state) => {
      // Not 'inactive': the first mic permission prompt sends it mid-take.
      if (state === 'background') ladderRef.current?.stop();
    });
    return () => sub.remove();
  }, []);

  const lineRef = useRef(activeLine);
  // Frozen while a ladder runs, so the highlight cannot move the ladder's line.
  if (!ladderRef.current?.active) lineRef.current = activeLine;
  const { ladder, helpOpen, setHelpOpen, helpPass, onPassHelp } = useLadderWiring({
    take, speedLive, lines, lineRef, ladderRef, island, activeLine, seekToLine, setRate, gradeOnce, session: inSession,
    onRecordStart: review ? 'ladder' : 'line',
    playLine: () => jump(lineRef.current),
    record: (snapped) => startLineTake(snapped),
    stop: () => setPlaying(false),
    resume: () => {
      // The record button's ladder is over: the video plays on from the next line.
      setRate(speedLive);
      const next = lineRef.current + 1;
      if (next < lines.length) jump(next);
    },
  });
  const openLadder = () => ladder.start();
  useEffect(() => setLadderOn(ladder.active), [ladder.active]);

  // Lines the viewer heard twice (a replay or a repeat), for the end-of-video offer.
  const seen = useRef(new Set<number>());
  const replayed = useRef(new Set<number>());
  useEffect(() => {
    const idx = lines[activeLine]?.idx;
    if (review || idx === undefined) return;
    if (seen.current.has(idx)) replayed.current.add(idx);
    else seen.current.add(idx);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeLine]);
  // The video ended in plain watch mode: offer the three easiest lines on the ladder, once per visit.
  const offered = useRef(false);
  const offerBestBits = () => {
    if (offered.current || review || preview || inSession || ladder.active || !island) return;
    const picks = pickBestBits(island.lines, new Set(savedCards.keys()), replayed.current);
    if (picks.length === 0) return;
    offered.current = true;
    const n = String(picks.length);
    void confirmSheet({
      title: t('video.bestBits.title', { n }),
      message: t('video.bestBits.body', { n }),
      actions: [{ label: t('video.bestBits.go', { n }), verb: 'speak' }, { label: t('video.bestBits.notNow'), verb: 'tools' }],
    }).then((i) => {
      if (i === 0) router.push({ pathname: '/video/[id]', params: { id, review: '1', pick: picks.join(',') } });
    });
  };

  // The cat that listens along (Rive only; hidden in fullscreen, under the stage view and with no transcript).
  const [saveTick, setSaveTick] = useState(0);
  const { cat: listeningCat, noteTouch } = useListeningCat({
    playing,
    line: lines[activeLine] ?? null,
    rate: speedLive,
    saved: savedCards.has(lines[activeLine]?.idx ?? -1),
    saveTick,
    hidden: fs || !!ladder.stage || lines.length === 0,
  });

  // A take that ends stops the embed too.
  const recording = take.phase === 'recording';
  useEffect(() => {
    if (!recording) return;
    return () => setPlaying(false);
  }, [recording]);

  // Watching earns practice time, wall clock while the embed plays.
  useWatchClock(island?.id, playing);

  useEffect(() => {
    loopLeft.current = Math.max(0, times - 1);
    setRepeatPass(1);
    endPauseUi();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [times, activeLine]);
  useEffect(
    () => () => {
      if (loopTimer.current) clearTimeout(loopTimer.current);
      if (secsTimer.current) clearInterval(secsTimer.current);
    },
    [],
  );

  const jump = useCallback(
    (i: number) => {
      clearLoopTimer();
      loopLeft.current = Math.max(0, times - 1);
      setRepeatPass(1);
      seekToLine(i);
      setPlaying(true);
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [seekToLine, times],
  );

  // A new line means the open Explain thread is about the old sentence.
  useEffect(() => {
    setExplainOpen(false);
    setGeneration((g) => g + 1);
  }, [activeLine]);

  const pauseVideo = useCallback(() => setPlaying(false), []);
  const onExplain = useCallback(
    (sel: ExplainSelection) => {
      setPlaying(false);
      openExplain(sel);
    },
    [openExplain],
  );
  const onExplainClose = useCallback(() => setExplainOpen(false), []);
  const onExplainPlay = useCallback(() => jump(activeLine), [jump, activeLine]);

  const ladderOpened = useRef(false);
  const openLadderRef = useRef(() => {});
  const onReady = useCallback(() => {
    const n = Number(line);
    if (line !== undefined && Number.isFinite(n)) {
      seekToLine(Math.max(0, Math.floor(n)));
      resumed.current = true;
      return;
    }
    if (review) {
      const first = lines.findIndex((l) => reviewSet?.due.has(l.idx));
      if (first > 0) seekToLine(first);
      resumed.current = true;
      if (lines.length > 0 && !ladderOpened.current) {
        ladderOpened.current = true;
        lineRef.current = Math.max(0, first);
        openLadderRef.current();
      }
      return;
    }
    void getLastLine(id).then((saved) => {
      const at = resumeLine(saved, lines.length);
      if (at > 0) seekToLine(at);
      resumed.current = true;
    });
  }, [line, id, lines, review, reviewSet, seekToLine]);
  // The ref keeps the mount's line 0 from overwriting the saved line before onReady has read it.
  const resumed = useRef(false);
  useEffect(() => {
    if (!review && resumed.current && lines.length > 0) setLastLine(id, activeLine);
  }, [id, activeLine, lines.length, review]);

  const repeat = useMemo(
    () =>
      times > 1 || pauseMs > 0
        ? { pass: Math.min(repeatPass, Math.max(1, times)), total: Math.max(1, times), progress: ringProgress, secsLeft }
        : undefined,
    [times, pauseMs, repeatPass, ringProgress, secsLeft],
  );

  const onToggle = () => {
    if (ladder.active) ladder.stop();
    // A tap during a Repeat pause carries on from the held line.
    clearLoopTimer();
    releaseLine();
    if (review) {
      if (playing) setPlaying(false);
      else jump(activeLine);
      return;
    }
    if (stateRef.current === 'ended') {
      jump(0);
      return;
    }
    setPlaying((v) => !v);
  };
  const onPrev = () => {
    if (ladder.active) ladder.stop();
    jump(Math.max(0, activeLine - 1));
  };
  const onNext = () => {
    if (ladder.active) ladder.stop();
    jump(Math.min(lines.length - 1, activeLine + 1));
  };
  const pickSpeed = (v: number) => setSpeedLive(v);
  const commitSpeed = (v: number) => {
    const snapped = snapRate(v);
    setSpeedLive(snapped);
    setRate(snapped);
  };
  const pickTimes = (n: number) => setTimes(Math.min(TIMES_MAX, n));

  // Stamps where the line starts in the take (see markLineStart), so a
  // headphone take, which has no echo for the backend to anchor on, still
  // gets its timing scored. The embed has no status stream, so its position
  // is asked for until one reply lands near the line's start, while it plays.
  const stampTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const takeRate = useRef(1);
  const stampLineStart = (tries = 20) => {
    if (stampTimer.current) clearTimeout(stampTimer.current);
    stampTimer.current = null;
    const p = playerRef.current;
    if (!p) return;
    const retry = () => {
      if (tries > 1) stampTimer.current = setTimeout(() => stampLineStart(tries - 1), 150);
    };
    const sent = Date.now();
    p.getCurrentTime()
      .then((time) => {
        const at = lineRef.current;
        const start = (video?.start_s ?? 0) + (lines[at]?.offset ?? 0);
        const next = lines[at + 1]?.offset;
        const sec = review || next === undefined ? (lines[at]?.duration ?? 0) : next - (lines[at]?.offset ?? 0);
        const r = takeRate.current > 0 ? takeRate.current : 1;
        const inLine = time - start;
        // Only a reply while playing and near the line's start counts: one
        // still carrying the pre-seek position, or a buffering stall at 0, is not it.
        if (stateRef.current !== 'playing' || !Number.isFinite(inLine) || inLine <= 0 || inLine >= Math.min(2, sec * 0.5)) {
          retry();
          return;
        }
        // Wall time from the line's start: track seconds at the take's rate,
        // plus half the round trip the reply spent coming back.
        takeRef.current.markLineStart(inLine / r + (Date.now() - sent) / 2000);
      })
      .catch(retry);
  };
  useEffect(
    () => () => {
      if (stampTimer.current) clearTimeout(stampTimer.current);
    },
    [],
  );

  // A ladder take: the embed is the reference and plays under the take,
  // like the island's Record my take. On the speaker the backend removes the
  // bleed and keeps any echo left out of the score. A captions-only video has
  // no server reference to clean against, so there the speaker stays silent.
  async function startLineTake(speed: number): Promise<boolean> {
    take.stopTake();
    const at = lineRef.current;
    const start = lines[at]?.offset;
    const nextStart = lines[at + 1]?.offset;
    const lineSec = review ? lines[at]?.duration : start !== undefined && nextStart !== undefined ? nextStart - start : undefined;
    // The watchdog wants wall-clock seconds: the line plays at `speed`, and
    // the take keeps the ladder's room after it (takeWatchSec).
    const wallSec = lineSec !== undefined && speed > 0 ? lineSec / speed : lineSec;
    takeRate.current = speed;
    const localOnly = video?.captions_only !== false;
    const res = await take.startTake(wallSec !== undefined && wallSec > 0 ? takeWatchSec(wallSec) : undefined, speed, 'take', 0, null, localOnly ? 'auto' : false);
    if (!res || res.silent) setPlaying(false);
    else {
      jump(at);
      stampLineStart();
    }
    return !!res;
  }
  openLadderRef.current = openLadder;

  const trayPills = useMemo((): DockPill[] => {
    const lang = island?.language ?? 'ja';
    const ink = (on: boolean) => (on ? DOCK_GOLD_INK : tide.textDim);
    const repeatOn = times > 1 || pauseMs > 0;
    const readingOn = readingMode !== 'off';
    const blindOn = blind || !englishShown;
    const open = (which: 'repeat' | 'reading' | 'blind') => () => {
      setSpeedPopOpen(false);
      setRepeatPopOpen(which === 'repeat' ? (v) => !v : false);
      setReadingPopOpen(which === 'reading' ? (v) => !v : false);
      setBlindPopOpen(which === 'blind' ? (v) => !v : false);
    };
    const pills: DockPill[] = [
      {
        key: 'repeat',
        icon: <RepeatIcon color={ink(repeatOn)} size={15} />,
        value: repeatTileLabel(t, times, pauseMs),
        on: repeatOn,
        selected: repeatPopOpen,
        onPress: open('repeat'),
      },
    ];
    if (lang === 'ja') {
      pills.push({
        key: 'reading',
        icon: <ReadingIcon color={ink(readingOn)} size={15} />,
        value: t(READING_LABEL_KEY[readingMode]),
        on: readingOn,
        selected: readingPopOpen,
        onPress: open('reading'),
      });
    }
    pills.push({
      key: 'blind',
      icon: <BlindIcon color={ink(blindOn)} size={15} />,
      value: blindValueLabel(t, blind, englishShown, lang, island?.native ?? 'en'),
      on: blindOn,
      selected: blindPopOpen,
      onPress: open('blind'),
    });
    return pills;
  }, [t, times, pauseMs, readingMode, blind, englishShown, island, repeatPopOpen, readingPopOpen, blindPopOpen]);

  const onSpeedChip = () => {
    setRepeatPopOpen(false);
    setReadingPopOpen(false);
    setBlindPopOpen(false);
    setSpeedPopOpen((v) => !v);
  };

  function shadow() {
    setPlaying(false);
    router.push({
      pathname: '/island/[id]',
      params: { id, line: String(activeLine) },
    });
  }

  const language = island?.language ?? 'ja';
  const ja = language === 'ja';

  /** The embed's slot: the player and the fullscreen button, or the open-in-YouTube fallback. */
  const embedFrame = (videoId: string, player: ReactNode) =>
    cannotPlay ? (
      <View style={[styles.center, { width: playerSize.width, height: playerSize.height, flex: 0 }]}>
        <Text style={styles.hint}>{t('video.cannotPlay')}</Text>
        <PrismButton
          shape="pill"
          verb="tools"
          flat
          press="light"
          label={t('video.openInYoutube')}
          onPress={() => void Linking.openURL(watchUrl(videoId))}
        />
      </View>
    ) : (
      <View style={{ width: playerSize.width, height: playerSize.height }}>
        {player}
        {fullButton}
      </View>
    );

  if (preview) {
    return (
      <SafeAreaView edges={fs ? [] : ['bottom']} style={[styles.fill, fs && styles.row, { backgroundColor: tide.sky[0] }]}>
        <StatusBar style="light" hidden={fs} />
        <Stack.Screen options={{ title: '', headerShown: !fs }} />
        {embedFrame(
          preview,
          <YoutubePlayer
            height={playerSize.height}
            width={playerSize.width}
            videoId={preview}
            play={playing}
            webViewProps={{ injectedJavaScript: PLAYER_BRIDGE_SCRIPT }}
            initialPlayerParams={{
              controls: false,
              rel: false,
              modestbranding: true,
            }}
            onChangeState={(s: string) => {
              stateRef.current = s;
              setPlaying((p) => playIntent(p, s));
            }}
            onError={() => setCannotPlay(true)}
          />,
        )}
        <View style={styles.center}>
          <Text style={styles.hint}>{t('video.noTranscript')}</Text>
        </View>
      </SafeAreaView>
    );
  }

  // The dock floats over the transcript's bottom, above the home indicator;
  // the transcript runs on under it to the screen's edge.
  const dockBottom = fs ? 0 : insets.bottom;
  // Sheets and the ladder's stage view are laid out for portrait, so leave fullscreen when one opens.
  useEffect(() => {
    if (helpOpen || explainOpen || ladder.active) setFull(false);
  }, [helpOpen, explainOpen, ladder.active]);

  return (
    <View style={[styles.fill, { backgroundColor: tide.sky[0] }]} onTouchStart={noteTouch}>
      <StatusBar style="light" hidden={fs} />
      <Stack.Screen
        options={{
          title: island?.title ?? '',
          headerShown: !fs,
          headerRight: ladder.stage && onPassHelp ? () => <LadderHelpButton onPress={onPassHelp} /> : undefined,
        }}
      />
      {error ? (
        <View style={styles.center}>
          <Text style={styles.error}>{error}</Text>
        </View>
      ) : !island || !video || (review && !reviewSet) ? (
        <View style={styles.center}>
          <CatConstellation size={120} />
        </View>
      ) : (
        <View style={[styles.fill, fs && styles.row]}>
          {embedFrame(video.video_id, (
            <>
          <View pointerEvents={lines.length === 0 ? 'auto' : 'none'}>
            <YoutubePlayer
              ref={playerRef}
              height={playerSize.height}
              width={playerSize.width}
              videoId={video.video_id}
              play={playing}
              playbackRate={rate}
              initialPlayerParams={{
                start: Math.floor(video.start_s),
                controls: lines.length === 0,
                rel: false,
                modestbranding: true,
                showClosedCaptions: false,
                iv_load_policy: 3,
              }}
              webViewProps={{ injectedJavaScript: PLAYER_BRIDGE_SCRIPT + CC_OFF_SCRIPT }}
              onReady={onReady}
              onChangeState={(s: string) => {
                stateRef.current = s;
                setPlaying((p) => playIntent(p, s));
                onChangeState(s);
                if (s === 'ended') offerBestBits();
                if (s === 'playing' && takeRef.current.phase === 'recording') stampLineStart();
              }}
              onPlaybackRateChange={onPlaybackRateChange}
              onError={() => setCannotPlay(true)}
            />
          </View>
          {lines.length > 0 ? (
            // The embed takes no touches while the dock drives it, so a tap
            // on the video goes through the same toggle as the dock's play.
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={playing ? t('player.stop') : t('player.play')}
              onPress={onToggle}
              style={StyleSheet.absoluteFill}
            />
          ) : null}
            </>
          ))}
          <View style={styles.fill}>
            <View style={styles.fill}>
              <TideScene
                lineIndex={activeLine}
                lineCount={lines.length}
                lines={sceneLines}
                blind={blind}
                busy={playing || ladder.prelude !== null}
                countdown={ladder.beat}
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
                      onInteract={pauseVideo}
                      readingMode={readingMode}
                      blind={blind}
                      englishShown={englishShown}
                      variant="video"
                      repeat={repeat}
                    />
                    <SaveStar saved={savedCards.has(lines[activeLine]!.idx)} onToggle={() => {
                        if (!savedCards.has(lines[activeLine]!.idx)) setSaveTick((n) => n + 1);
                        toggleSaved(lines[activeLine]!.idx);
                      }}
                    />
                    </View>
                  ) : null
                }
                scrollRef={scrollRef}
                onLineTap={jump}
                bottomInset={lines.length > 0 ? dockH + dockBottom : dockBottom}
              />
              {lines.length === 0 ? (
                <View style={[StyleSheet.absoluteFill, styles.center]} pointerEvents="none">
                  <Text style={styles.hint}>{t('video.noTranscript')}</Text>
                </View>
              ) : null}
            </View>
            {lines.length > 0 ? (
              <>
                {trayOpen && !fs ? (
                  <Pressable
                    style={[StyleSheet.absoluteFill, styles.trayBackdrop]}
                    onPress={() => setTrayOpen(false)}
                    accessibilityElementsHidden
                    importantForAccessibility="no"
                  />
                ) : null}
                <View
                  // Hidden, not only covered, while the stage view is up.
                  style={[styles.dock, { bottom: dockBottom }, ladder.stage && styles.underStage]}
                  onLayout={onDockLayout}
                  pointerEvents={ladder.stage ? 'none' : 'box-none'}>
                  <CompactDock
                    playMode={playing ? 'playing' : 'idle'}
                    onToggle={onToggle}
                    onPrev={onPrev}
                    onNext={onNext}
                    prevDisabled={activeLine === 0}
                    nextDisabled={activeLine >= lines.length - 1}
                    recording={recording}
                    level={take.level}
                    onRecord={ladder.dock.onRecord}
                    recordLabel={ladder.dock.recordLabel}
                    stageIndex={ladder.dock.stageIndex}
                    face={ladder.dock.face}
                    countIn={ladder.dock.countIn}
                    beatMs={ladder.dock.beatMs}
                    ringDisabled={ladder.dock.ringDisabled}
                    locked={ladder.active}
                    speed={speedLive}
                    speedOn={Math.abs(speedLive - snapRate(getSettingsSync().defaultSpeed)) > 0.001}
                    onSpeed={onSpeedChip}
                    pills={trayPills}
                    trayOpen={trayOpen}
                    onTrayToggle={() => setTrayOpen((v) => !v)}
                    compact={fs}
                    onAnchor={onAnchor}
                    slot={
                      <View style={styles.bottom} pointerEvents="box-none">
                        {take.error ? <Text style={styles.error}>{take.error}</Text> : null}
                        {saveError ? <Text style={styles.hint}>{saveError}</Text> : null}
                        {review || video.captions_only ? null : (
                          <PrismButton shape="pill" verb="speak" label={t('video.shadowLine')} onPress={shadow} />
                        )}
                        {listeningCat}
                      </View>
                    }
                  />
                </View>
              </>
            ) : null}
            {speedPopOpen && anchors.current.speed ? (
              <SpeedPopover
                anchorX={anchors.current.speed.x + anchors.current.speed.width / 2}
                anchorTop={dockY.current + anchors.current.speed.y}
                width={width}
                speed={speedLive}
                onSpeed={pickSpeed}
                onSettle={commitSpeed}
                onClose={() => setSpeedPopOpen(false)}
              />
            ) : null}
            {readingPopOpen && anchors.current.reading ? (
              <ReadingPopover
                anchorX={anchors.current.reading.x + anchors.current.reading.width / 2}
                anchorTop={dockY.current + anchors.current.reading.y}
                width={width}
                value={readingMode}
                onChange={pickReading}
                onClose={() => setReadingPopOpen(false)}
              />
            ) : null}
            {blindPopOpen && anchors.current.blind ? (
              <BlindPopover
                anchorX={anchors.current.blind.x + anchors.current.blind.width / 2}
                anchorTop={dockY.current + anchors.current.blind.y}
                width={width}
                jaHidden={blind}
                enHidden={!englishShown}
                onToggleJa={toggleBlind}
                onToggleEn={toggleEnglish}
                onClose={() => setBlindPopOpen(false)}
                lang={island?.language ?? 'ja'}
                native={island?.native ?? 'en'}
              />
            ) : null}
            {repeatPopOpen && anchors.current.repeat ? (
              <RepeatPopover
                anchorX={anchors.current.repeat.x + anchors.current.repeat.width / 2}
                anchorTop={dockY.current + anchors.current.repeat.y}
                width={width}
                times={times}
                pauseMs={pauseMs}
                onTimes={pickTimes}
                onPause={setPauseMs}
                onPauseSettle={setPauseMs}
                onClose={() => setRepeatPopOpen(false)}
              />
            ) : null}
          </View>
        </View>
      )}
      {/* Under the video, so it stays in view while the ladder runs. */}
      {ladder.stage ? <LadderStageView {...ladder.stage} highlight={highlight} top={fs ? 0 : playerSize.height} onHelp={onPassHelp} /> : null}
      {island ? (
        <PassHelpSheet
          open={helpOpen}
          pass={helpPass}
          learning={language}
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
  row: { flexDirection: 'row' },
  fullBtn: {
    position: 'absolute',
    top: 8,
    right: 8,
    width: 38,
    height: 38,
    borderRadius: 19,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(20,28,44,0.72)',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.12)',
  },
  center: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    gap: Spacing.lg,
    paddingHorizontal: 16,
  },
  error: {
    fontSize: 14,
    lineHeight: 20,
    color: tide.record,
    fontFamily: fonts.ui,
    textAlign: 'center',
  },
  hint: {
    fontSize: 14,
    lineHeight: 20,
    color: tide.textDim,
    fontFamily: fonts.ui,
    textAlign: 'center',
  },
  bottom: {
    alignItems: 'center',
    gap: Spacing.sm,
    paddingVertical: Spacing.sm,
  },
  slot: {
    backgroundColor: 'rgba(255,255,255,0.05)',
    borderBottomLeftRadius: 28,
    borderBottomRightRadius: 28,
    padding: 24,
    gap: 14,
  },
  // Above the tray backdrop (15) so the pills and the gear take taps; popovers sit at 20.
  // Floats over the transcript: only the capsule, the tray and the slot draw.
  underStage: { opacity: 0 },
  dock: { position: 'absolute', left: 0, right: 0, zIndex: 16 },
  trayBackdrop: { zIndex: 15 },
});
