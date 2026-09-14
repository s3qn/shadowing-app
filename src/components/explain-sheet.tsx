import { useEffect, useState } from 'react';
import { ActivityIndicator, ScrollView, StyleSheet, Text } from 'react-native';

import { BottomSheet } from '@/components/sheet/bottom-sheet';
import { fonts } from '@/constants/fonts';
import { Spacing, tide } from '@/constants/theme';
import * as api from '@/lib/api';

const FALLBACK_ANSWER = "Couldn't get an answer just now.";

// A fixed question, not something the learner types: covers what the
// selection needs explained so there is nothing to type before it fires.
// Asks for a compact three-part shape (meaning, grammar, nuance or reading)
// so the answer stays short: fewer output tokens means a faster reply.
const EXPLAIN_QUESTION =
  'Explain this in the context of the sentence, briefly: meaning, grammar, and nuance or reading.';

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
};

/**
 * Explains the marked words (or the whole line) as soon as the sheet opens:
 * no question to type, no thread, just a loading state and then the answer.
 */
export function ExplainSheet({
  open,
  onClose,
  onDismissed,
  sentenceJa,
  sentenceEn,
  marked,
  whole,
  generation,
}: Props) {
  const [answer, setAnswer] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const markedLabel = whole || marked.length === 0 ? 'Whole sentence' : marked.join('、');
  const markedKey = whole ? '' : marked.join('');

  useEffect(() => {
    if (!open || !sentenceJa) return;
    let cancelled = false;
    setAnswer(null);
    setLoading(true);
    (async () => {
      try {
        const text = await api.explainChat({
          sentenceJa,
          sentenceEn,
          marked: whole ? [] : marked,
          question: EXPLAIN_QUESTION,
          history: [],
        });
        if (!cancelled) setAnswer(text || FALLBACK_ANSWER);
      } catch {
        if (!cancelled) setAnswer(FALLBACK_ANSWER);
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

  return (
    <BottomSheet open={open} onClose={onClose} onDismissed={onDismissed} title="Explain">
      <Text style={styles.marked}>{markedLabel}</Text>
      <ScrollView style={styles.answerScroll} contentContainerStyle={styles.answerContent}>
        {loading ? (
          <ActivityIndicator color={tide.textDim} style={styles.spinner} />
        ) : (
          <Text style={styles.answer}>{answer}</Text>
        )}
      </ScrollView>
    </BottomSheet>
  );
}

const styles = StyleSheet.create({
  marked: {
    fontFamily: fonts.uiMedium,
    fontWeight: '500',
    fontSize: 13,
    color: tide.textDim,
    marginBottom: Spacing.md,
  },
  answerScroll: { maxHeight: 340 },
  answerContent: { paddingBottom: Spacing.md },
  spinner: { marginTop: Spacing.lg, marginBottom: Spacing.lg },
  answer: {
    fontFamily: fonts.ui,
    fontSize: 16,
    lineHeight: 24,
    color: tide.text,
  },
});
