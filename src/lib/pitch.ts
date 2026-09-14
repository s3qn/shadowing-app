import type { Mora } from '@/lib/api';

/** One mora of the reading with the pitch strokes to draw on it. */
export type PitchCell = {
  kana: string;
  /** Draw the bar along the top. */
  high: boolean;
  /** This is the accent nucleus: the bar ends here with a drop tick. */
  drop: boolean;
  /** First mora of a new accent phrase: leave a gap before it. */
  phraseStart: boolean;
};

/**
 * Cells for the pitch strip, or null when the line has no accent data yet
 * (old island not backfilled, or a line the backend gave up on), in which
 * case the strip is not drawn.
 */
export function pitchCells(moras: Mora[]): PitchCell[] | null {
  if (moras.length === 0 || moras.some((m) => typeof m.high !== 'boolean')) return null;
  return moras.map((m, i) => {
    const next = i + 1 < moras.length ? moras[i + 1] : undefined;
    const prev = i > 0 ? moras[i - 1] : undefined;
    return {
      kana: m.kana,
      high: m.high === true,
      drop: m.high === true && next !== undefined && next.phrase === m.phrase && next.high === false,
      phraseStart: prev !== undefined && prev.phrase !== m.phrase,
    };
  });
}
