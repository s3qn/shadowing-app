import type { Line } from '@/lib/api';

const hasText = (l: Line) => l.ja.replace(/\s/g, '').length > 0;
const hasTimings = (l: Line) => l.words.some((w) => w.end > w.start);

/**
 * The easiest lines to shadow from a video or episode, as line idx values in line order.
 * Short, timed, multi-word lines win; a saved line and a line the viewer replayed rank first.
 * With fewer than `count` good lines it relaxes to any line with text; with none it returns [].
 */
export function pickBestBits(lines: Line[], saved: Set<number>, replayed: Set<number>, count = 3): number[] {
  const score = (l: Line) => l.duration + 0.3 * l.words.length - (saved.has(l.idx) ? 100 : 0) - (replayed.has(l.idx) ? 50 : 0);
  const good = lines.filter(
    (l) => l.ja.replace(/\s/g, '').length >= 4 && l.duration >= 0.8 && l.duration <= 7 && l.words.length >= 2 && hasTimings(l),
  );
  const pool = good.length >= count ? good : lines.filter((l) => hasText(l) && l.duration > 0);
  return pool
    .slice()
    .sort((a, b) => score(a) - score(b))
    .slice(0, count)
    .map((l) => l.idx)
    .sort((a, b) => a - b);
}

/** The `pick` route param: comma-separated non-negative integers, deduped, else []. */
export function parsePick(s?: string): number[] {
  if (!s) return [];
  const parts = s.split(',');
  const out: number[] = [];
  for (const p of parts) {
    if (!/^\d+$/.test(p.trim())) return [];
    const n = Number(p.trim());
    if (!out.includes(n)) out.push(n);
  }
  return out;
}
