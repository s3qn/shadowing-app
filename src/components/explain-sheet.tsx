import { memo, type ReactNode, useEffect, useRef, useState } from 'react';
import { type LayoutChangeEvent, ScrollView, StyleSheet, Text, View } from 'react-native';
import Animated, {
  Easing,
  FadeOut,
  cancelAnimation,
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
  withDelay,
  withRepeat,
  withSequence,
  withTiming,
} from 'react-native-reanimated';

import { PressScale } from '@/components/press-scale';
import { Frost } from '@/components/frost';
import { BottomSheet } from '@/components/sheet/bottom-sheet';
import { type Highlight, useWordInk, type WordBox } from '@/components/word-highlight';
import { WordOutline } from '@/components/word-outline';
import { fonts } from '@/constants/fonts';
import { Radius, Spacing, tide } from '@/constants/theme';
import * as api from '@/lib/api';
import type { ExplainAnswer, ExplainGrammarItem, ExplainVocabItem, Word } from '@/lib/api';

const FALLBACK_SUMMARY = "Couldn't get an answer just now.";

// A fixed question, not something the learner types: covers what the
// selection needs explained so there is nothing to type before it fires.
// Asks the backend for a compact, structured shape (vocab, grammar, summary)
// so the sheet can render organised sections instead of a wall of text.
const EXPLAIN_QUESTION =
  'Explain this in the context of the sentence, briefly: vocabulary, grammar, and the overall meaning and nuance.';

const SKELETON_ROWS = 3;

// Stagger timing shared by vocab rows, grammar items and the summary: each
// later block waits `index * STAGGER_MS` before it starts its own fade and
// rise, so the sections read as vocabulary, then grammar, then summary,
// arriving one at a time rather than all at once.
const STAGGER_MS = 60;
const STAGGER_RISE = 8;
const STAGGER_FADE_MS = 220;
const STAGGER_RISE_MS = 260;
// The highlighter pass across a grammar item's span in the small sentence.
const HIGHLIGHT_MS = 400;

/** Fade and rise entrance for one staggered block, delayed by `index`.
 * Reduced motion drops the rise and keeps only the fade. Returns the delay
 * too, so a caller (the grammar highlighter pass) can start its own
 * animation right after this one settles. */
function useStagger(index: number, reducedMotion: boolean) {
  const opacity = useSharedValue(0);
  const rise = useSharedValue(reducedMotion ? 0 : STAGGER_RISE);
  const delay = index * STAGGER_MS;
  useEffect(() => {
    opacity.value = withDelay(delay, withTiming(1, { duration: STAGGER_FADE_MS }));
    if (!reducedMotion) {
      rise.value = withDelay(delay, withTiming(0, { duration: STAGGER_RISE_MS, easing: Easing.out(Easing.cubic) }));
    }
    // Mount-only: a row's index and the reduced-motion setting are fixed for
    // its lifetime (it remounts under a fresh key if the answer changes).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const style = useAnimatedStyle(() => ({
    opacity: opacity.value,
    transform: [{ translateY: rise.value }],
  }));
  return { style, delay };
}

type Props = {
  open: boolean;
  onClose: () => void;
  onDismissed?: () => void;
  sentenceJa: string;
  sentenceEn: string;
  /** Words the drag selection marked, in line order. */
  marked: string[];
  /** True when the drag spanned every word of the line: reads as "whole
   * sentence" rather than a partial word list. */
  whole: boolean;
  /** Bumped by the screen on every line or speed change. An answer that
   * lands after the generation moved on belongs to a sentence that is no
   * longer on screen, so it is dropped instead of shown under the new one. */
  generation: number;
  /** The line's words, for the header's word-by-word highlight. */
  words: Word[];
  /** The drag selection's word indices, picked out in the header. */
  span: { from: number; to: number } | null;
  /** The player's word highlight: the header lights along with the line
   * exactly as the player does. */
  highlight: Highlight;
  /** Blind mode: the Japanese in the header and the marked words are frosted. */
  blind?: boolean;
  /** Plays the line once from the start. The screen already stopped the line the
   * moment this sheet opened (so it cannot play on behind it and wrap to the
   * next line while the sheet is up); this is the only way to hear it again
   * while the sheet stays open. */
  onPlaySentence: () => void;
};

