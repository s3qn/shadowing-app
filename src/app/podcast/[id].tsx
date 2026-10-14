import { useAudioPlayer } from 'expo-audio';
import { Stack, useFocusEffect, useLocalSearchParams, useRouter } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import type { ScrollView } from 'react-native-gesture-handler';
import { SafeAreaView } from 'react-native-safe-area-context';

import { CatConstellation } from '@/components/cat-constellation';
import { ExplainSheet } from '@/components/explain-sheet';
import { PrismButton } from '@/components/prism';
import { RingButton } from '@/components/ring-button';
import { TappableSentence, type ExplainSelection } from '@/components/tide/tappable-sentence';
import { TideScene } from '@/components/tide/tide-scene';
import { fonts } from '@/constants/fonts';
import { Spacing, tide } from '@/constants/theme';
import { useTrackHighlight } from '@/hooks/use-track-highlight';
import * as api from '@/lib/api';
import { scheduleAudioSessionRelease, startPlayback, stopPlayback, useSessionPlayer } from '@/lib/audio-mode';
import { useT } from '@/lib/i18n';
import { peekLastLine, setLastLine } from '@/lib/last-line';
import { getSettingsSync } from '@/lib/settings';

/** Speed chip steps: a quick nudge, not a ruler. */
const RATES = [1, 0.8, 0.65];

/** A podcast episode as one continuous track, the text flowing on its timeline. */
export default function PodcastScreen() {
  const { t } = useT();
  const router = useRouter();
  const { id, line } = useLocalSearchParams<{ id: string; line?: string }>();

  const [island, setIsland] = useState<api.Island | null>(null);
  const [error, setError] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [playing, setPlaying] = useState(false);
  const [failed, setFailed] = useState(false);
  const [rate, setRate] = useState(1);

  const player = useAudioPlayer(null, { updateInterval: 50, keepAudioSessionActive: true });
  useSessionPlayer(player);

  const scrollRef = useRef<ScrollView>(null);
  const lines = useMemo(() => island?.lines ?? [], [island]);
  const sceneLines = useMemo(() => lines.map((l) => l.ja), [lines]);
  const { highlight, activeLine, seekToLine } = useTrackHighlight(player, lines);

  const [explainOpen, setExplainOpen] = useState(false);
  const [explainSpan, setExplainSpan] = useState<ExplainSelection['span'] | null>(null);
  const [explainMarked, setExplainMarked] = useState<string[]>([]);
  const [explainWhole, setExplainWhole] = useState(false);
  const [generation, setGeneration] = useState(0);
  const [readingMode] = useState(() => getSettingsSync().reading);
  const [englishShown] = useState(() => !getSettingsSync().hideEnglish);

  useEffect(() => {
    let alive = true;
    api
      .getIsland(id)
      .then((i) => {
        if (!alive) return;
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
  useEffect(() => {
    const sub = player.addListener('playbackStatusUpdate', (s) => {
      setLoaded(s.isLoaded);
      setPlaying(s.playing);
      setFailed(!!s.error);
      if (s.didJustFinish) {
        ended.current = true;
        setPlaying(false);
      }
    });
    return () => sub.remove();
  }, [player]);

  // Opens where the person left off, shared with the shadowing player.
  const started = useRef(false);
  useEffect(() => {
    if (started.current || !loaded || lines.length === 0) return;
    started.current = true;
    const n = Number(line);
    const at = line !== undefined && Number.isFinite(n) ? Math.floor(n) : (peekLastLine(id) ?? 0);
    seekToLine(Math.max(0, Math.min(at, lines.length - 1)));
  }, [loaded, lines.length, line, id, seekToLine]);

  useEffect(() => {
    if (started.current) setLastLine(id, activeLine);
    setExplainOpen(false);
    setGeneration((g) => g + 1);
  }, [id, activeLine]);

  useEffect(() => {
    if (loaded) player.setPlaybackRate(rate, 'high');
  }, [player, loaded, rate]);

  const pause = useCallback(() => {
    stopPlayback(player);
    scheduleAudioSessionRelease();
  }, [player]);

  useFocusEffect(
    useCallback(
      () => () => {
        stopPlayback(player);
        scheduleAudioSessionRelease();
      },
      [player],
    ),
  );

  const toggle = () => {
    if (playing) {
      pause();
      return;
    }
    if (ended.current) {
      ended.current = false;
      seekToLine(0);
    }
    startPlayback(player);
  };
  const play = useCallback(() => startPlayback(player), [player]);
  const onLineTap = useCallback(
    (i: number) => {
      ended.current = false;
      seekToLine(i);
      play();
    },
    [seekToLine, play],
  );
  const onExplain = useCallback(
    (sel: ExplainSelection) => {
      setExplainMarked(sel.marked);
      setExplainWhole(sel.whole);
      setExplainSpan(sel.span);
      pause();
      setExplainOpen(true);
    },
    [pause],
  );
  const onExplainClose = useCallback(() => setExplainOpen(false), []);
  const onExplainPlay = useCallback(() => onLineTap(activeLine), [onLineTap, activeLine]);

  const cycleRate = () => setRate((r) => RATES[(RATES.indexOf(r) + 1) % RATES.length]!);
  function shadow(withLine: boolean) {
    stopPlayback(player);
    scheduleAudioSessionRelease();
    router.push({
      pathname: '/island/[id]',
      params: withLine ? { id, line: String(activeLine) } : { id },
    });
  }

  const language = island?.language ?? 'ja';

  return (
    <SafeAreaView edges={['bottom']} style={[styles.fill, { backgroundColor: tide.sky[0] }]}>
      <StatusBar style="light" />
      <Stack.Screen options={{ title: island?.title ?? '' }} />
      {error || failed ? (
        <View style={styles.center}>
          <Text style={styles.hint}>{t('podcast.loadFailed')}</Text>
          <PrismButton shape="pill" verb="speak" label={t('podcast.shadowInstead')} onPress={() => shadow(false)} />
        </View>
      ) : !island || !loaded ? (
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
              blind={false}
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
                    onInteract={pause}
                    readingMode={readingMode}
                    blind={false}
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
          {lines.length > 0 ? (
            <View style={styles.bottom}>
              <PrismButton
                shape="pill"
                verb="tools"
                flat
                press="light"
                label={`${rate.toFixed(2).replace(/0$/, '')}x`}
                onPress={cycleRate}
              />
              <RingButton size={84} mode={playing ? 'playing' : 'idle'} onPress={toggle} flat />
              <PrismButton shape="pill" verb="speak" label={t('video.shadowLine')} onPress={() => shadow(true)} />
            </View>
          ) : null}
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
          blind={false}
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
  hint: {
    fontSize: 14,
    lineHeight: 20,
    color: tide.textDim,
    fontFamily: fonts.ui,
    textAlign: 'center',
  },
  bottom: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: Spacing.lg,
    paddingVertical: Spacing.md,
  },
});
