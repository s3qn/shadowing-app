import { Stack, useFocusEffect, useLocalSearchParams, useRouter } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Linking, StyleSheet, Text, useWindowDimensions, View } from 'react-native';
import type { LayoutChangeEvent } from 'react-native';
import type { ScrollView } from 'react-native-gesture-handler';
import { SafeAreaView } from 'react-native-safe-area-context';
import YoutubePlayer, { type YoutubeIframeRef } from 'react-native-youtube-iframe';

import { CatConstellation } from '@/components/cat-constellation';
import { PrismButton } from '@/components/prism';
import { ExplainSheet } from '@/components/explain-sheet';
import { BlindPopover } from '@/components/tide/blind-popover';
import { BottomRow } from '@/components/tide/bottom-row';
import { READING_LABEL_KEY, ReadingPopover } from '@/components/tide/reading-popover';
import { RepeatPopover, repeatTileLabel } from '@/components/tide/repeat-popover';
import { speedLabel, SpeedPopover } from '@/components/tide/speed-popover';
import { Toolbar, type ToolbarItem } from '@/components/tide/toolbar';
import { BlindIcon, ReadingIcon, RepeatIcon, SpeedIcon } from '@/components/tide/toolbar-icons';
import { TappableSentence, type ExplainSelection } from '@/components/tide/tappable-sentence';
import { TideScene } from '@/components/tide/tide-scene';
import { fonts } from '@/constants/fonts';
import { Radius, Spacing, tide, verb } from '@/constants/theme';
import type { RingMode } from '@/components/ring-button';
import { useTake } from '@/hooks/use-take';
import { useVideoHighlight } from '@/hooks/use-video-highlight';
import * as api from '@/lib/api';
import { useT } from '@/lib/i18n';
import {
  getSettingsSync,
  setBlind as persistBlind,
  setReading as persistReading,
  TIMES_MAX,
  type ReadingMode,
} from '@/lib/settings';
import { watchUrl } from '@/lib/youtube';

const LANG_CODE: Record<string, string> = {
  ja: 'JP',
  es: 'ES',
  en: 'EN',
  he: 'HE',
};
type TileBox = { x: number; y: number; width: number };
/** YouTube only plays these rates: quarter steps from 0.25 to 2. */
const snapRate = (v: number) => Math.min(2, Math.max(0.25, Math.round(v * 4) / 4));