/**
 * Explains the marked words (or the whole line) as soon as the sheet opens:
 * no question to type, no thread, just a loading state and then the answer,
 * laid out as vocabulary, grammar and a summary instead of one paragraph.
 */
function ExplainSheetBase({
  open,
  onClose,
  onDismissed,
  sentenceJa,
  sentenceEn,
  marked,
  whole,
  generation,
  words,
  span,
  highlight,
  blind = false,
  onPlaySentence,
}: Props) {
  const [answer, setAnswer] = useState<ExplainAnswer | null>(null);
  const [loading, setLoading] = useState(false);
  const reducedMotion = useReducedMotion();

  const markedLabel = whole || marked.length === 0 ? 'Whole sentence' : marked.join('、');
  const markedKey = whole ? '' : marked.join('');

  useEffect(() => {
    if (!open || !sentenceJa) return;
    let cancelled = false;
    setAnswer(null);
    setLoading(true);
    (async () => {
      try {
        const out = await api.explainChat({
          sentenceJa,
          sentenceEn,
          marked: whole ? [] : marked,
          question: EXPLAIN_QUESTION,
          history: [],
        });
        if (!cancelled) setAnswer(out);
      } catch {
        if (!cancelled) setAnswer({});
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    // A new generation (line or speed change) or the sheet closing means
    // this request's answer no longer belongs anywhere, so it is dropped.
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, sentenceJa, sentenceEn, markedKey, generation]);

  const vocab = answer?.vocab ?? [];
  const grammar = answer?.grammar ?? [];
  const summary = answer?.summary ?? '';
  const empty = !loading && vocab.length === 0 && grammar.length === 0 && !summary;

  return (
    <BottomSheet open={open} onClose={onClose} onDismissed={onDismissed} title="Explain">
      <SentenceHeader
        sentenceJa={sentenceJa}
        sentenceEn={sentenceEn}
        words={words}
        span={whole ? null : span}
        highlight={highlight}
        blind={blind}
        onPress={onPlaySentence}
      />
      <Frost frosted={blind && !(whole || marked.length === 0)} style={styles.markedWrap}>
        <Text style={styles.marked}>{markedLabel}</Text>
      </Frost>
      <ScrollView style={styles.scroll} contentContainerStyle={styles.scrollContent}>
        {loading ? (
          <SkeletonBody />
        ) : (
          <>
            {vocab.length > 0 ? (
              <Section label="Vocabulary">
                <View style={styles.vocabList}>
                  {vocab.map((item, i) => (
                    <VocabRow key={`${item.word}-${i}`} item={item} index={i} reducedMotion={reducedMotion} />
                  ))}
                </View>
              </Section>
            ) : null}

            {grammar.length > 0 ? (
              <Section label="Grammar">
                <View style={styles.grammarList}>
                  {grammar.map((item, i) => (
                    <GrammarChip
                      key={`${item.pattern}-${i}`}
                      item={item}
                      sentenceJa={sentenceJa}
                      index={vocab.length + i}
                      reducedMotion={reducedMotion}
                    />
                  ))}
                </View>
              </Section>
            ) : null}

            {/* Summary reads last on purpose: vocab and grammar are the
                specific, scannable facts a learner checks first, and the
                summary is the one paragraph that ties them together, so it
                belongs at the end like a conclusion, not up top. */}
            {summary ? (
              <Section label="Summary">
                <SummaryBlock text={summary} index={vocab.length + grammar.length} reducedMotion={reducedMotion} />
              </Section>
            ) : null}

            {empty ? <SummaryBlock text={FALLBACK_SUMMARY} index={0} reducedMotion={reducedMotion} /> : null}
          </>
        )}
      </ScrollView>
    </BottomSheet>
  );
}

/** Memoised: the player screen renders often, and a closed sheet has
 * nothing to redraw. Its handler props come through useStableHandler. */
export const ExplainSheet = memo(ExplainSheetBase);

/** Splits `text` on the first occurrence of `part` into [before, part,
 * after]. `part` empty or not found returns [text, '', ''], so a caller can
 * always render the three pieces without a branch of its own. */
function splitOn(text: string, part: string): [string, string, string] {
  if (!part) return [text, '', ''];
  const i = text.indexOf(part);
  if (i < 0) return [text, '', ''];
  return [text.slice(0, i), part, text.slice(i + part.length)];
}

/** The full sentence at the top of the sheet: the Explain answer below is
 * about a selection inside it, and the line behind the sheet is stopped
 * (see the screen's openExplain), so this is the only way to see or hear it
 * while the sheet is open. Tapping it plays the line once from the start, and
 * the words light up along with it through the same highlight and underline
 * the player uses. The marked words (a drag selection, not the whole line)
 * are set in bold on a faint tint, so the accent colour stays free for the
 * word being spoken. */
function SentenceHeader({
  sentenceJa,
  sentenceEn,
  words,
  span,
  highlight,
  blind,
  onPress,
}: {
  sentenceJa: string;
  sentenceEn: string;
  words: Word[];
  span: { from: number; to: number } | null;
  highlight: Highlight;
  blind: boolean;
  onPress: () => void;
}) {
  const boxes = useSharedValue<(WordBox | null)[]>([]);
  const layouts = useRef<Record<number, WordBox>>({});
  if (!sentenceJa) return null;
  function onWordLayout(i: number, e: LayoutChangeEvent) {
    layouts.current[i] = e.nativeEvent.layout;
    boxes.value = words.map((_, k) => layouts.current[k] ?? null);
  }
  return (
    <PressScale onPress={onPress} haptic={false} style={styles.headerWrap} accessibilityRole="button">
      <Frost frosted={blind}>
        {words.length > 0 ? (
          <View style={styles.headerWords}>
            {words.map((w, i) => (
              <HeaderWord
                key={i}
                text={w.text}
                index={i}
                marked={!!span && i >= span.from && i <= span.to}
                highlight={highlight}
                onLayout={onWordLayout}
              />
            ))}
            <WordOutline highlight={highlight} boxes={boxes} />
          </View>
        ) : (
          <Text style={styles.headerJa}>{sentenceJa}</Text>
        )}
      </Frost>
      {sentenceEn ? <Text style={styles.headerEn}>{sentenceEn}</Text> : null}
    </PressScale>
  );
}

function HeaderWord({
  text,
  index,
  marked,
  highlight,
  onLayout,
}: {
  text: string;
  index: number;
  marked: boolean;
  highlight: Highlight;
  onLayout: (i: number, e: LayoutChangeEvent) => void;
}) {
  const ink = useWordInk(highlight, index, tide.text);
  return (
    <Animated.Text
      onLayout={(e) => onLayout(index, e)}
      style={[styles.headerJa, styles.headerWord, marked && styles.headerJaMarked, ink]}>
      {text}
    </Animated.Text>
  );
}

function Section({ label, children }: { label: string; children: ReactNode }) {
  return (
    <View style={styles.section}>
      <Text style={styles.sectionLabel}>{label}</Text>
      {children}
    </View>
  );
}

function VocabRow({
  item,
  index,
  reducedMotion,
}: {
  item: ExplainVocabItem;
  index: number;
  reducedMotion: boolean;
}) {
  const { style } = useStagger(index, reducedMotion);
  const color = tide.pos[item.pos] ?? tide.pos.other;
  return (
    <Animated.View style={[styles.vocabRow, style]}>
      <View style={[styles.vocabBar, { backgroundColor: color }]} />
      <View style={styles.vocabWord}>
        <Text style={styles.vocabWordText} numberOfLines={1}>
          {item.word}
        </Text>
        {item.reading ? (
          <Text style={styles.vocabReading} numberOfLines={1}>
            {item.reading}
          </Text>
        ) : null}
      </View>
      <Text style={styles.vocabMeaning} numberOfLines={2}>
        {item.meaning}
      </Text>
    </Animated.View>
  );
}

/** The small quoted sentence below a grammar item's explanation, with its
 * matched span picked out. Once the item itself has faded and risen in, an
 * accent panel behind the span grows left to right like a highlighter pass;
 * reduced motion swaps the grow for a plain fade of the same panel. */
function GrammarChip({
  item,
  sentenceJa,
  index,
  reducedMotion,
}: {
  item: ExplainGrammarItem;
  sentenceJa: string;
  index: number;
  reducedMotion: boolean;
}) {
  const { style, delay } = useStagger(index, reducedMotion);
  const [before, span, after] = item.span ? splitOn(sentenceJa, item.span) : ['', '', ''];
  const highlight = useSharedValue(0);
  useEffect(() => {
    if (!span) return;
    const highlightDelay = delay + (reducedMotion ? STAGGER_FADE_MS : STAGGER_RISE_MS);
    highlight.value = withDelay(
      highlightDelay,
      withTiming(1, { duration: HIGHLIGHT_MS, easing: Easing.out(Easing.cubic) }),
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const highlightStyle = useAnimatedStyle(() =>
    reducedMotion ? { width: '100%', opacity: highlight.value } : { width: `${highlight.value * 100}%`, opacity: 1 },
  );
  return (
    <Animated.View style={[styles.grammarItem, style]}>
      <View style={styles.grammarChip}>
        <Text style={styles.grammarChipText}>{item.pattern}</Text>
      </View>
      <Text style={styles.grammarExplanation}>{item.explanation}</Text>
      {span ? (
        <View style={styles.grammarSentenceRow}>
          <Text style={styles.grammarSentenceText}>{before}</Text>
          <View style={styles.grammarSpanWrap}>
            <Animated.View style={[styles.grammarSpanFill, highlightStyle]} />
            <Text style={[styles.grammarSentenceText, styles.grammarSpanText]}>{span}</Text>
          </View>
          <Text style={styles.grammarSentenceText}>{after}</Text>
        </View>
      ) : null}
    </Animated.View>
  );
}

function SummaryBlock({ text, index, reducedMotion }: { text: string; index: number; reducedMotion: boolean }) {
  const { style } = useStagger(index, reducedMotion);
  return <Animated.Text style={[styles.summary, style]}>{text}</Animated.Text>;
}

// One full sweep of the shimmer: dim to bright and back.
const SHIMMER_MS = 900;
// The static opacity used instead of the sweep when reduced motion is on:
// dim enough to still read as "not the real content" without any motion.
const SHIMMER_STATIC_OPACITY = 0.55;

/** Placeholder shapes in the same layout as the loaded sections, so the
 * sheet's size and structure do not jump once the answer lands. A shimmer
 * (opacity pulsing between dim and bright, driven on the UI thread) sweeps
 * across every block so the loading state reads as active rather than
 * stalled; reduced motion gets a single dim, unanimated opacity instead. */
function SkeletonBody() {
  const reducedMotion = useReducedMotion();
  const shimmer = useSharedValue(reducedMotion ? SHIMMER_STATIC_OPACITY : 0.3);

  useEffect(() => {
    if (reducedMotion) {
      cancelAnimation(shimmer);
      shimmer.value = SHIMMER_STATIC_OPACITY;
      return;
    }
    shimmer.value = withRepeat(
      withSequence(
        withTiming(1, { duration: SHIMMER_MS, easing: Easing.inOut(Easing.sin) }),
        withTiming(0.3, { duration: SHIMMER_MS, easing: Easing.inOut(Easing.sin) }),
      ),
      -1,
    );
    return () => cancelAnimation(shimmer);
  }, [reducedMotion, shimmer]);

  const shimmerStyle = useAnimatedStyle(() => ({ opacity: shimmer.value }));

  return (
    <Animated.View exiting={FadeOut.duration(220)}>
      <View style={styles.section}>
        <Animated.View style={[styles.skeletonBlock, styles.skeletonLabel, shimmerStyle]} />
        <View style={styles.vocabList}>
          {Array.from({ length: SKELETON_ROWS }).map((_, i) => (
            <View key={i} style={styles.vocabRow}>
              <Animated.View style={[styles.vocabBar, styles.skeletonBlock, shimmerStyle]} />
              <View style={styles.vocabWord}>
                <Animated.View style={[styles.skeletonBlock, styles.skeletonWord, shimmerStyle]} />
                <Animated.View style={[styles.skeletonBlock, styles.skeletonReading, shimmerStyle]} />
              </View>
              <Animated.View style={[styles.skeletonBlock, styles.skeletonMeaning, shimmerStyle]} />
            </View>
          ))}
        </View>
      </View>
      <View style={styles.section}>
        <Animated.View style={[styles.skeletonBlock, styles.skeletonLabel, shimmerStyle]} />
        <Animated.View style={[styles.skeletonBlock, styles.skeletonChip, shimmerStyle]} />
      </View>
      <View style={styles.section}>
        <Animated.View style={[styles.skeletonBlock, styles.skeletonLabel, shimmerStyle]} />
        <Animated.View style={[styles.skeletonBlock, styles.skeletonSummaryLine, shimmerStyle]} />
        <Animated.View
          style={[styles.skeletonBlock, styles.skeletonSummaryLine, shimmerStyle, { width: '70%' }]}
        />
      </View>
    </Animated.View>
  );
}

const SKELETON_COLOR = 'rgba(255,255,255,0.08)';

const styles = StyleSheet.create({
  headerWrap: {
    borderRadius: Radius.md,
    backgroundColor: 'rgba(255,255,255,0.05)',
    paddingVertical: Spacing.md,
    paddingHorizontal: Spacing.lg,
    marginBottom: Spacing.lg,
  },
  headerJa: { fontFamily: fonts.serifJp, fontSize: 17, lineHeight: 26, color: tide.text },
  headerWords: { flexDirection: 'row', flexWrap: 'wrap', position: 'relative' },
  headerWord: { flexShrink: 1, maxWidth: '100%' },
  headerJaMarked: { fontWeight: '700', backgroundColor: 'rgba(255,158,128,0.12)' },
  headerEn: { fontFamily: fonts.ui, fontSize: 13, lineHeight: 18, color: tide.textDim, marginTop: 4 },
  markedWrap: { alignSelf: 'flex-start', marginBottom: Spacing.lg },
  marked: {
    fontFamily: fonts.uiMedium,
    fontWeight: '500',
    fontSize: 13,
    color: tide.textDim,
  },
  scroll: { maxHeight: 420 },
  scrollContent: { paddingBottom: Spacing.lg },
  section: { marginBottom: Spacing.xl },
  sectionLabel: {
    fontFamily: fonts.uiMedium,
    fontWeight: '500',
    fontSize: 12,
    letterSpacing: 0.6,
    textTransform: 'uppercase',
    color: tide.textDim,
    marginBottom: Spacing.md,
  },

  vocabList: { gap: Spacing.md },
  vocabRow: { flexDirection: 'row', alignItems: 'flex-start', gap: Spacing.md },
  vocabBar: { width: 4, alignSelf: 'stretch', borderRadius: 2, minHeight: 32 },
  vocabWord: { width: 92 },
  vocabWordText: { fontFamily: fonts.serifJp, fontSize: 18, fontWeight: '700', color: tide.text },
  vocabReading: { fontFamily: fonts.serifJp, fontSize: 12, color: tide.textDim, marginTop: 2 },
  vocabMeaning: { flex: 1, fontFamily: fonts.ui, fontSize: 14, lineHeight: 20, color: tide.text, paddingTop: 2 },

  grammarList: { gap: Spacing.md },
  grammarItem: { gap: Spacing.xs },
  grammarChip: {
    alignSelf: 'flex-start',
    backgroundColor: tide.lang.ja,
    borderRadius: Radius.pill,
    paddingHorizontal: Spacing.md,
    paddingVertical: Spacing.xs,
  },
  grammarChipText: { fontFamily: fonts.serifJp, fontSize: 14, fontWeight: '700', color: tide.sky[0] },
  grammarExplanation: { fontFamily: fonts.ui, fontSize: 14, lineHeight: 20, color: tide.text },
  grammarSentenceRow: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'baseline', marginTop: 2 },
  grammarSentenceText: { fontFamily: fonts.serifJp, fontSize: 13, lineHeight: 20, color: tide.textDim },
  grammarSpanWrap: { position: 'relative', overflow: 'hidden', borderRadius: 4 },
  grammarSpanFill: { position: 'absolute', left: 0, top: 0, bottom: 0, backgroundColor: 'rgba(255,158,128,0.16)' },
  grammarSpanText: { color: tide.lang.ja },

  summary: { fontFamily: fonts.ui, fontSize: 15, lineHeight: 22, color: tide.text },

  skeletonBlock: { backgroundColor: SKELETON_COLOR, borderRadius: Radius.sm },
  skeletonLabel: { width: 84, height: 11, marginBottom: Spacing.md, borderRadius: 4 },
  skeletonWord: { width: 64, height: 16, borderRadius: 4 },
  skeletonReading: { width: 44, height: 10, marginTop: 6, borderRadius: 4 },
  skeletonMeaning: { flex: 1, height: 16, alignSelf: 'center', borderRadius: 4 },
  skeletonChip: { width: 96, height: 30, borderRadius: Radius.pill },
  skeletonSummaryLine: { width: '100%', height: 14, marginTop: Spacing.sm, borderRadius: 4 },
});
