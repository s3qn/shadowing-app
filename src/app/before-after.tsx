import { useAudioPlayer } from 'expo-audio';
import { useFocusEffect, useLocalSearchParams } from 'expo-router';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import Animated, {
  Easing,
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
  withDelay,
  withSpring,
  withTiming,
} from 'react-native-reanimated';
import { SafeAreaView } from 'react-native-safe-area-context';

import { RingButton } from '@/components/ring-button';
import { GlassPanel } from '@/components/prism';
import { RoundButton } from '@/components/tide/bottom-row';
import { PlayerTitle } from '@/components/tide/player-title';
import { speedLabel } from '@/components/tide/speed-popover';
import { fonts } from '@/constants/fonts';
import { Spacing, tide } from '@/constants/theme';
import { useLineStatus } from '@/hooks/use-line-status';
import { getIsland, type Island } from '@/lib/api';
import {
  applyPlaybackMode,
  scheduleAudioSessionRelease,
  startPlayback,
  stopPlayback,
  useSessionPlayer,
} from '@/lib/audio-mode';
import { useT } from '@/lib/i18n';
import { readCachedIsland } from '@/lib/island-cache';
import { requestLoader } from '@/lib/loading-overlay';
import { useSkyStyle } from '@/lib/sky';
import { findFirstTake, findTake, firstTakeIndices } from '@/lib/takes';

type Which = 'first' | 'now';

const SLIDE_PX = 18;

function metaText(recordedAt: number, speed: number | null, locale: string): string {
  const date = new Date(recordedAt).toLocaleDateString(locale);
  return speed !== null ? `${date} · ${speedLabel(speed)}` : date;
}

/**
 * A line's first take next to its latest: two discs that each play the
 * take's own file, and a stepper over the lines that have both. Opened from
 * the island menu on the line the player is on.
 */
