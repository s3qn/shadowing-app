import type { Line } from '@/lib/api';

/**
 * The font scale (0..1] that lets a line's words fit in about two rows of
 * `width`. The single-row width at scale 1 is estimated from the character
 * count (`em` of the base size per character, 1.0 for Japanese, 0.6 for
 * Latin text) plus the 8 pt side padding of each word. The floor wins: a
 * line too long for two rows at `min` wraps to a third row instead of being
 * cut. An estimate, never a measurement, so it costs no layout pass.
 */
export function fitScale(
  line: Line,
  width: number,
  opts: { base: number; min: number; em: number },
): number {
  const { base, min, em } = opts;
  if (!(width > 0) || !(base > 0)) return 1;
  const estimate = Array.from(line.ja).length * em * base + line.words.length * 8;
  if (!(estimate > 0)) return 1;
  const raw = (2 * width) / estimate;
  return Math.min(1, Math.max(min / base, raw));
}
