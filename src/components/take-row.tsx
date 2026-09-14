import { Pressable, StyleSheet, Text, View } from 'react-native';

import { LevelBars } from '@/components/level-bars';
import { Radius, Spacing } from '@/constants/theme';
import { useTheme } from '@/hooks/use-theme';
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

/** Summary line for a take's timing score: counts of early, late and dropped
 * words, "All words in time" when there are none, and how far behind or
 * ahead of the voice the take ran when that is more than a quarter second.
 * Null when there is no score yet, and when it exists but scored no words,
 * `score.note` explains why. */
function scoreText(score: TakeScore | null): string | null {
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
    return score.note ? `Timing not scored: ${score.note}.` : null;
  }
  const parts: string[] = [];
  if (early) parts.push(`Early ${early}`);
  if (late) parts.push(`Late ${late}`);
  if (dropped) parts.push(`Dropped ${dropped}`);
  let text = parts.length ? parts.join(' · ') : 'All words in time';
  if (score.behindMs !== null && Math.abs(score.behindMs) > 250) {
    const secs = (Math.abs(score.behindMs) / 1000).toFixed(1);
    text += score.behindMs > 0 ? ` · Behind the voice by ${secs}s` : ` · Ahead of the voice by ${secs}s`;
  }
  return text;
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
  const { palette } = useTheme();
  const myTakeOn = takePlaying && !comparing;
  const statusText = cleanStatusText(clean);
  const scoreLine = phase === 'ready' ? scoreText(score) : null;

  return (
    <View>
      <View style={styles.row}>
        <Text style={[styles.label, { color: palette.muted }]}>Take</Text>
        {phase === 'recording' ? (
          <LevelBars level={level} live />
        ) : phase === 'idle' ? (
          <>
            <Pressable
              onPress={onRecord}
              style={[styles.pill, { backgroundColor: palette.surface, borderColor: palette.line }]}>
              <Text style={[styles.pillText, { color: palette.ink }]}>Record my take</Text>
            </Pressable>
            <Pressable
              onPress={onCalibrate}
              style={[styles.pill, { backgroundColor: palette.surface, borderColor: palette.line }]}>
              <Text style={[styles.pillText, { color: palette.ink }]}>Calibrate speaker</Text>
            </Pressable>
          </>
        ) : (
          <>
            <Pressable
              onPress={onCompare}
              style={[
                styles.pill,
                {
                  backgroundColor: comparing ? palette.accent : palette.surface,
                  borderColor: comparing ? palette.accent : palette.line,
                },
              ]}>
              <Text style={[styles.pillText, { color: comparing ? palette.accentInk : palette.ink }]}>
                {comparing ? 'Stop' : 'Compare'}
              </Text>
            </Pressable>
            <Pressable
              onPress={onPlayTake}
              style={[
                styles.pill,
                {
                  backgroundColor: myTakeOn ? palette.accent : palette.surface,
                  borderColor: myTakeOn ? palette.accent : palette.line,
                },
              ]}>
              <Text style={[styles.pillText, { color: myTakeOn ? palette.accentInk : palette.ink }]}>
                {myTakeOn ? 'Stop' : 'My take'}
              </Text>
            </Pressable>
            <Pressable
              onPress={onRecord}
              style={[styles.pill, { backgroundColor: palette.surface, borderColor: palette.line }]}>
              <Text style={[styles.pillText, { color: palette.ink }]}>Again</Text>
            </Pressable>
            <Pressable
              onPress={onCalibrate}
              style={[styles.pill, { backgroundColor: palette.surface, borderColor: palette.line }]}>
              <Text style={[styles.pillText, { color: palette.ink }]}>Calibrate speaker</Text>
            </Pressable>
          </>
        )}
      </View>

      {phase === 'idle' ? (
        <Text style={[styles.hint, { color: palette.muted }]}>
          The line plays and you speak along. Earphones keep the original out of your take.
        </Text>
      ) : phase === 'recording' ? (
        <Text style={[styles.hint, { color: palette.muted }]}>
          {calibrating
            ? 'Stay quiet. The line plays and the phone learns its own speaker.'
            : 'Speak along. It stops on its own after the line.'}
        </Text>
      ) : null}

      {statusText ? <Text style={[styles.status, { color: palette.muted }]}>{statusText}</Text> : null}

      {scoreLine ? <Text style={[styles.status, { color: palette.muted }]}>{scoreLine}</Text> : null}

      {error ? <Text style={[styles.error, { color: palette.danger }]}>{error}</Text> : null}
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
  label: { fontSize: 13, fontWeight: '600', minWidth: 52 },
  pill: {
    borderWidth: 1,
    borderRadius: Radius.pill,
    paddingVertical: Spacing.xs + 2,
    paddingHorizontal: Spacing.md,
  },
  pillText: { fontSize: 13, fontWeight: '700' },
  hint: { fontSize: 12, lineHeight: 17, textAlign: 'center', marginTop: Spacing.xs },
  status: { fontSize: 12, lineHeight: 16, textAlign: 'center', marginTop: Spacing.xs },
  error: { fontSize: 13, lineHeight: 19, textAlign: 'center', marginTop: Spacing.xs },
});
