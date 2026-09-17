/**
 * Length and pitch feedback for one take, drawn as a row of kana under the
 * sentence: a coral underline where a long vowel or geminate was clipped
 * short, and a tick where a phrase's pitch fall landed (green) or flattened
 * (coral). Plain Views and Text, nothing per frame, so it costs nothing
 * while the player scrolls or plays.
 */

import { memo, useMemo } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import Animated, { FadeIn } from 'react-native-reanimated';

import { fonts } from '@/constants/fonts';
import { tide } from '@/constants/theme';
import type { AnalysedMora, Mora, TakeAnalysis } from '@/lib/api';

export type TakeFeedbackProps = {
  moras: Mora[];
  analysis: TakeAnalysis | null;
};

// The palette's only green, tide.pos.verb, reused here for a nucleus hit.
const HIT = '#5FD9A6';
// Same ink RubyWord's pitch strip draws for the model line (ruby-word.tsx PITCH_INK).
const MODEL_INK = 'rgba(255,158,128,0.7)';

const PLOT_HEIGHT = 18;

/** A single row's height: `plot` (20) plus the kana's line height (16) plus
 * the underline's own margin and height (1 + 2). A caller that mounts and
 * unmounts this row (auto-echo-sheet.tsx) reserves this much space up front
 * so that swap does not resize its container. */
export const ROW_HEIGHT = 39;

type Cell = {
  key: number;
  phrase: number;
  kana: string;
  lineY: number | null;
  takeY: number | null;
  nucleus: AnalysedMora['nucleus'];
  clipped: boolean;
  dim: boolean;
};

export const TakeFeedback = memo(function TakeFeedback({ moras, analysis }: TakeFeedbackProps) {
  const groups = useMemo(() => {
    if (!analysis || analysis.moras.length === 0) return [];
    const values: number[] = [];
    for (const m of analysis.moras) {
      if (m.lineSt !== null) values.push(m.lineSt);
      if (m.takeSt !== null) values.push(m.takeSt);
    }
    const lo = Math.min(-3, ...values);
    const hi = Math.max(3, ...values);
    const span = hi - lo;
    const yOf = (st: number) => Math.round((1 - (Math.min(hi, Math.max(lo, st)) - lo) / span) * PLOT_HEIGHT);

    const cells: Cell[] = analysis.moras.map((m) => {
      const source = moras[m.i];
      return {
        key: m.i,
        phrase: source?.phrase ?? 0,
        kana: source?.kana ?? m.text ?? '',
        lineY: m.lineSt === null ? null : yOf(m.lineSt),
        takeY: m.takeSt === null ? null : yOf(m.takeSt),
        nucleus: m.nucleus,
        clipped: m.length === 'clipped',
        dim: m.length === 'none' || m.nucleus === 'none',
      };
    });

    const out: Cell[][] = [];
    for (const cell of cells) {
      const last = out[out.length - 1];
      if (last && last[0].phrase === cell.phrase) last.push(cell);
      else out.push([cell]);
    }
    return out;
  }, [moras, analysis]);

  if (!analysis || analysis.moras.length === 0) return null;
  if (analysis.note) return <Text style={styles.note}>{analysis.note}</Text>;

  return (
    <Animated.View entering={FadeIn.duration(180)} style={styles.row}>
      {groups.map((group, gi) => (
        <View key={gi} style={styles.group}>
          {group.map((cell) => (
            <View key={cell.key} style={styles.cell}>
              <View style={styles.plot}>
                {cell.lineY !== null ? (
                  <View style={[styles.bar, { top: cell.lineY, backgroundColor: MODEL_INK }]} />
                ) : null}
                {cell.takeY !== null ? (
                  <View style={[styles.bar, { top: cell.takeY, backgroundColor: tide.listen }]} />
                ) : null}
                {cell.nucleus !== null ? (
                  <View
                    style={[
                      styles.tick,
                      {
                        backgroundColor:
                          cell.nucleus === 'hit' ? HIT : cell.nucleus === 'miss' ? tide.record : tide.textDim,
                      },
                    ]}
                  />
                ) : null}
              </View>
              <Text style={[styles.kana, cell.dim && styles.kanaDim]}>{cell.kana}</Text>
              <View style={[styles.underline, cell.clipped && styles.underlineClipped]} />
            </View>
          ))}
        </View>
      ))}
    </Animated.View>
  );
});

const styles = StyleSheet.create({
  note: { fontFamily: fonts.ui, fontSize: 12, textAlign: 'center', color: tide.textDim, marginTop: 2 },
  row: { flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'center', rowGap: 4 },
  group: { flexDirection: 'row', marginHorizontal: 5 },
  cell: { width: 16, alignItems: 'center' },
  plot: { height: 20, alignSelf: 'stretch', position: 'relative' },
  bar: { position: 'absolute', left: 0, right: 0, height: 2, borderRadius: 1 },
  tick: { position: 'absolute', right: 0, top: 0, width: 2, height: 20 },
  kana: { fontFamily: fonts.serifJp, fontSize: 12, lineHeight: 16, includeFontPadding: false, color: tide.text },
  kanaDim: { color: tide.textDim },
  underline: { alignSelf: 'stretch', height: 2, borderRadius: 1, marginTop: 1, backgroundColor: 'transparent' },
  underlineClipped: { backgroundColor: tide.record },
});
