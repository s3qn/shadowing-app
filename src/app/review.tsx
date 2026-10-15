import { useAudioPlayer } from 'expo-audio';
import { Stack, useFocusEffect, useRouter } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Linking, StyleSheet, Text, useWindowDimensions, View } from 'react-native';
import { ScrollView } from 'react-native-gesture-handler';
import { SafeAreaView } from 'react-native-safe-area-context';
import YoutubePlayer, { type YoutubeIframeRef } from 'react-native-youtube-iframe';

import { CatConstellation } from '@/components/cat-constellation';
import { ExplainSheet } from '@/components/explain-sheet';
import { PrismButton } from '@/components/prism';
import { RingButton } from '@/components/ring-button';
import { TappableSentence, type ExplainSelection } from '@/components/tide/tappable-sentence';
import { fonts } from '@/constants/fonts';
import { Spacing, tide } from '@/constants/theme';
import { useTrackHighlight } from '@/hooks/use-track-highlight';
import { playIntent } from '@/hooks/use-video-highlight';
import * as api from '@/lib/api';
import { scheduleAudioSessionRelease, startPlayback, stopPlayback, useSessionPlayer } from '@/lib/audio-mode';
import { hapticSelection } from '@/lib/haptics';
import { useT } from '@/lib/i18n';
import { getSettingsSync } from '@/lib/settings';
import { PLAYER_BRIDGE_SCRIPT, watchUrl } from '@/lib/youtube';

/** How often the embed is asked for its time while a card plays. */
const POLL_MS = 250;

