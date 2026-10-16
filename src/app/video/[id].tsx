import { Stack, useFocusEffect, useLocalSearchParams, useRouter } from 'expo-router';
import * as ScreenOrientation from 'expo-screen-orientation';
import { StatusBar } from 'expo-status-bar';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { BackHandler, Linking, Pressable, StyleSheet, Text, useWindowDimensions, View } from 'react-native';
import type { LayoutChangeEvent } from 'react-native';
import type { ScrollView } from 'react-native-gesture-handler';
import { SymbolView } from 'expo-symbols';
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';
import { Easing, cancelAnimation, useSharedValue, withTiming } from 'react-native-reanimated';
import YoutubePlayer, { type YoutubeIframeRef } from 'react-native-youtube-iframe';

import { CatConstellation } from '@/components/cat-constellation';
import { PrismButton } from '@/components/prism';
import { ExplainSheet } from '@/components/explain-sheet';
import { BlindPopover, blindValueLabel } from '@/components/tide/blind-popover';
import { CompactDock, DOCK_GOLD_INK, type DockAnchor, type DockAnchorKey, type DockPill } from '@/components/tide/compact-dock';
import { READING_LABEL_KEY, ReadingPopover } from '@/components/tide/reading-popover';
import { RepeatPopover, repeatTileLabel } from '@/components/tide/repeat-popover';
import { SpeedPopover } from '@/components/tide/speed-popover';
import { BlindIcon, ReadingIcon, RepeatIcon } from '@/components/tide/toolbar-icons';
import { TappableSentence, type ExplainSelection } from '@/components/tide/tappable-sentence';
import { TideScene } from '@/components/tide/tide-scene';
import { SaveStar } from '@/components/save-star';
import { AutoEchoSheet } from '@/components/tide/auto-echo-sheet';
import { fonts } from '@/constants/fonts';
import { Spacing, tide } from '@/constants/theme';
import { snapRate, useLadder } from '@/hooks/use-ladder';
import { useTake } from '@/hooks/use-take';
import { useWatchClock } from '@/hooks/use-watch-clock';
import { playIntent, useVideoHighlight } from '@/hooks/use-video-highlight';
import * as api from '@/lib/api';
import { useT } from '@/lib/i18n';
import { getLastLine, resumeLine, setLastLine } from '@/lib/last-line';
import { textShownAt } from '@/lib/pass-programme';
import { addLadder } from '@/lib/practice';
import {
  getSettingsSync,
  setBlind as persistBlind,
  setReading as persistReading,
  TIMES_MAX,
  type ReadingMode,
} from '@/lib/settings';
import { CC_OFF_SCRIPT, PLAYER_BRIDGE_SCRIPT, fullscreenPlayerSize, watchUrl } from '@/lib/youtube';

type TileBox = { x: number; y: number; width: number };
/** YouTube only plays these rates: quarter steps from 0.25 to 2. */

