import { StyleSheet, Text, View } from 'react-native';

import { LevelBars } from '@/components/level-bars';
import { PressScale } from '@/components/press-scale';
import { fonts } from '@/constants/fonts';
import { Radius, Spacing, tide } from '@/constants/theme';
import type { CleanStatus, TakePhase } from '@/hooks/use-take';
import type { TakeScore } from '@/lib/api';

export type Props = {
  phase: TakePhase;
  level: number; // live mic level while recording
  takePlaying: boolean;
  comparing: boolean; // a Compare run is in progress (original or take playing)
  error: string;
  clean: CleanStatus; // backend echo cleanup status for the current take or calibration
  score: TakeScore | null; // timing score for the current take, once the upload answers
  calibrating: boolean; // true while a Calibrate speaker recording is in progress
  onRecord: () => void; // Record my take / Again
  onCompare: () => void; // toggles: starts a compare, or stops one in progress
  onPlayTake: () => void; // toggles: plays the take, or stops it
  onCalibrate: () => void; // starts a Calibrate speaker recording
};

function cleanStatusText(clean: CleanStatus): string | null {
  switch (clean.state) {
    case 'working':
      return 'Removing the original from your take…';
    case 'done': {
      const db = clean.erleDb === null ? null : Math.round(clean.erleDb);
      if (clean.note) {
        return db === null ? `${clean.note}.` : `${clean.note} (${db} dB).`;
      }
      return db === null ? 'Original removed.' : `Original removed: ${db} dB`;
    }
    case 'skipped':
      return 'No bleed found, take kept as recorded.';
    case 'failed':
      return 'Could not clean the take. Playing it as recorded.';
    default:
      return null;
  }
}

type ScoreSpan = { text: string; color: string };

/** Summary line for a take's timing score, as colored spans to render in
 * sequence: counts of early, late and dropped words (each in the mark
 * color `RubyWord` uses for that category), "All words in time" when there
 * are none, and how far behind or ahead of the voice the take ran when
 * that is more than a quarter second. Null when there is no score yet, and
 * when it exists but scored no words, `score.note` explains why as a
 * single dim span. */
function scoreText(score: TakeScore | null): ScoreSpan[] | null {
  if (!score) return null;
  let early = 0;
  let late = 0;
  let dropped = 0;
  let scored = 0;
  for (const w of score.words) {
    if (w === 'none') continue;
    scored++;
    if (w === 'early') early++;
    else if (w === 'late') late++;
    else if (w === 'dropped') dropped++;
  }
  if (scored === 0) {
    return score.note ? [{ text: `Timing not scored: ${score.note}.`, color: tide.textDim }] : null;
  }
  const spans: ScoreSpan[] = [];
  if (early) spans.push({ text: `Early ${early}`, color: tide.listen });
  if (late) spans.push({ text: `Late ${late}`, color: tide.turn });
  if (dropped) spans.push({ text: `Dropped ${dropped}`, color: tide.record });
  if (!spans.length) spans.push({ text: 'All words in time', color: tide.textDim });
  if (score.behindMs !== null && Math.abs(score.behindMs) > 250) {
    const secs = (Math.abs(score.behindMs) / 1000).toFixed(1);
    const text = score.behindMs > 0 ? `Behind the voice by ${secs}s` : `Ahead of the voice by ${secs}s`;
    spans.push({ text, color: tide.textDim });
  }
  return spans;
}

/**
 * The row of take controls under the ring: Record my take and Calibrate
 * speaker while there is no take, level bars while the mic is open, then
 * Compare, My take, Again and Calibrate speaker once a take is saved.
 */
export function TakeRow({
  phase,
  level,
  takePlaying,
  comparing,
  error,
  clean,
  score,
  calibrating,
  onRecord,
  onCompare,
  onPlayTake,
  onCalibrate,
}: Props) {
  const myTakeOn = takePlaying && !comparing;
  const statusText = cleanStatusText(clean);
  const scoreLine = phase === 'ready' ? scoreText(score) : null;

  return (
    <View>
      <View style={styles.row}>
        <Text style={styles.label}>Take</Text>
        {phase === 'recording' ? (
          <LevelBars level={level} live />
        ) : phase === 'idle' ? (
          <>
            <PressScale onPress={onRecord} style={styles.pill}>
              <Text style={styles.pillText}>Record my take</Text>
            </PressScale>
            <PressScale onPress={onCalibrate} style={styles.pill}>
              <Text style={styles.pillText}>Calibrate speaker</Text>
            </PressScale>
          </>
        ) : (
          <>
            <PressScale onPress={onCompare} style={[styles.pill, comparing && styles.pillActive]}>
              <Text style={[styles.pillText, comparing && styles.pillTextActive]}>{comparing ? 'Stop' : 'Compare'}</Text>
            </PressScale>
            <PressScale onPress={onPlayTake} style={[styles.pill, myTakeOn && styles.pillActive]}>
              <Text style={[styles.pillText, myTakeOn && styles.pillTextActive]}>{myTakeOn ? 'Stop' : 'My take'}</Text>
            </PressScale>
            <PressScale onPress={onRecord} style={styles.pill}>
              <Text style={styles.pillText}>Again</Text>
            </PressScale>
            <PressScale onPress={onCalibrate} style={styles.pill}>
              <Text style={styles.pillText}>Calibrate speaker</Text>
            </PressScale>
          </>
        )}
      </View>

      {phase === 'idle' ? (
        <Text style={styles.hint}>The line plays and you speak along. Earphones keep the original out of your take.</Text>
      ) : phase === 'recording' ? (
        <Text style={styles.hint}>
          {calibrating
            ? 'Stay quiet. The line plays and the phone learns its own speaker.'
            : 'Speak along. It stops on its own after the line.'}
        </Text>
      ) : null}

      {statusText ? <Text style={styles.status}>{statusText}</Text> : null}

      {scoreLine ? (
        <Text style={styles.status}>
          {scoreLine.map((span, i) => (
            <Text key={i} style={{ color: span.color }}>
              {i > 0 ? ' · ' : ''}
              {span.text}
            </Text>
          ))}
        </Text>
      ) : null}

      {error ? <Text style={styles.error}>{error}</Text> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.sm,
    justifyContent: 'center',
    minHeight: 56,
    flexWrap: 'wrap',
  },
  label: { fontSize: 13, fontFamily: fonts.ui, color: tide.textDim, minWidth: 52 },
  pill: {
    borderWidth: 1,
    borderRadius: Radius.pill,
    paddingVertical: Spacing.xs + 2,
    paddingHorizontal: Spacing.md,
    backgroundColor: 'rgba(255,255,255,0.08)',
    borderColor: 'rgba(255,255,255,0.12)',
  },
  pillActive: { backgroundColor: tide.record, borderColor: tide.record },
  pillText: { fontSize: 13, fontFamily: fonts.uiMedium, color: tide.textDim },
  pillTextActive: { color: tide.sky[0] },
  hint: { fontSize: 12, lineHeight: 17, textAlign: 'center', marginTop: Spacing.xs, fontFamily: fonts.ui, color: tide.textDim },
  status: { fontSize: 12, lineHeight: 16, textAlign: 'center', marginTop: Spacing.xs, fontFamily: fonts.ui, color: tide.textDim },
  error: { fontSize: 13, lineHeight: 19, textAlign: 'center', marginTop: Spacing.xs, fontFamily: fonts.ui, color: tide.record },
});
