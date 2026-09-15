import type { Mora } from '@/lib/api';

/** The pitch of one spoken mora, as drawn over the word it falls in. */
export type MoraPitch = {
  high: boolean;
  /** Low to high inside one accent phrase: a step up on the left edge. */
  rise: boolean;
  /** The accent nucleus: the next mora of the phrase is low, so a tick down
   * on the right edge. */
  drop: boolean;
};

/**
 * Each word's moras with their pitch, grouped by which word's time span the
 * mora starts in (the same grouping the romaji line uses). Null when the line
 * has no accent data (an old island not backfilled, or a line the backend gave
 * up on), in which case no pitch is drawn at all.
 */
export function wordPitches(line: {
  timeline: Mora[];
  words: { start: number; end: number }[];
}): MoraPitch[][] | null {
  const { timeline: moras, words } = line;
  if (moras.length === 0 || words.length === 0 || moras.some((m) => typeof m.high !== 'boolean')) return null;
  const out: MoraPitch[][] = words.map(() => []);
  let cursor = 0;
  moras.forEach((m, i) => {
    while (cursor < words.length - 1 && m.start >= words[cursor]!.end - 1e-6) cursor += 1;
    const prev = i > 0 ? moras[i - 1] : undefined;
    const next = i + 1 < moras.length ? moras[i + 1] : undefined;
    out[cursor]!.push({
      high: m.high === true,
      rise: m.high === true && prev !== undefined && prev.phrase === m.phrase && prev.high === false,
      drop: m.high === true && next !== undefined && next.phrase === m.phrase && next.high === false,
    });
  });
  return out;
}

/** One stretch of a word's text along the pitch line: `w` is its width in
 * characters, `mora` whether a spoken mora sits over it (punctuation does not). */
export type PitchCell = { w: number; mora: boolean };

const SMALL = new Set(Array.from('ぁぃぅぇぉゃゅょゎァィゥェォャュョヮ'));

function isKana(ch: string): boolean {
  return (ch >= 'ぁ' && ch <= 'ゖ') || (ch >= 'ァ' && ch <= 'ヺ') || ch === 'ー';
}

function moraCount(reading: string): number {
  return Array.from(reading).filter((ch) => isKana(ch) && !SMALL.has(ch)).length;
}

/**
 * Where the moras of one run of text sit. A kanji run shares its width evenly
 * between the moras of its reading. A kana run gives each character its own
 * mora, a small kana (ゃ, ぇ) widens the mora before it, and anything else
 * (punctuation, digits) is a cell with no mora over it.
 */
export function runCells(text: string, rt: string): PitchCell[] {
  const chars = Array.from(text);
  if (rt) {
    const n = moraCount(rt);
    if (n === 0) return [{ w: chars.length, mora: false }];
    return Array.from({ length: n }, () => ({ w: chars.length / n, mora: true }));
  }
  const cells: PitchCell[] = [];
  for (const ch of chars) {
    const last = cells[cells.length - 1];
    if (SMALL.has(ch) && last?.mora) last.w += 1;
    else cells.push({ w: 1, mora: isKana(ch) });
  }
  return cells;
}

/** How many of `cells` carry a mora. */
export function moraCells(cells: PitchCell[]): number {
  return cells.reduce((n, c) => n + (c.mora ? 1 : 0), 0);
}