/** The video on top, the Tide scene under it: water, the current line on the waterline with tappable words, the other lines faded around it. */
export default function VideoScreen() {
  const { t } = useT();
  const router = useRouter();
  const win = useWindowDimensions();
  const { id, line, preview, review } = useLocalSearchParams<{
    id: string;
    line?: string;
    preview?: string;
    review?: string;
  }>();

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
  // review-deck: saved sentences of this island, line idx to card id.
  const [savedCards, setSavedCards] = useState<Map<number, string>>(new Map());
  // Line idx already graded 'got' this session: a line repeated in the ladder grades once.
  const graded = useRef(new Set<number>());
  const [error, setError] = useState('');
  const [saveError, setSaveError] = useState('');
  const [playing, setPlaying] = useState(false);
  const stateRef = useRef('unstarted');
  const [cannotPlay, setCannotPlay] = useState(false);

  const playerRef = useRef<YoutubeIframeRef>(null);
  const scrollRef = useRef<ScrollView>(null);
  // Review mode: only the saved lines, frozen at load, due ones decide the start.
  const [reviewSet, setReviewSet] = useState<{ idx: Set<number>; due: Set<number> } | null>(null);
  const lines = useMemo(() => {
    const all = island?.lines ?? [];
    return reviewSet ? all.filter((l) => reviewSet.idx.has(l.idx)) : all;
  }, [island, reviewSet]);
  const sceneLines = useMemo(() => lines.map((l) => l.ja), [lines]);
  const [explainOpen, setExplainOpen] = useState(false);
  const [explainSpan, setExplainSpan] = useState<ExplainSelection['span'] | null>(null);
  const [explainMarked, setExplainMarked] = useState<string[]>([]);
  const [explainWhole, setExplainWhole] = useState(false);
  const [generation, setGeneration] = useState(0);

  // Dock state, the same shape as the audio player's. Speed starts at the
  // Settings default (snapped to a rate the embed plays), never a rung.
  const [speedLive, setSpeedLive] = useState(() => snapRate(getSettingsSync().defaultSpeed));
  // The embed's rate, set only when the Speed ruler settles.
  const [rate, setRate] = useState(() => snapRate(getSettingsSync().defaultSpeed));
  const [times, setTimes] = useState(() => getSettingsSync().defaultTimes);
  const [pauseMs, setPauseMs] = useState(() => getSettingsSync().defaultPauseMs);
  const [readingMode, setReadingMode] = useState<ReadingMode>(() => getSettingsSync().reading);
  const [blind, setBlind] = useState(() => getSettingsSync().blind);
  const [englishShown, setEnglishShown] = useState(() => !getSettingsSync().hideEnglish);
  const [speedPopOpen, setSpeedPopOpen] = useState(false);
  const [repeatPopOpen, setRepeatPopOpen] = useState(false);
  const [readingPopOpen, setReadingPopOpen] = useState(false);
  const [blindPopOpen, setBlindPopOpen] = useState(false);
  const [trayOpen, setTrayOpen] = useState(false);
  const anchors = useRef<Partial<Record<DockAnchorKey, TileBox>>>({});
  const dockY = useRef(0);
  // The floating dock's height: the transcript scrolls its last line clear
  // of it. State, set only on a real change.
  const [dockH, setDockH] = useState(0);
  const insets = useSafeAreaInsets();
  const popOpenRef = useRef(false);
  popOpenRef.current = speedPopOpen || repeatPopOpen || readingPopOpen || blindPopOpen;
  const [, bumpAnchors] = useState(0);
  const anchorMoved = useCallback((moved: boolean) => {
    if (moved && popOpenRef.current) bumpAnchors((n) => n + 1);
  }, []);
  const onAnchor = useCallback(
    (key: DockAnchorKey, box: DockAnchor) => {
      const old = anchors.current[key];
      anchors.current[key] = box;
      anchorMoved(!old || old.x !== box.x || old.y !== box.y || old.width !== box.width);
    },
    [anchorMoved],
  );

  useEffect(() => {
    if (preview) return;
    let alive = true;
    Promise.all([api.getIsland(id), api.getIslandVideo(id), review ? api.listReviewCards(id) : null])
      .then(([i, v, cards]) => {
        if (!alive) return;
        if (cards) {
          const today = new Date().toISOString().slice(0, 10);
          setSavedCards(new Map(cards.map((c) => [c.idx, c.id])));
          setReviewSet({ idx: new Set(cards.map((c) => c.idx)), due: new Set(cards.filter((c) => c.due_on <= today).map((c) => c.idx)) });
        }
        setIsland(i);
        setVideo(v);
      })
      .catch((e) => alive && setError(e instanceof Error ? e.message : t('video.loadFailed')));
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, preview]);

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
  const { highlight, activeLine, onChangeState, onPlaybackRateChange, seekToLine, releaseLine } = useVideoHighlight(
    playerRef,
    lines,
    video?.start_s ?? 0,
    { on: !!review || times > 1 || pauseMs > 0, onLineEnd, ownEnds: !!review },
  );
  const seekToLineRef = useRef(seekToLine);
  seekToLineRef.current = seekToLine;
  const releaseLineRef = useRef(releaseLine);
  releaseLineRef.current = releaseLine;

  useEffect(() => {
    if (!island || review) return;
    let alive = true;
    api
      .listReviewCards(island.id)
      .then((cards) => alive && setSavedCards(new Map(cards.map((c) => [c.idx, c.id]))))
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [island?.id]);

  const toggleSaved = useCallback(
    (idx: number) => {
      const existing = savedCards.get(idx);
      if (existing === 'pending') return;
      const setCard = (card: string | null) =>
        setSavedCards((m) => {
          const next = new Map(m);
          if (card) next.set(idx, card);
          else next.delete(idx);
          return next;
        });
      if (existing) {
        setCard('pending');
        api
          .removeReviewCard(existing)
          .then(() => {
            setCard(null);
            setSaveError('');
          })
          .catch((e) => {
            setCard(existing);
            setSaveError(e instanceof Error ? e.message : '');
          });
      } else {
        setCard('pending');
        api
          .saveReviewCard(id, idx)
          .then((c) => {
            setCard(c.id);
            setSaveError('');
          })
          .catch((e) => {
            setCard(null);
            setSaveError(e instanceof Error ? e.message : '');
          });
      }
    },
    [savedCards, id],
  );

  // Captions-only videos have no reference audio on the server, so takes are
  // only saved and played back (the embed is the reference).
  const take = useTake(island?.id, lines[activeLine]?.idx ?? 0, generation, undefined, undefined, { localOnly: true });
  const takeRef = useRef(take);
  takeRef.current = take;

  // The video stops when this screen loses focus (Shadow, Watch back and forth).
  const ladderRef = useRef<ReturnType<typeof useLadder> | null>(null);
  useFocusEffect(
    useCallback(
      () => () => {
        setPlaying(false);
        ladderRef.current?.stop();
        setLadderOpen(false);
        void takeRef.current.cancel();
      },
      [],
    ),
  );

  // Review mode runs the shadowing ladder on each saved line (the same passes
  // as the island); a finished ladder marks the card reviewed on its own.
  const [ladderOpen, setLadderOpen] = useState(false);
  const lineRef = useRef(activeLine);
  lineRef.current = activeLine;
  const ladder = useLadder(take, speedLive, lines[activeLine]?.duration ?? 0, {
    playLine: (speed) => {
      // The pass rate lives in `rate` only: speedLive stays the dock speed
      // the passes are taken from.
      const snapped = snapRate(speed);
      setRate(snapped);
      jump(lineRef.current);
    },
    record: (speed) => {
      const snapped = snapRate(speed);
      setRate(snapped);
      return startLineTake(snapped);
    },
    stop: () => {
      setPlaying(false);
      take.stopTake();
      void take.cancel();
      setRate(speedLive);
    },
    onLineDone: () => {
      const idx = lines[lineRef.current]?.idx ?? -1;
      const card = savedCards.get(idx);
      if (card && card !== 'pending' && !graded.current.has(idx)) {
        graded.current.add(idx);
        api.gradeReviewCard(card, 'got').catch(() => {});
      }
      if (island) addLadder(island.id);
    },
    advance: () => {
      const next = lineRef.current + 1;
      if (next >= lines.length) {
        setLadderOpen(false);
        router.back();
        return false;
      }
      seekToLine(next);
      lineRef.current = next;
      return true;
    },
  });
  ladderRef.current = ladder;
  // A finished ladder hands the player back at the dock speed.
  useEffect(() => {
    if (ladder.step === 'done') setRate(speedLive);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ladder.step]);
  const openLadder = () => {
    setLadderOpen(true);
    ladder.start();
  };

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
  const onLineTap = jump;
  const onExplain = useCallback((sel: ExplainSelection) => {
    setExplainMarked(sel.marked);
    setExplainWhole(sel.whole);
    setExplainSpan(sel.span);
    setPlaying(false);
    setExplainOpen(true);
  }, []);
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
  const pickReading = (mode: ReadingMode) => {
    setReadingMode(mode);
    persistReading(mode).catch(() => {});
  };
  const toggleBlind = () => {
    const next = !blind;
    setBlind(next);
    persistBlind(next).catch(() => {});
  };
  const toggleEnglish = () => setEnglishShown((v) => !v);
  const pickTimes = (n: number) => setTimes(Math.min(TIMES_MAX, n));

  // Record: the embed is the reference. With earphones it plays under the
  // take; on the speaker it stays silent so it never bleeds into the mic.
  async function onDockRecord() {
    if (take.phase === 'recording') {
      void take.finishNow();
      return;
    }
    if (review) {
      openLadder();
      return;
    }
    await startLineTake(speedLive);
  }

  async function startLineTake(speed: number): Promise<boolean> {
    take.stopTake();
    const at = lineRef.current;
    const start = lines[at]?.offset;
    const nextStart = lines[at + 1]?.offset;
    const lineSec = review ? lines[at]?.duration : start !== undefined && nextStart !== undefined ? nextStart - start : undefined;
    jump(at);
    // The watchdog wants wall-clock seconds: the line plays at `speed`.
    const wallSec = lineSec !== undefined && speed > 0 ? lineSec / speed : lineSec;
    const res = await take.startTake(wallSec, speed, 'take', 0, null, 'auto');
    if (!res || res.silent) setPlaying(false);
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

  const onDockLayout = (e: LayoutChangeEvent) => {
    const { y, height } = e.nativeEvent.layout;
    anchorMoved(y !== dockY.current);
    dockY.current = y;
    if (Number.isFinite(height) && height > 0) setDockH((old) => (Math.abs(old - height) > 0.5 ? height : old));
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

  if (preview) {
    return (
      <SafeAreaView edges={fs ? [] : ['bottom']} style={[styles.fill, fs && styles.row, { backgroundColor: tide.sky[0] }]}>
        <StatusBar style="light" hidden={fs} />
        <Stack.Screen options={{ title: '', headerShown: !fs }} />
        {cannotPlay ? (
          <View style={[styles.center, { width: playerSize.width, height: playerSize.height, flex: 0 }]}>
            <Text style={styles.hint}>{t('video.cannotPlay')}</Text>
            <PrismButton
              shape="pill"
              verb="tools"
              flat
              press="light"
              label={t('video.openInYoutube')}
              onPress={() => void Linking.openURL(watchUrl(preview))}
            />
          </View>
        ) : (
          <View style={{ width: playerSize.width, height: playerSize.height }}>
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
          />
          {fullButton}
          </View>
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
  return (
    <View style={[styles.fill, { backgroundColor: tide.sky[0] }]}>
      <StatusBar style="light" hidden={fs} />
      <Stack.Screen options={{ title: island?.title ?? '', headerShown: !fs }} />
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
          {cannotPlay ? (
            <View style={[styles.center, { width: playerSize.width, height: playerSize.height, flex: 0 }]}>
              <Text style={styles.hint}>{t('video.cannotPlay')}</Text>
              <PrismButton
                shape="pill"
                verb="tools"
                flat
                press="light"
                label={t('video.openInYoutube')}
                onPress={() => void Linking.openURL(watchUrl(video.video_id))}
              />
            </View>
          ) : (
            <View style={{ width: playerSize.width, height: playerSize.height }}>
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
            {fullButton}
            </View>
          )}
          <View style={styles.fill}>
            <View style={styles.fill}>
              <TideScene
                lineIndex={activeLine}
                lineCount={lines.length}
                lines={sceneLines}
                blind={blind}
                busy={playing}
                countdown={null}
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
                      repeat={
                        times > 1 || pauseMs > 0
                          ? { pass: Math.min(repeatPass, Math.max(1, times)), total: Math.max(1, times), progress: ringProgress, secsLeft }
                          : undefined
                      }
                    />
                    <SaveStar saved={savedCards.has(lines[activeLine]!.idx)} onToggle={() => toggleSaved(lines[activeLine]!.idx)} />
                    </View>
                  ) : null
                }
                scrollRef={scrollRef}
                onLineTap={onLineTap}
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
                <View style={[styles.dock, { bottom: dockBottom }]} onLayout={onDockLayout} pointerEvents="box-none">
                  <CompactDock
                    playMode={playing ? 'playing' : 'idle'}
                    onToggle={onToggle}
                    onPrev={onPrev}
                    onNext={onNext}
                    prevDisabled={activeLine === 0}
                    nextDisabled={activeLine >= lines.length - 1}
                    recording={recording}
                    level={take.level}
                    onRecord={() => void onDockRecord()}
                    recordLabel={recording ? t('player.stopRecording') : t('player.recordMyTake')}
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
                        {take.phase === 'ready' ? (
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
      {review && island && lines.length > 0 ? (
        <AutoEchoSheet
          open={ladderOpen}
          onClose={() => {
            ladder.stop();
            setLadderOpen(false);
          }}
          sentence={textShownAt(ladder.step, 'ladder') === false ? null : (lines[activeLine]?.ja ?? '')}
          english={englishShown ? (lines[activeLine]?.en ?? null) : null}
          native={island.native}
          language={language}
          moras={null}
          analysis={null}
          {...ladder.sheet}
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
  dock: { position: 'absolute', left: 0, right: 0, zIndex: 16 },
  trayBackdrop: { zIndex: 15 },
});
