import { StyleSheet, View } from 'react-native';

import type { MoraPitch, PitchCell } from '@/lib/pitch';

/** Height of the pitch strip over a word: the only space pitch adds. */
const STRIP = 6;
const STROKE = 1.5;

// tide.lang.ja at 70%, so a bar and a step that overlap at a corner do not
// double up the way view opacity would.
export const PITCH_INK = 'rgba(255,158,128,0.7)';

/** The pitch line over one run of cells, drawn with plain Views: a bar per
 * mora at the top (high) or the bottom (low) of the strip, and a vertical
 * bar for each rise and drop. Concealed, the strip keeps its height and
 * draws nothing. */
export function PitchStrip({ cells, pitch, concealed }: { cells: PitchCell[]; pitch: MoraPitch[]; concealed?: boolean }) {
  if (concealed) return <View style={styles.strip} pointerEvents="none" />;
  // Which mora each cell shows, -1 for a cell with none.
  const moraAt: number[] = [];
  let k = 0;
  for (const cell of cells) {
    moraAt.push(cell.mora ? k : -1);
    if (cell.mora) k += 1;
  }
  return (
    <View style={styles.strip} pointerEvents="none">
      {cells.map((cell, i) => {
        const m = moraAt[i] ?? -1;
        const p = m >= 0 ? pitch[m] : undefined;
        return (
          <View key={i} style={{ flex: cell.w }}>
            {p ? (
              <>
                <View style={[styles.bar, p.high ? styles.high : styles.low]} />
                {p.rise ? <View style={[styles.step, styles.stepLeft]} /> : null}
                {p.drop ? <View style={[styles.step, styles.stepRight]} /> : null}
              </>
            ) : null}
          </View>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  strip: { height: STRIP, alignSelf: 'stretch', flexDirection: 'row' },
  bar: { position: 'absolute', left: 0, right: 0, height: STROKE, backgroundColor: PITCH_INK },
  high: { top: 0 },
  low: { bottom: 0 },
  step: { position: 'absolute', top: 0, width: STROKE, height: STRIP, backgroundColor: PITCH_INK },
  stepLeft: { left: 0 },
  stepRight: { right: 0 },
});