/** Saved sentences due today, listened to in the original audio and graded. */
export default function ReviewScreen() {
  const { t } = useT();
  const router = useRouter();
  const { width } = useWindowDimensions();

  const [queue, setQueue] = useState<api.ReviewCard[]>([]);
  const [pos, setPos] = useState(0);
  const [total, setTotal] = useState(0);
  const [reviewed, setReviewed] = useState(0);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');
  const requeued = useRef(new Set<string>());

  const [playing, setPlaying] = useState(false);
  const [cannotPlay, setCannotPlay] = useState(false);
  const [ytReady, setYtReady] = useState(false);
  const ytRef = useRef<YoutubeIframeRef>(null);
  const [readingMode] = useState(() => getSettingsSync().reading);
  const [englishShown] = useState(() => !getSettingsSync().hideEnglish);

  const [explainOpen, setExplainOpen] = useState(false);
  const [explainSpan, setExplainSpan] = useState<ExplainSelection['span'] | null>(null);
  const [explainMarked, setExplainMarked] = useState<string[]>([]);
  const [explainWhole, setExplainWhole] = useState(false);
  const [generation, setGeneration] = useState(0);
  const scrollRef = useRef<ScrollView>(null);

  const player = useAudioPlayer(null, { updateInterval: 50, keepAudioSessionActive: true });
  useSessionPlayer(player);

  const card = queue[pos] ?? null;
  const cardLine = useMemo<api.Line[]>(
    () =>
      card
        ? [{ idx: 0, ja: card.ja, kana: card.kana, romaji: card.romaji, en: card.en, duration: card.duration, timeline: [], words: card.words, offset: 0 }]
        : [],
    [card],
  );
  const { highlight } = useTrackHighlight(player, cardLine);

  useEffect(() => {
    let alive = true;
    api
      .getReviewDue()
      .then((r) => {
        if (!alive) return;
        setQueue(r.due);
        setTotal(r.total);
        setLoading(false);
      })
      .catch((e) => {
        if (!alive) return;
        setLoadError(e instanceof Error ? e.message : t('review.loadFailed'));
        setLoading(false);
      });
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Playing a clip card runs the shared player; an embed card runs the iframe.
  const playCard = useCallback(() => {
    if (!card) return;
    if (card.kind === 'clip') {
      player.seekTo(0);
      startPlayback(player);
    } else {
      ytRef.current?.seekTo(card.start_s, true);
      setPlaying(true);
    }
  }, [card, player]);

  const stopAll = useCallback(() => {
    stopPlayback(player);
    scheduleAudioSessionRelease();
    setPlaying(false);
  }, [player]);

  const videoId = card?.kind === 'embed' ? card.video_id : null;
  useEffect(() => {
    setYtReady(false);
  }, [videoId]);

  // A card plays once when it is shown (an embed waits for its player).
  const cardId = card?.id;
  useEffect(() => {
    setExplainOpen(false);
    setGeneration((g) => g + 1);
    setCannotPlay(false);
    if (!card) return;
    if (card.kind === 'clip') {
      setPlaying(false);
      player.replace({ uri: api.withUser(api.reviewClipUrl(card.id)) });
      startPlayback(player);
    } else if (ytReady) {
      playCard();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cardId, ytReady]);

  // The embed has no end-of-range event, so its clock is polled and the card
  // is paused once the sentence is over.
  const endS = card?.kind === 'embed' ? card.end_s : null;
  useEffect(() => {
    if (!playing || endS === null) return;
    const timer = setInterval(() => {
      void ytRef.current
        ?.getCurrentTime()
        .then((now) => {
          if (now >= endS) setPlaying(false);
        })
        .catch(() => {});
    }, POLL_MS);
    return () => clearInterval(timer);
  }, [playing, endS]);

  const [clipPlaying, setClipPlaying] = useState(false);
  useEffect(() => {
    const sub = player.addListener('playbackStatusUpdate', (s) => setClipPlaying(s.playing));
    return () => sub.remove();
  }, [player]);

  useFocusEffect(useCallback(() => () => stopAll(), [stopAll]));

  const grade = (result: 'again' | 'got') => {
    if (!card) return;
    void hapticSelection();
    stopAll();
    setReviewed((n) => n + 1);
    if (result === 'again' && !requeued.current.has(card.id)) {
      requeued.current.add(card.id);
      setQueue((q) => [...q, card]);
    }
    setPos((p) => p + 1);
    api.gradeReviewCard(card.id, result).catch(() => {});
  };

  const remove = () => {
    if (!card) return;
    stopAll();
    const id = card.id;
    const at = pos;
    setQueue((q) => q.filter((c, i) => !(i === at && c.id === id)));
    api.removeReviewCard(id).catch(() => {});
  };

  const onExplain = useCallback(
    (sel: ExplainSelection) => {
      setExplainMarked(sel.marked);
      setExplainWhole(sel.whole);
      setExplainSpan(sel.span);
      stopAll();
      setExplainOpen(true);
    },
    [stopAll],
  );
  const onExplainClose = useCallback(() => setExplainOpen(false), []);

  const ring = card?.kind === 'embed' ? playing : clipPlaying;
  const toggle = () => {
    if (ring) stopAll();
    else playCard();
  };

  const finished = !loading && !loadError && queue.length > 0 && pos >= queue.length;
  const backPill = <PrismButton shape="pill" verb="tools" label={t('review.back')} onPress={() => router.back()} />;

  return (
    <SafeAreaView edges={['bottom']} style={[styles.fill, { backgroundColor: tide.sky[0] }]}>
      <StatusBar style="light" />
      <Stack.Screen options={{ title: t('review.title') }} />
      {loading ? (
        <View style={styles.center}>
          <CatConstellation size={120} />
        </View>
      ) : loadError ? (
        <View style={styles.center}>
          <Text style={styles.hint}>{loadError}</Text>
          {backPill}
        </View>
      ) : finished ? (
        <View style={styles.center}>
          <Text style={styles.title}>{t('review.done')}</Text>
          <Text style={styles.hint}>{t('review.reviewedCount', { n: reviewed })}</Text>
          {backPill}
        </View>
      ) : total === 0 ? (
        <View style={styles.center}>
          <Text style={styles.title}>{t('review.emptyTitle')}</Text>
          <Text style={styles.hint}>{t('review.emptyHint')}</Text>
          <PrismButton shape="pill" verb="listen" label={t('review.openPodcasts')} onPress={() => router.navigate('/podcast')} />
        </View>
      ) : !card ? (
        <View style={styles.center}>
          <Text style={styles.title}>{t('review.noneDue', { total })}</Text>
          {backPill}
        </View>
      ) : (
        <>
          <Text style={styles.progress}>{t('review.progress', { i: Math.min(pos + 1, queue.length), n: queue.length })}</Text>
          {card.kind === 'embed' ? (
            cannotPlay ? (
              <View style={[styles.cannot, { height: (width * 9) / 16 }]}>
                <Text style={styles.hint}>{t('video.cannotPlay')}</Text>
                <PrismButton
                  shape="pill"
                  verb="tools"
                  flat
                  press="light"
                  label={t('video.openInYoutube')}
                  onPress={() => void Linking.openURL(watchUrl(card.video_id))}
                />
              </View>
            ) : (
              <View pointerEvents="none">
                <YoutubePlayer
                  key={card.video_id}
                  ref={ytRef}
                  height={(width * 9) / 16}
                  width={width}
                  videoId={card.video_id}
                  play={playing}
                  webViewProps={{ injectedJavaScript: PLAYER_BRIDGE_SCRIPT }}
                  initialPlayerParams={{ start: Math.floor(card.start_s), controls: false, rel: false, modestbranding: true }}
                  onReady={() => setYtReady(true)}
                  onChangeState={(s: string) => setPlaying((p) => playIntent(p, s))}
                  onError={() => setCannotPlay(true)}
                />
              </View>
            )
          ) : null}
          <ScrollView ref={scrollRef} style={styles.fill} contentContainerStyle={styles.sentence}>
            <TappableSentence
              key={card.id}
              line={cardLine[0]!}
              language={card.language}
              native={card.native}
              islandId={card.island_id}
              highlight={highlight}
              scrollRef={scrollRef}
              onExplain={onExplain}
              onInteract={stopAll}
              readingMode={readingMode}
              blind={false}
              englishShown={englishShown}
            />
            <Text style={styles.source}>
              {card.island_title} · {card.source === 'youtube' ? t('review.sourceYoutube') : t('review.sourcePodcast')}
            </Text>
          </ScrollView>
          <View style={styles.bottom}>
            <RingButton size={84} mode={ring ? 'playing' : 'idle'} onPress={toggle} flat />
            <View style={styles.grades}>
              <PrismButton shape="pill" verb="speak" flat label={t('review.again')} onPress={() => grade('again')} />
              <PrismButton shape="pill" verb="listen" label={t('review.got')} onPress={() => grade('got')} />
            </View>
            <Text style={styles.remove} onPress={remove} accessibilityRole="button">
              {t('review.remove')}
            </Text>
          </View>
          <ExplainSheet
            open={explainOpen}
            onClose={onExplainClose}
            sentenceJa={card.ja}
            sentenceEn={card.en}
            language={card.language}
            native={card.native}
            words={card.words}
            span={explainSpan}
            highlight={highlight}
            blind={false}
            marked={explainMarked}
            whole={explainWhole}
            generation={generation}
            onPlaySentence={playCard}
          />
        </>
      )}
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1 },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: Spacing.lg, paddingHorizontal: 16 },
  title: { fontSize: 20, fontWeight: '700', color: tide.text, fontFamily: fonts.ui, textAlign: 'center' },
  hint: { fontSize: 14, lineHeight: 20, color: tide.textDim, fontFamily: fonts.ui, textAlign: 'center' },
  progress: { fontSize: 13, color: tide.textDim, fontFamily: fonts.ui, textAlign: 'center', paddingVertical: Spacing.sm },
  cannot: { alignItems: 'center', justifyContent: 'center', gap: Spacing.md },
  sentence: { padding: 24, gap: 14, flexGrow: 1, justifyContent: 'center' },
  source: { fontSize: 13, color: tide.textDim, fontFamily: fonts.ui, textAlign: 'center' },
  bottom: { alignItems: 'center', gap: Spacing.md, paddingVertical: Spacing.md },
  grades: { flexDirection: 'row', gap: Spacing.lg },
  remove: { fontSize: 13, color: tide.textDim, fontFamily: fonts.ui, paddingVertical: Spacing.sm },
});
