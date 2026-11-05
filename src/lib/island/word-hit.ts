import type * as api from '@/lib/api';

export type WordBox = { x: number; y: number; width: number; height: number };
export type WordBoxes = Record<number, WordBox>;

// Hit-tests a point in styles.words' own coordinate space (what
// GestureDetector reports touches in, since it wraps that view) to a word
// index: the row whose y-range contains the point (or the closest one by
// vertical distance, for a touch between rows), then within that row the
// word whose x-range is closest, which clamps a drag past either edge of a
// row to that edge rather than spilling onto the next one. Blind mode has
// nothing to hit.
export function hitTest(boxes: WordBoxes, wordCount: number, x: number, y: number): number | null {
  const indices = Object.keys(boxes)
    .map(Number)
    .filter((i) => i < wordCount);
  if (indices.length === 0) return null;
  let rowY = boxes[indices[0]!]!.y;
  let exact = false;
  for (const i of indices) {
    const b = boxes[i]!;
    if (y >= b.y && y < b.y + b.height) {
      rowY = b.y;
      exact = true;
      break;
    }
  }
  if (!exact) {
    let best = Infinity;
    for (const i of indices) {
      const b = boxes[i]!;
      const dist = Math.abs(y - (b.y + b.height / 2));
      if (dist < best) {
        best = dist;
        rowY = b.y;
      }
    }
  }
  const row = indices.filter((i) => Math.abs(boxes[i]!.y - rowY) < 2).sort((a, b) => a - b);
  let picked = row[0]!;
  let bestXDist = Infinity;
  for (const i of row) {
    const b = boxes[i]!;
    if (x >= b.x && x < b.x + b.width) return i;
    const dist = x < b.x ? b.x - x : x - (b.x + b.width);
    if (dist < bestXDist) {
      bestXDist = dist;
      picked = i;
    }
  }
  return picked;
}

/** The first later line that is longer (words, or characters without them) and not known; else the first later unknown line; else stay. */
export function nextLongerIdx(island: { lines: api.Line[] } | null | undefined, known: ReadonlySet<number>, i: number): number {
  const cur = island?.lines[i];
  if (!island || !cur) return i;
  const len = (l: api.Line) => l.words.length || Array.from(l.ja).length;
  const later = island.lines
    .map((l, j) => ({ l, j }))
    .slice(i + 1)
    .filter(({ l }) => !known.has(l.idx));
  return later.find(({ l }) => len(l) > len(cur))?.j ?? later[0]?.j ?? i;
}