export default function BeforeAfterScreen() {
  const { id, idx } = useLocalSearchParams<{ id: string; idx?: string }>();
  const { t, locale, rtl } = useT();
  const sky = useSkyStyle();
  const reduced = useReducedMotion();

  const [island, setIsland] = useState<Island | null>(null);
  const [failed, setFailed] = useState(false);
  const [comparable, setComparable] = useState<number[] | null>(null);
  const [cursor, setCursor] = useState(0);
  const [which, setWhich] = useState<Which | null>(null);
  const cursorSet = useRef(false);
  const prevCursor = useRef<number | null>(null);
  const cursorEffectRan = useRef(false);

  const player = useAudioPlayer(null, { keepAudioSessionActive: true });
  useSessionPlayer(player);
  const { status } = useLineStatus(
    player,
    () => {},
    (s) => `${s.isLoaded}:${s.playing}`,
  );

  // Island: the cache first, then the network.
  useEffect(() => {
    if (!id) return;
    let alive = true;
    void (async () => {
      const cached = await readCachedIsland(id);
      if (!alive) return;
      if (cached) {
        setIsland(cached.island);
        return;
      }
      try {
        const fetched = await getIsland(id);
        if (alive) setIsland(fetched);
      } catch {
        if (alive) setFailed(true);
      }
    })();
    return () => {
      alive = false;
    };
  }, [id]);

  useEffect(() => {
    requestLoader(island === null && !failed);
  }, [island, failed]);
  useEffect(() => () => requestLoader(false), []);

  useEffect(() => {
    void applyPlaybackMode();
    return () => {
      stopPlayback(player);
      scheduleAudioSessionRelease();
    };
  }, [player]);

  const lineCount = island?.lines.length ?? 0;
  useFocusEffect(
    useCallback(() => {
      if (!id || lineCount === 0) return;
      const found = firstTakeIndices(id, lineCount);
      setComparable(found);
      if (!cursorSet.current) {
        cursorSet.current = true;
        const at = found.indexOf(Number(idx));
        prevCursor.current = at >= 0 ? at : 0;
        setCursor(prevCursor.current);
      }
    }, [id, idx, lineCount]),
  );

  const lineIdx = comparable && comparable.length > 0 ? comparable[Math.min(cursor, comparable.length - 1)] : null;
  const line = island && lineIdx !== null ? island.lines[lineIdx] : null;
  const first = useMemo(() => (id && lineIdx !== null ? findFirstTake(id, lineIdx) : null), [id, lineIdx, comparable]);
  const now = useMemo(() => (id && lineIdx !== null ? findTake(id, lineIdx) : null), [id, lineIdx, comparable]);

  const onDisc = (disc: Which) => {
    if (which === disc && status.playing) {
      stopPlayback(player);
      setWhich(null);
      return;
    }
    const pick = disc === 'first' ? first : now;
    if (!pick) return;
    stopPlayback(player);
    player.replace({ uri: pick.cleanUri ?? pick.uri });
    void player.seekTo(0);
    startPlayback(player);
    setWhich(disc);
  };

  // Motion. Reduced motion starts every value at its end state.
  const cardY = useSharedValue(reduced ? 0 : 14);
  const cardOpacity = useSharedValue(reduced ? 1 : 0);
  const firstScale = useSharedValue(reduced ? 1 : 0.92);
  const firstOpacity = useSharedValue(reduced ? 1 : 0);
  const nowScale = useSharedValue(reduced ? 1 : 0.92);
  const nowOpacity = useSharedValue(reduced ? 1 : 0);
  const stepperOpacity = useSharedValue(reduced ? 1 : 0);
  const slideX = useSharedValue(0);
  const fade = useSharedValue(1);
  const metaFade = useSharedValue(1);

  const ready = failed || (!!island && comparable !== null);
  useEffect(() => {
    if (reduced || !ready) return;
    cardOpacity.value = withTiming(1, { duration: 220 });
    cardY.value = withSpring(0, { damping: 18, stiffness: 180 });
    firstScale.value = withDelay(60, withSpring(1, { damping: 16, stiffness: 200 }));
    firstOpacity.value = withDelay(60, withTiming(1, { duration: 180 }));
    nowScale.value = withDelay(120, withSpring(1, { damping: 16, stiffness: 200 }));
    nowOpacity.value = withDelay(120, withTiming(1, { duration: 180 }));
    stepperOpacity.value = withDelay(180, withTiming(1, { duration: 200 }));
  }, [reduced, ready, cardOpacity, cardY, firstScale, firstOpacity, nowScale, nowOpacity, stepperOpacity]);

  // A line change swaps the content at once, then the new content slides in
  // from the side the stepper pointed at. Retargets from wherever it is.
  useEffect(() => {
    if (!cursorEffectRan.current) {
      cursorEffectRan.current = true;
      return;
    }
    const before = prevCursor.current;
    prevCursor.current = cursor;
    stopPlayback(player);
    setWhich(null);
    if (before === null || before === cursor || reduced) return;
    const dir = cursor > before ? 1 : -1;
    slideX.value = SLIDE_PX * dir;
    slideX.value = withSpring(0, { damping: 20, stiffness: 220 });
    fade.value = 0;
    fade.value = withTiming(1, { duration: 160, easing: Easing.out(Easing.quad) });
    metaFade.value = 0;
    metaFade.value = withDelay(40, withTiming(1, { duration: 160, easing: Easing.out(Easing.quad) }));
  }, [cursor, reduced, player, slideX, fade, metaFade]);

  const cardStyle = useAnimatedStyle(() => ({
    opacity: cardOpacity.value * fade.value,
    transform: [{ translateY: cardY.value }, { translateX: slideX.value }],
  }));
  const firstColStyle = useAnimatedStyle(() => ({
    opacity: firstOpacity.value,
    transform: [{ scale: firstScale.value }],
  }));
  const nowColStyle = useAnimatedStyle(() => ({
    opacity: nowOpacity.value,
    transform: [{ scale: nowScale.value }],
  }));
  const metaStyle = useAnimatedStyle(() => ({
    opacity: metaFade.value,
    transform: [{ translateX: slideX.value }],
  }));
  const stepperStyle = useAnimatedStyle(() => ({ opacity: stepperOpacity.value }));

  const playing = status.playing;
  const isJa = island?.language === 'ja';
  const enRtl = island?.native === 'he';

  let body;
  if (failed) {
    body = (
      <Animated.View style={[styles.cardWrap, cardStyle]}>
        <GlassPanel style={styles.card}>
          <Text style={styles.note}>{t('player.couldNotLoadIsland')}</Text>
        </GlassPanel>
      </Animated.View>
    );
  } else if (!island || comparable === null) {
    body = null;
  } else if (comparable.length === 0 || !line) {
    body = (
      <Animated.View style={[styles.cardWrap, cardStyle]}>
        <GlassPanel style={styles.card}>
          <Text style={styles.emptyTitle}>{island.title}</Text>
          <Text style={styles.note}>{t('beforeAfter.empty')}</Text>
        </GlassPanel>
      </Animated.View>
    );
  } else {
    body = (
      <>
        <Animated.View style={[styles.cardWrap, cardStyle]}>
          <GlassPanel style={styles.card}>
            <Text style={styles.ja}>{line.ja}</Text>
            {isJa ? <Text style={styles.kana}>{line.kana}</Text> : null}
            <Text style={[styles.en, enRtl && styles.enRtl]}>{line.en}</Text>
          </GlassPanel>
        </Animated.View>

        <View style={styles.discs}>
          <Animated.View style={[styles.column, firstColStyle]}>
            <RingButton size={72} mode={which === 'first' && playing ? 'playing' : 'idle'} onPress={() => onDisc('first')} />
            <Text style={styles.name}>{t('beforeAfter.first')}</Text>
            <Animated.Text style={[styles.meta, metaStyle]}>
              {first ? metaText(first.recordedAt, first.speed, locale) : ''}
            </Animated.Text>
          </Animated.View>
          <Animated.View style={[styles.column, nowColStyle]}>
            <View style={[styles.column, !now && styles.missing]} pointerEvents={now ? 'auto' : 'none'}>
              <RingButton size={72} mode={which === 'now' && playing ? 'playing' : 'idle'} onPress={() => onDisc('now')} />
              <Text style={styles.name}>{t('beforeAfter.now')}</Text>
              <Animated.Text style={[styles.meta, metaStyle]}>
                {now ? metaText(now.recordedAt, now.speed, locale) : t('beforeAfter.noTakeNow')}
              </Animated.Text>
            </View>
          </Animated.View>
        </View>

        <Animated.View style={[styles.stepperWrap, stepperStyle]}>
          <GlassPanel>
            <View style={styles.stepper}>
              <RoundButton
                glyph="‹"
                flat
                label={t('player.previousLine')}
                disabled={cursor === 0}
                onPress={() => setCursor((c) => Math.max(0, c - 1))}
              />
              <View style={styles.title}>
                <PlayerTitle title={island.title} lineIndex={lineIdx ?? 0} lineCount={island.lines.length} />
              </View>
              <RoundButton
                glyph="›"
                flat
                label={t('player.nextLine')}
                disabled={cursor >= comparable.length - 1}
                onPress={() => setCursor((c) => Math.min(comparable.length - 1, c + 1))}
              />
            </View>
          </GlassPanel>
        </Animated.View>
      </>
    );
  }

  return (
    <SafeAreaView edges={['bottom']} style={StyleSheet.flatten([styles.fill, { backgroundColor: sky.top }])}>
      <View style={[StyleSheet.absoluteFill, sky.from]} />
      <Animated.View style={[StyleSheet.absoluteFill, sky.to, sky.fadeStyle]} />
      <View style={[styles.content, rtl && styles.contentRtl]}>{body}</View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1 },
  content: { flex: 1, paddingTop: 96 },
  contentRtl: {},
  cardWrap: { marginHorizontal: Spacing.lg },
  card: { paddingVertical: 16, paddingHorizontal: 18, gap: 8 },
  ja: { fontFamily: fonts.serifJp, fontSize: 24, lineHeight: 34, textAlign: 'center', color: tide.text },
  kana: { fontFamily: fonts.serifJp, fontSize: 15, lineHeight: 22, textAlign: 'center', color: tide.textDim },
  en: { fontFamily: fonts.ui, fontSize: 13, lineHeight: 18, textAlign: 'center', color: tide.textDim },
  enRtl: { writingDirection: 'rtl' },
  emptyTitle: { fontFamily: fonts.uiMedium, fontSize: 15, textAlign: 'center', color: tide.text },
  note: { fontFamily: fonts.ui, fontSize: 14, lineHeight: 20, textAlign: 'center', color: tide.textDim },
  discs: { marginTop: 28, flexDirection: 'row', justifyContent: 'center', gap: 36 },
  column: { alignItems: 'center', gap: 8 },
  missing: { opacity: 0.4 },
  name: { fontFamily: fonts.uiMedium, fontSize: 15, color: tide.text },
  meta: { fontFamily: fonts.ui, fontSize: 12, color: tide.textDim },
  stepperWrap: { marginTop: 28, marginHorizontal: Spacing.lg },
  stepper: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 14,
    paddingVertical: 10,
    paddingHorizontal: 18,
  },
  title: { flex: 1, alignItems: 'center' },
});