/** The video on top, the Tide scene under it: water, the current line on the waterline with tappable words, the other lines faded around it. */
export default function VideoScreen() {
  const { t } = useT();
  const router = useRouter();
  const { width } = useWindowDimensions();
  const { id, line, preview } = useLocalSearchParams<{
    id: string;
    line?: string;
    preview?: string;
  }>();

  const [island, setIsland] = useState<api.Island | null>(null);
  const [video, setVideo] = useState<api.IslandVideo | null>(null);
  const [error, setError] = useState('');
  const [playing, setPlaying] = useState(false);
  const [cannotPlay, setCannotPlay] = useState(false);

  const playerRef = useRef<YoutubeIframeRef>(null);
  const scrollRef = useRef<ScrollView>(null);
  const lines = island?.lines ?? [];
  const sceneLines = useMemo(() => lines.map((l) => l.ja), [lines]);
  const [explainOpen, setExplainOpen] = useState(false);
  const [explainSpan, setExplainSpan] = useState<ExplainSelection['span'] | null>(null);
  const [explainMarked, setExplainMarked] = useState<string[]>([]);
  const [explainWhole, setExplainWhole] = useState(false);
  const [generation, setGeneration] = useState(0);

  // Dock state, the same shape as the audio player's. Speed starts at 1x: it
  // is a video, not the practice default.
  const [speedLive, setSpeedLive] = useState(1);
  // The embed's rate, set only when the Speed ruler settles.
  const [rate, setRate] = useState(1);
  const [times, setTimes] = useState(() => getSettingsSync().defaultTimes);
  const [pauseMs, setPauseMs] = useState(() => getSettingsSync().defaultPauseMs);
  const [readingMode, setReadingMode] = useState<ReadingMode>(() => getSettingsSync().reading);
  const [blind, setBlind] = useState(() => getSettingsSync().blind);
  const [englishShown, setEnglishShown] = useState(() => !getSettingsSync().hideEnglish);
  const [speedPopOpen, setSpeedPopOpen] = useState(false);
  const [repeatPopOpen, setRepeatPopOpen] = useState(false);
  const [readingPopOpen, setReadingPopOpen] = useState(false);
  const [blindPopOpen, setBlindPopOpen] = useState(false);
  const speedTile = useRef<TileBox | null>(null);
  const repeatTile = useRef<TileBox | null>(null);
  const readingTile = useRef<TileBox | null>(null);
  const blindTile = useRef<TileBox | null>(null);
  const dockY = useRef(0);
  const popOpenRef = useRef(false);
  popOpenRef.current = speedPopOpen || repeatPopOpen || readingPopOpen || blindPopOpen;
  const [, bumpAnchors] = useState(0);
  const anchorMoved = useCallback((moved: boolean) => {
    if (moved && popOpenRef.current) bumpAnchors((n) => n + 1);
  }, []);

  useEffect(() => {
    if (preview) return;
    let alive = true;
    Promise.all([api.getIsland(id), api.getIslandVideo(id)])
      .then(([i, v]) => {
        if (!alive) return;
        setIsland(i);
        setVideo(v);
      })
      .catch((e) => alive && setError(e instanceof Error ? e.message : t('video.loadFailed')));
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, preview]);

  const { highlight, activeLine, onChangeState, onPlaybackRateChange, seekToLine } = useVideoHighlight(
    playerRef,
    lines,
    video?.start_s ?? 0,
  );

  // Captions-only videos have no reference audio on the server, so takes are
  // only saved and played back (the embed is the reference).
  const take = useTake(island?.id, activeLine, generation, undefined, undefined, { localOnly: true });
  const takeRef = useRef(take);
  takeRef.current = take;

  // The video stops when this screen loses focus (Shadow, Watch back and forth).
  useFocusEffect(
    useCallback(
      () => () => {
        setPlaying(false);
        void takeRef.current.cancel();
      },
      [],
    ),
  );

  // A take that ends stops the embed too.
  const recording = take.phase === 'recording';
  useEffect(() => {
    if (!recording) return;
    return () => setPlaying(false);
  }, [recording]);

  // Repeat. A manual jump sets `manual` and refills the count; when the line
  // advances by itself, a count or a pause left holds the video, then replays
  // the line that just ended or carries on to the next.
  const manual = useRef(true);
  const loopLeft = useRef(0);
  const prevLine = useRef(activeLine);
  const loopTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    loopLeft.current = Math.max(0, times - 1);
  }, [times]);
  useEffect(
    () => () => {
      if (loopTimer.current) clearTimeout(loopTimer.current);
    },
    [],
  );
  useEffect(() => {
    const from = prevLine.current;
    prevLine.current = activeLine;
    if (loopTimer.current) {
      clearTimeout(loopTimer.current);
      loopTimer.current = null;
    }
    if (manual.current || activeLine !== from + 1 || !playing) {
      manual.current = false;
      loopLeft.current = Math.max(0, times - 1);
      return;
    }
    const replay = loopLeft.current > 0;
    if (!replay && pauseMs <= 0) {
      loopLeft.current = Math.max(0, times - 1);
      return;
    }
    if (replay) loopLeft.current -= 1;
    else loopLeft.current = Math.max(0, times - 1);
    setPlaying(false);
    loopTimer.current = setTimeout(() => {
      loopTimer.current = null;
      if (replay) {
        manual.current = true;
        seekToLine(from);
      }
      setPlaying(true);
    }, pauseMs);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeLine]);

  const jump = useCallback(
    (i: number) => {
      manual.current = true;
      seekToLine(i);
      setPlaying(true);
    },
    [seekToLine],
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

  const onReady = useCallback(() => {
    const n = Number(line);
    if (line !== undefined && Number.isFinite(n)) seekToLine(Math.max(0, Math.floor(n)));
  }, [line, seekToLine]);

  const onToggle = () => {
    if (loopTimer.current) {
      clearTimeout(loopTimer.current);
      loopTimer.current = null;
    }
    setPlaying((v) => !v);
  };
  const onPrev = () => jump(Math.max(0, activeLine - 1));
  const onNext = () => jump(Math.min(lines.length - 1, activeLine + 1));
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
    take.stopTake();
    const start = lines[activeLine]?.offset;
    const nextStart = lines[activeLine + 1]?.offset;
    const lineSec = start !== undefined && nextStart !== undefined ? nextStart - start : undefined;
    jump(activeLine);
    const res = await take.startTake(lineSec, speedLive, 'take', 0, null, 'auto');
    if (!res || res.silent) setPlaying(false);
  }

  const toolbarItems = useMemo((): ToolbarItem[] => {
    const repeatOn = times > 1 || pauseMs > 0;
    const speedOn = Math.abs(speedLive - 1) > 0.001;
    const readingOn = readingMode !== 'off';
    const lang = island?.language ?? 'ja';
    const items: ToolbarItem[] = [
      {
        key: 'speed',
        icon: <SpeedIcon color={speedOn ? verb.listen.c1 : tide.textDim} size={22} />,
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
          const { x, y, width: w } = e.nativeEvent.layout;
          const old = speedTile.current;
          speedTile.current = { x, y, width: w };
          anchorMoved(!old || old.x !== x || old.y !== y || old.width !== w);
        },
      },
      {
        key: 'repeat',
        icon: <RepeatIcon color={repeatOn ? verb.listen.c1 : tide.textDim} size={22} />,
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
          const { x, y, width: w } = e.nativeEvent.layout;
          const old = repeatTile.current;
          repeatTile.current = { x, y, width: w };
          anchorMoved(!old || old.x !== x || old.y !== y || old.width !== w);
        },
      },
      {
        key: 'reading',
        icon: <ReadingIcon color={readingOn ? verb.listen.c1 : tide.textDim} size={22} />,
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
          const { x, y, width: w } = e.nativeEvent.layout;
          const old = readingTile.current;
          readingTile.current = { x, y, width: w };
          anchorMoved(!old || old.x !== x || old.y !== y || old.width !== w);
        },
      },
      {
        key: 'blind',
        icon: <BlindIcon color={blind || !englishShown ? verb.listen.c1 : tide.textDim} size={22} />,
        label: t('player.toolbarBlind'),
        value:
          blind && !englishShown
            ? t('player.blindBoth')
            : blind
              ? LANG_CODE[lang]
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
          const { x, y, width: w } = e.nativeEvent.layout;
          const old = blindTile.current;
          blindTile.current = { x, y, width: w };
          anchorMoved(!old || old.x !== x || old.y !== y || old.width !== w);
        },
      },
    ];
    return items.filter((item) => lang === 'ja' || item.key !== 'reading');
  }, [t, speedLive, times, pauseMs, readingMode, blind, englishShown, anchorMoved, island]);

  const onDockLayout = (e: LayoutChangeEvent) => {
    const { y } = e.nativeEvent.layout;
    anchorMoved(y !== dockY.current);
    dockY.current = y;
  };
  const ringMode: RingMode = playing ? 'playing' : 'idle';

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
      <SafeAreaView edges={['bottom']} style={[styles.fill, { backgroundColor: tide.sky[0] }]}>
        <StatusBar style="light" />
        <Stack.Screen options={{ title: '' }} />
        {cannotPlay ? (
          <View style={[styles.center, { width, height: (width * 9) / 16, flex: 0 }]}>
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
          <YoutubePlayer
            height={(width * 9) / 16}
            width={width}
            videoId={preview}
            play={playing}
            initialPlayerParams={{
              controls: true,
              rel: false,
              modestbranding: true,
            }}
            onChangeState={(s: string) => setPlaying(s === 'playing')}
            onError={() => setCannotPlay(true)}
          />
        )}
        <View style={styles.center}>
          <Text style={styles.hint}>{t('video.noTranscript')}</Text>
        </View>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView edges={['bottom']} style={[styles.fill, { backgroundColor: tide.sky[0] }]}>
      <StatusBar style="light" />
      <Stack.Screen options={{ title: island?.title ?? '' }} />
      {error ? (
        <View style={styles.center}>
          <Text style={styles.error}>{error}</Text>
        </View>
      ) : !island || !video ? (
        <View style={styles.center}>
          <CatConstellation size={120} />
        </View>
      ) : (
        <>
          {cannotPlay ? (
            <View style={[styles.center, { width, height: (width * 9) / 16 }]}>
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
            <YoutubePlayer
              ref={playerRef}
              height={(width * 9) / 16}
              width={width}
              videoId={video.video_id}
              play={playing}
              playbackRate={rate}
              initialPlayerParams={{
                start: Math.floor(video.start_s),
                controls: true,
                rel: false,
                modestbranding: true,
              }}
              onReady={onReady}
              onChangeState={(s: string) => {
                setPlaying(s === 'playing');
                onChangeState(s);
              }}
              onPlaybackRateChange={onPlaybackRateChange}
              onError={() => setCannotPlay(true)}
            />
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
                    />
                  ) : null
                }
                scrollRef={scrollRef}
                onLineTap={onLineTap}
              />
              {lines.length === 0 ? (
                <View style={[StyleSheet.absoluteFill, styles.center]} pointerEvents="none">
                  <Text style={styles.hint}>{t('video.noTranscript')}</Text>
                </View>
              ) : null}
            </View>
            {take.error ? <Text style={styles.error}>{take.error}</Text> : null}
            {lines.length > 0 ? (
              <>
                <View style={styles.bottom}>
                  {video.captions_only ? null : (
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
                <View style={styles.dock} onLayout={onDockLayout}>
                  <Toolbar items={toolbarItems} />
                  <BottomRow
                    ringMode={ringMode}
                    onToggle={onToggle}
                    onPrev={onPrev}
                    onNext={onNext}
                    prevDisabled={activeLine === 0}
                    nextDisabled={activeLine >= lines.length - 1}
                    recording={recording}
                    level={take.level}
                    onRecord={() => void onDockRecord()}
                  />
                </View>
              </>
            ) : null}
            {speedPopOpen && speedTile.current ? (
              <SpeedPopover
                anchorX={speedTile.current.x + speedTile.current.width / 2}
                anchorTop={dockY.current + speedTile.current.y}
                width={width}
                speed={speedLive}
                onSpeed={pickSpeed}
                onSettle={commitSpeed}
                onClose={() => setSpeedPopOpen(false)}
              />
            ) : null}
            {readingPopOpen && readingTile.current ? (
              <ReadingPopover
                anchorX={readingTile.current.x + readingTile.current.width / 2}
                anchorTop={dockY.current + readingTile.current.y}
                width={width}
                value={readingMode}
                onChange={pickReading}
                onClose={() => setReadingPopOpen(false)}
              />
            ) : null}
            {blindPopOpen && blindTile.current ? (
              <BlindPopover
                anchorX={blindTile.current.x + blindTile.current.width / 2}
                anchorTop={dockY.current + blindTile.current.y}
                width={width}
                jaHidden={blind}
                enHidden={!englishShown}
                onToggleJa={toggleBlind}
                onToggleEn={toggleEnglish}
                onClose={() => setBlindPopOpen(false)}
              />
            ) : null}
            {repeatPopOpen && repeatTile.current ? (
              <RepeatPopover
                anchorX={repeatTile.current.x + repeatTile.current.width / 2}
                anchorTop={dockY.current + repeatTile.current.y}
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
        </>
      )}
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
    </SafeAreaView>
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
  dock: {
    backgroundColor: 'rgba(0,0,0,0.18)',
    borderTopLeftRadius: Radius.lg,
    borderTopRightRadius: Radius.lg,
  },
});
