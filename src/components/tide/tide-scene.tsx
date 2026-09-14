import { memo, type ReactNode, type RefObject, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { type LayoutChangeEvent, Platform, Pressable, StyleSheet, Text, View } from 'react-native';
import { ScrollView } from 'react-native-gesture-handler';
import Animated, { FadeIn, FadeOut } from 'react-native-reanimated';

import { fonts } from '@/constants/fonts';
import { Radius, tide } from '@/constants/theme';

// How far the waterline sits from the top of the scene at the first and last
// line: the tide rises from WL_MAX to WL_MIN as lineIndex approaches the end.
const WL_MAX = 0.62;
const WL_MIN = 0.42;

type Props = {
  lineIndex: number;
  lineCount: number;
  /** Every line's Japanese text, in order; only the active one is tappable-free. */
  lines: readonly string[];
  /** Blind mode: past and next lines show `……` instead of their text. */
  blind: boolean;
  /** Seconds left in the breath, giant faded number; null hides it. */
  countdown: number | null;
  banner?: ReactNode;
  /** Sits on the waterline, bottom-anchored. */
  sentence: ReactNode;
  /** The same words again, drawn upside down under the waterline, never tappable. */
  reflection?: ReactNode;
  /** Under the reflection: English toggle, PhraseBar. */
  below?: ReactNode;
  scrollRef: RefObject<ScrollView | null>;
  /** A dim line was tapped: the screen should jump to it and start playing. */
  onLineTap: (i: number) => void;
};

/**
 * The Tide player scene: every line of the island in one scrolling
 * transcript, the active sentence sitting on a waterline over its own
 * reflection, tide marks down the left edge and a giant faded countdown
 * mid-screen during the breath. Auto-scroll keeps the active line on the
 * waterline; a hand drag pauses that behind a pill. Pure layout, no engine
 * knowledge: the screen owns playback and passes the rendered slots in.
 */
export function TideScene({
  lineIndex,
  lineCount,
  lines,
  blind,
  countdown,
  banner,
  sentence,
  reflection,
  below,
  scrollRef,
  onLineTap,
}: Props) {
  const [sceneH, setSceneH] = useState(0);
  const [pill, setPill] = useState<'off' | 'on' | null>(null);
  // Whether the transcript should follow playback. A ref, not state: it must
  // read as up to date inside the same handler that just turned it on, and
  // nothing renders differently from its value directly (the pill does).
  const autoScroll = useRef(true);
  const activeTop = useRef(0);
  const activeH = useRef(0);
  const lastTarget = useRef<number | null>(null);
  const synced = useRef(false);

  const onLayout = (e: LayoutChangeEvent) => {
    setSceneH(e.nativeEvent.layout.height);
  };

  // Returns whether it actually issued a scrollTo, so callers that only
  // want the instant-vs-glide flag to flip once a real scroll happened
  // (see synced below) can tell a bail apart from a scroll.
  function syncScroll(animated: boolean) {
    if (sceneH === 0 || !autoScroll.current) return false;
    const y = activeTop.current + activeH.current - waterlineFraction(lineIndex, lineCount) * sceneH;
    if (lastTarget.current !== null && Math.abs(y - lastTarget.current) <= 1) return false;
    lastTarget.current = y;
    scrollRef.current?.scrollTo({ y, animated });
    return true;
  }

  // The first sync after mount lands the waterline instantly; every one
  // after that (a line change, a resize) glides there. synced only flips
  // once scrollTo actually ran: if we flipped it on a bail (sceneH still 0
  // on the first render, say), the next real scroll would glide through
  // the whole transcript instead of landing instantly.
  function syncNow() {
    if (syncScroll(synced.current)) {
      synced.current = true;
    }
  }

  useEffect(() => {
    syncNow();
    // syncNow reads lineIndex, lineCount and sceneH through closures that are
    // already current on every render; re-running it for any other reason
    // (an autoScroll toggle, say) would fight the pill's own scrollTo.
    // lineIndex is deliberately not a dep: a line change remounts the active
    // line's View (its key is the index), and that View's own onLayout calls
    // syncNow with the new line's freshly measured activeTop/activeH. If
    // this effect also fired on lineIndex, it would run first with the
    // previous line's stale measurements and glide there before onLayout
    // corrects it, so the transcript would visibly double-glide.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lineCount, sceneH]);

  useEffect(() => {
    if (pill !== 'on') return;
    const t = setTimeout(() => setPill(null), 1500);
    return () => clearTimeout(t);
  }, [pill]);

  // onLineTap is a new function every render (the screen closes over
  // playback state), so tapLine reads it through a ref kept current below
  // instead of taking it as a dep: with empty deps tapLine's own identity
  // never changes, so the memoised TranscriptLine rows below don't re-render
  // on every render this component gets from an audio tick.
  const onLineTapRef = useRef(onLineTap);
  onLineTapRef.current = onLineTap;

  const tapLine = useCallback((i: number) => {
    autoScroll.current = true;
    lastTarget.current = null;
    setPill(null);
    onLineTapRef.current(i);
  }, []);

  // A plain function, not useCallback: it must close over this render's
  // syncScroll (which itself closes over the latest lineIndex/lineCount/
  // sceneH). A memoised version would keep the first render's syncScroll,
  // which always bails because sceneH is still 0 then, so the pill's tap
  // would silently do nothing. Resetting lastTarget also clears the 1px
  // guard, which would otherwise block this scroll if the drag left the
  // view within 1px of the last auto-scrolled position.
  function enableAutoScroll() {
    autoScroll.current = true;
    lastTarget.current = null;
    setPill('on');
    syncScroll(true);
  }

  const onScrollBeginDrag = () => {
    if (autoScroll.current) {
      autoScroll.current = false;
      setPill('off');
    }
  };

  const marks = useMemo(
    () =>
      Array.from({ length: lineCount }, (_, i) => lineCount - 1 - i).map((i) => (
        <View
          key={i}
          style={[
            styles.mark,
            i < lineIndex ? styles.markDone : i === lineIndex ? styles.markNow : styles.markPending,
          ]}
        />
      )),
    [lineIndex, lineCount],
  );

  return (
    <View style={styles.fill} onLayout={onLayout}>
      <View style={[StyleSheet.absoluteFill, styles.sky]} />
      <ScrollView
        ref={scrollRef}
        style={styles.scroll}
        contentContainerStyle={[styles.content, { paddingTop: WL_MAX * sceneH }]}
        onScrollBeginDrag={onScrollBeginDrag}
        bounces={false}
        overScrollMode="never"
        showsVerticalScrollIndicator={false}
        keyboardShouldPersistTaps="handled"
      >
        {lines.slice(0, lineIndex).map((text, i) => (
          <TranscriptLine key={i} index={i} text={text} tone="past" blind={blind} onPress={tapLine} />
        ))}
        <View
          key={lineIndex}
          style={styles.active}
          onLayout={(e) => {
            activeTop.current = e.nativeEvent.layout.y;
            activeH.current = e.nativeEvent.layout.height;
            syncNow();
          }}
        >
          {sentence}
        </View>
        <View style={[styles.water, { paddingBottom: (1 - WL_MIN) * sceneH }]}>
          <View style={styles.waterGlow} pointerEvents="none" />
          <View style={styles.reflectionWrap} pointerEvents="none">
            {reflection}
            <View style={[StyleSheet.absoluteFill, styles.reflectionFade]} />
          </View>
          {below}
          {lines.slice(lineIndex + 1).map((text, j) => {
            const i = lineIndex + 1 + j;
            return <TranscriptLine key={i} index={i} text={text} tone="next" blind={blind} onPress={tapLine} />;
          })}
        </View>
      </ScrollView>
      {countdown !== null ? (
        <View style={[StyleSheet.absoluteFill, styles.countdownWrap]} pointerEvents="none">
          <Text style={styles.countdown}>{countdown}</Text>
        </View>
      ) : null}
      <View style={styles.marks} pointerEvents="none">
        {marks}
      </View>
      {banner ? (
        <View style={[StyleSheet.absoluteFill, styles.bannerWrap]} pointerEvents="box-none">
          {banner}
        </View>
      ) : null}
      {pill ? (
        <View style={styles.pillWrap} pointerEvents="box-none">
          <Animated.View entering={FadeIn} exiting={FadeOut}>
            <Pressable onPress={enableAutoScroll} style={styles.pill} accessibilityRole="button">
              <Text style={styles.pillText}>
                {pill === 'off' ? 'Auto-scroll disabled. Tap to enable' : 'Auto-scroll enabled'}
              </Text>
            </Pressable>
          </Animated.View>
        </View>
      ) : null}
    </View>
  );
}

/** A past or upcoming line in the transcript: dim, centred, tap to jump. */
const TranscriptLine = memo(function TranscriptLine({
  index,
  text,
  tone,
  blind,
  onPress,
}: {
  index: number;
  text: string;
  tone: 'past' | 'next';
  blind: boolean;
  onPress: (i: number) => void;
}) {
  return (
    <Pressable
      onPress={() => onPress(index)}
      style={styles.dimLine}
      accessibilityRole="button"
      accessibilityLabel={tone === 'past' ? 'Previous line' : 'Next line'}
    >
      <Text style={styles.dimText}>{blind ? '……' : text}</Text>
    </Pressable>
  );
});

/** design: `--wl: 62 - t*5%` (t on a 0..4 scale here becomes lineIndex / (lineCount-1)). */
function waterlineFraction(lineIndex: number, lineCount: number) {
  return WL_MAX - 0.2 * (lineIndex / Math.max(1, lineCount - 1));
}

const styles = StyleSheet.create({
  fill: { flex: 1, overflow: 'hidden' },
  sky: { experimental_backgroundImage: 'linear-gradient(180deg, #070A12, #101A2A 60%, #16243A)' },
  scroll: { flex: 1, zIndex: 2 },
  content: { position: 'relative' },
  active: {
    paddingLeft: 28,
    paddingRight: 88,
    paddingBottom: 10,
    zIndex: 3,
  },
  water: {
    borderTopWidth: 1,
    borderTopColor: tide.waterline,
    backgroundColor: tide.water,
    paddingLeft: 28,
    paddingRight: 88,
    paddingTop: 8,
    zIndex: 2,
  },
  waterGlow: {
    position: 'absolute',
    left: 0,
    right: 0,
    top: 0,
    height: 220,
    experimental_backgroundImage: `linear-gradient(180deg, rgba(255,158,128,0.2), ${tide.water})`,
  },
  dimLine: {
    paddingLeft: 28,
    paddingRight: 88,
    paddingVertical: 6,
  },
  dimText: {
    fontFamily: fonts.serifJp,
    fontSize: 18,
    lineHeight: 28,
    textAlign: 'center',
    color: tide.text,
    opacity: 0.42,
  },
  reflectionWrap: {
    transform: [{ scaleY: -1 }],
    opacity: 0.3,
    ...Platform.select({ android: { filter: [{ blur: 1 }] }, default: {} }),
  },
  reflectionFade: {
    experimental_backgroundImage: 'linear-gradient(0deg, transparent, #08131C 85%)',
  },
  countdownWrap: {
    alignItems: 'center',
    justifyContent: 'center',
    zIndex: 4,
  },
  countdown: {
    fontFamily: fonts.serifLight,
    fontSize: 200,
    lineHeight: 210,
    color: 'rgba(255,158,128,0.18)',
    fontVariant: ['tabular-nums'],
  },
  marks: {
    position: 'absolute',
    left: 10,
    top: '40%',
    bottom: '34%',
    flexDirection: 'column',
    justifyContent: 'space-between',
    zIndex: 4,
  },
  mark: { width: 14, height: 2, borderRadius: 1, backgroundColor: 'rgba(255,255,255,0.2)' },
  markPending: {},
  markDone: {
    backgroundColor: tide.lang.ja,
    boxShadow: '0 0 8px rgba(255,158,128,0.8)',
  },
  markNow: { backgroundColor: tide.text, width: 18 },
  bannerWrap: {
    zIndex: 5,
  },
  pillWrap: {
    position: 'absolute',
    top: 10,
    left: 0,
    right: 88,
    alignItems: 'center',
    zIndex: 6,
  },
  pill: {
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderRadius: Radius.pill,
    backgroundColor: 'rgba(255,255,255,0.1)',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.15)',
  },
  pillText: {
    fontFamily: fonts.ui,
    fontSize: 12,
    color: tide.text,
  },
});
