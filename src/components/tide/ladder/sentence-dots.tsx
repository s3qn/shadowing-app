// focus-stories D10: the thin row of sentence dots between the Stories bar and the
// label line. The composer mounts this only when the host has a line count, with
// `index` the current line (0-based), `count` the line count and `tint` the current
// step's tint. Up to 40 lines: one 3pt dot per line, the current one 4pt in the tint.
// Over 40: a 2pt track with one 4pt tint dot at `(index + 0.5) / count`, so it stays on
// one line. `dir.row` like the bar (Hebrew fills from the right). Not tappable.
import { memo } from 'react';
import { StyleSheet, View } from 'react-native';

import { tide, withAlpha } from '@/constants/theme';
import { useDir, useT } from '@/lib/i18n';

export type SentenceDotsProps = { index: number; count: number; tint: string };

const MAX_DOTS = 40;
const UPCOMING = 'rgba(236,232,244,0.18)';

export const SentenceDots = memo(function SentenceDots({ index, count, tint }: SentenceDotsProps) {
  const { t } = useT();
  const dir = useDir();
  if (count <= 0) return null;
  const cur = Math.min(count - 1, Math.max(0, index));
  const label = t('ladder.sentenceDots', { n: cur + 1, total: count });
  if (count > MAX_DOTS) {
    const at = ((cur + 0.5) / count) * 100;
    return (
      <View style={styles.row} accessibilityLabel={label} pointerEvents="none">
        <View style={[styles.track, styles.fullWidth]}>
          <View
            style={[
              styles.thumb,
              { backgroundColor: tint },
              dir.rtl ? { right: `${at}%`, transform: [{ translateX: 2 }] } : { left: `${at}%`, transform: [{ translateX: -2 }] },
            ]}
          />
        </View>
      </View>
    );
  }
  return (
    <View style={[styles.row, styles.dots, dir.row]} accessibilityLabel={label} pointerEvents="none">
      {Array.from({ length: count }, (_, i) => (
        <View
          key={i}
          style={
            i === cur
              ? [styles.cur, { backgroundColor: tint }]
              : [styles.dot, { backgroundColor: i < cur ? withAlpha(tide.text, 0.55) : UPCOMING }]
          }
        />
      ))}
    </View>
  );
});

const styles = StyleSheet.create({
  row: { flexDirection: 'row', marginTop: 6, marginHorizontal: 16, height: 4, justifyContent: 'center' },
  dots: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 3 },
  dot: { width: 3, height: 3, borderRadius: 1.5 },
  cur: { width: 4, height: 4, borderRadius: 2 },
  fullWidth: { flex: 1 },
  track: { height: 2, borderRadius: 1, backgroundColor: UPCOMING },
  thumb: { position: 'absolute', top: -1, width: 4, height: 4, borderRadius: 2 },
});
