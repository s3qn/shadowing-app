import { type RefObject, useCallback, useEffect, useRef, useState } from 'react';
import { type NativeScrollEvent, type NativeSyntheticEvent, useWindowDimensions } from 'react-native';

export const LONG_ISLAND = 120; // fewer lines: mount everything, as now
export const PAST_ROWS = 24; // mounted rows above the active line
export const NEXT_ROWS = 40; // mounted rows below it
export const EDGE = 8; // recentre when the active line gets this close to an edge
export const EXTEND = 40; // rows added when a hand scroll reaches a spacer
// Opened under the card morph, the window starts this narrow and widens to
// PAST_ROWS/NEXT_ROWS once the cover is gone.
export const NARROW_PAST_ROWS = 6;
export const NARROW_NEXT_ROWS = 10;
// How long the widening waits for the rows it measures before it goes ahead.
const MEASURE_FALLBACK_MS = 600;
/** Most rows the window may span before it is recentred on the active line. */
export const MAX_SPAN = PAST_ROWS + NEXT_ROWS + 1 + 2 * EXTEND;

// Height estimate for rows never measured, from TranscriptLine's styles: text
// is 18px with a 28px line height. A past row is dimLine (5+5 vertical, 16+16
// sides) around a bordered card (1+1 border, 10+10 vertical, 16+16 sides). A
// next row sits in the water (16+16 sides) inside dimLine, around
// submergedRow (10+10 vertical, 16+16 sides) with no border.
const TEXT_LINE_H = 28;
const CHAR_W = 18;
const PAST_ROW = { base: 32, inset: 66 };
const NEXT_ROW = { base: 30, inset: 96 };

/** Whether windowing is on for an island of this many lines. */
export function isWindowed(lineCount: number): boolean {
  return lineCount > LONG_ISLAND;
}

/** Mounted rows are `start..end-1`. The active line is always inside it. */
export type Window = { start: number; end: number };

/** A safe line index: finite, and inside `0..lineCount-1`. `lineCount <= 0`
 * (an island still loading) reads as line 0 so nothing downstream divides by
 * zero or produces NaN. */
function safeIndex(lineIndex: number, lineCount: number): number {
  if (!Number.isFinite(lineIndex)) return 0;
  return Math.max(0, Math.min(Math.trunc(lineIndex), Math.max(0, lineCount - 1)));
}

function clampWindow(w: Window, lineCount: number): Window {
  const n = Number.isFinite(lineCount) ? Math.max(0, Math.trunc(lineCount)) : 0;
  const start = Math.max(0, Math.min(Math.trunc(w.start), n));
  const end = Math.max(start, Math.min(Math.trunc(w.end), n));
  return { start, end };
}

function centredWindow(lineIndex: number, lineCount: number, narrow = false): Window {
  const i = safeIndex(lineIndex, lineCount);
  const past = narrow ? NARROW_PAST_ROWS : PAST_ROWS;
  const next = narrow ? NARROW_NEXT_ROWS : NEXT_ROWS;
  return clampWindow({ start: i - past, end: i + next + 1 }, lineCount);
}

export function initialWindow(lineIndex: number, lineCount: number, narrow = false): Window {
  if (!isWindowed(lineCount)) return { start: 0, end: Math.max(0, lineCount) };
  return centredWindow(lineIndex, lineCount, narrow);
}

/** `keep=true` (auto-scroll off, the user is reading elsewhere): union of the
 * old window and a window centred on the active line, so nothing already
 * mounted disappears while the user is not following along. A union that
 * would have to grow past `MAX_SPAN` rows (a jump far away, such as Repeat
 * Island wrapping to line 1) is the centred window instead. A window the
 * user stretched by scrolling stays as it is while it holds the centred one.
 * `keep=false`: recentre on the active line, unless it is already more than
 * `EDGE` rows inside a window no wider than `MAX_SPAN`. */
export function followWindow(
  w: Window,
  lineIndex: number,
  lineCount: number,
  keep: boolean,
  narrow = false,
): Window {
  if (!isWindowed(lineCount)) return { start: 0, end: Math.max(0, lineCount) };
  const i = safeIndex(lineIndex, lineCount);
  const centred = centredWindow(lineIndex, lineCount, narrow);
  // Narrow, the window is just the centred one: it widens soon anyway.
  if (narrow) return centred;
  if (keep) {
    if (centred.start >= w.start && centred.end <= w.end) return clampWindow(w, lineCount);
    const union = clampWindow({ start: Math.min(w.start, centred.start), end: Math.max(w.end, centred.end) }, lineCount);
    return union.end - union.start > MAX_SPAN ? centred : union;
  }
  const wellInside = i >= w.start && i < w.end && i - w.start > EDGE && w.end - 1 - i > EDGE;
  return wellInside && w.end - w.start <= MAX_SPAN ? clampWindow(w, lineCount) : centred;
}

export function extendWindow(w: Window, dir: 'up' | 'down', lineCount: number): Window {
  if (dir === 'up') return clampWindow({ start: w.start - EXTEND, end: w.end }, lineCount);
  return clampWindow({ start: w.start, end: w.end + EXTEND }, lineCount);
}

/** Estimated height of a row never measured: its text wrapped at the row's
 * inner width. */
function estimateRow(text: string | undefined, width: number, row: { base: number; inset: number }): number {
  const inner = Number.isFinite(width) ? width - row.inset : 0;
  const charsPerRow = Math.max(1, Math.floor(inner / CHAR_W));
  const len = typeof text === 'string' ? text.length : 0;
  return row.base + TEXT_LINE_H * Math.max(1, Math.ceil(len / charsPerRow));
}

function estimatePastRow(text: string | undefined, width: number): number {
  return estimateRow(text, width, PAST_ROW);
}

/** Sum of measured heights for rows `from..to-1`, an estimate from the text
 * for rows never mounted. */
export function spacerHeight(
  from: number,
  to: number,
  heights: Map<number, number>,
  lines: readonly string[],
  width: number,
  tone: 'past' | 'next',
): number {
  if (!Number.isFinite(from) || !Number.isFinite(to) || to <= from) return 0;
  const row = tone === 'past' ? PAST_ROW : NEXT_ROW;
  let sum = 0;
  for (let i = from; i < to; i++) {
    const h = heights.get(i);
    sum += Number.isFinite(h) && (h as number) > 0 ? (h as number) : estimateRow(lines[i], width, row);
  }
  return Number.isFinite(sum) ? sum : 0;
}

export function useTranscriptWindow(args: {
  lineIndex: number;
  lineCount: number;
  lines: readonly string[];
  autoScroll: RefObject<boolean>;
  /** Content padding above the first row, as a fraction of the scroll view's height. */
  padTop: number;
  /** Content padding below the last row, as a fraction of the scroll view's height. */
  padBottom: number;
  /** Start narrow, and widen when this calls back (it returns a cancel).
   * Read once, at mount. */
  widenWhen?: (widen: () => void) => () => void;
}) {
  const { lineIndex, lineCount, lines, autoScroll, padTop, padBottom, widenWhen } = args;

  // Read through refs so the stable onScroll callback below always sees the
  // latest values without needing to change identity.
  const screenW = useWindowDimensions().width;
  const latest = useRef({ lineCount, lines, padTop, padBottom, screenW });
  latest.current = { lineCount, lines, padTop, padBottom, screenW };
  // The scroll view's own width once a scroll reports it, the screen's before.
  const scrollW = useRef(0);
  const widthNow = () => (scrollW.current > 0 ? scrollW.current : latest.current.screenW);

  // 'narrow' under the morph's cover; 'measure' while the past rows the
  // widening adds are mounted out of the flow to learn their real heights;
  // 'wide' after. The past spacer is then exact, so the widening never moves
  // the active card. Rows below the active line change nothing above it.
  const [phase, setPhase] = useState<'narrow' | 'measure' | 'wide'>(() => (widenWhen ? 'narrow' : 'wide'));
  const phaseRef = useRef(phase);
  phaseRef.current = phase;
  // Set once the widening was called for, even when it had nothing to do.
  const widenDue = useRef(false);
  const narrow = phase === 'narrow' && !widenDue.current;
  const windowRef = useRef<Window>(initialWindow(lineIndex, lineCount, narrow));
  const heights = useRef<Map<number, number>>(new Map());
  const prevLineCount = useRef(lineCount);
  const [, bumpExtend] = useState(0);
  // The past rows being measured, `start..end-1`, during 'measure'.
  const measureRef = useRef<Window | null>(null);
  // What the past spacer adds to its sum so the height above the mounted rows
  // stays what it was before the widening: the estimate for the measured rows
  // minus their real height. 0 until a widening, reset with the lines.
  const pastBias = useRef(0);
  const measuredBias = (m: Window | null) => {
    if (!m) return 0;
    const { lines } = latest.current;
    const width = widthNow();
    let b = 0;
    for (let i = m.start; i < m.end; i++) {
      const h = heights.current.get(i);
      if (Number.isFinite(h) && (h as number) > 0) b += estimatePastRow(lines[i], width) - (h as number);
    }
    return Number.isFinite(b) ? b : 0;
  };

  useEffect(() => {
    if (!widenWhen) return;
    return widenWhen(() => {
      widenDue.current = true;
      // A short island mounts every row anyway: nothing to widen, no render.
      const n = latest.current.lineCount;
      if (n > 0 && !isWindowed(n)) return;
      setPhase((p) => (p === 'narrow' ? 'measure' : p));
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- read once, at mount
  }, []);

  // Derived during render, not in an effect: a plain line change should not
  // cost an extra render.
  if (lineCount !== prevLineCount.current) {
    prevLineCount.current = lineCount;
    heights.current.clear();
    windowRef.current = initialWindow(lineIndex, lineCount, narrow);
    measureRef.current = null;
    pastBias.current = 0;
  } else if (phase === 'measure') {
    // The rows below widen at once; the rows above wait in the measure range.
    const wide = initialWindow(lineIndex, lineCount);
    const cur = followWindow(windowRef.current, lineIndex, lineCount, false, true);
    windowRef.current = clampWindow({ start: cur.start, end: Math.max(cur.end, wide.end) }, lineCount);
    const m = clampWindow({ start: wide.start, end: cur.start }, lineCount);
    measureRef.current = m.end > m.start ? m : null;
  } else {
    windowRef.current = followWindow(windowRef.current, lineIndex, lineCount, !autoScroll.current, narrow);
  }
  const window = windowRef.current;
  const measure = phase === 'measure' ? measureRef.current : null;

  const toWide = useCallback(() => {
    if (phaseRef.current !== 'measure') return;
    phaseRef.current = 'wide';
    const m = measureRef.current;
    pastBias.current += measuredBias(m);
    measureRef.current = null;
    if (m) windowRef.current = { start: Math.min(windowRef.current.start, m.start), end: windowRef.current.end };
    setPhase('wide');
  }, []);

  // Nothing to measure (the active line near the top): straight to wide.
  // Otherwise wide once every measured row reported, or after the fallback.
  useEffect(() => {
    if (phase !== 'measure') return;
    if (!measureRef.current) {
      toWide();
      return;
    }
    const t = setTimeout(toWide, MEASURE_FALLBACK_MS);
    return () => clearTimeout(t);
  }, [phase, toWide]);

  const onRowLayout = useCallback(
    (index: number, height: number) => {
      if (!Number.isFinite(index) || !Number.isFinite(height) || height <= 0) return;
      heights.current.set(index, height);
      const m = measureRef.current;
      if (phaseRef.current !== 'measure' || !m || index < m.start || index >= m.end) return;
      for (let i = m.start; i < m.end; i++) if (!heights.current.has(i)) return;
      toWide();
    },
    [toWide],
  );

  const onScroll = useCallback((e: NativeSyntheticEvent<NativeScrollEvent>) => {
    const { lineCount, lines, padTop, padBottom } = latest.current;
    if (!isWindowed(lineCount)) return;
    const { contentOffset, layoutMeasurement, contentSize } = e.nativeEvent;
    if (!contentOffset || !layoutMeasurement || !contentSize) return;
    const top = contentOffset.y;
    const viewH = layoutMeasurement.height;
    const bottom = top + viewH;
    if (!Number.isFinite(top) || !Number.isFinite(viewH) || !Number.isFinite(contentSize.height)) return;
    if (Number.isFinite(layoutMeasurement.width) && layoutMeasurement.width > 0) {
      scrollW.current = layoutMeasurement.width;
    }
    const width = widthNow();
    const padT = Number.isFinite(padTop) ? padTop * viewH : 0;
    const padB = Number.isFinite(padBottom) ? padBottom * viewH : 0;

    let w = windowRef.current;
    let changed = false;
    if (w.start > 0) {
      const pastH = spacerHeight(0, w.start, heights.current, lines, width, 'past');
      if (top < padT + pastH + 300) {
        w = extendWindow(w, 'up', lineCount);
        changed = true;
      }
    }
    if (w.end < lineCount) {
      const nextH = spacerHeight(w.end, lineCount, heights.current, lines, width, 'next');
      if (contentSize.height - bottom < padB + nextH + 300) {
        w = extendWindow(w, 'down', lineCount);
        changed = true;
      }
    }
    if (changed) {
      windowRef.current = w;
      bumpExtend((t) => t + 1);
    }
  }, []);

  // Signed, and applied at line 0 too: the past rows' container takes it as
  // its top margin, so the height above the active card is the estimate for
  // rows `0..start-1` plus the bias whether the window starts at 0 or not, and
  // whether real rows came out taller (a negative bias) or shorter.
  const bias = pastBias.current + measuredBias(measure);
  const offset = spacerHeight(0, window.start, heights.current, lines, widthNow(), 'past') + bias;
  const pastOffset = Number.isFinite(offset) ? offset : 0;
  const nextSpacerH = spacerHeight(window.end, lineCount, heights.current, lines, widthNow(), 'next');

  return { window, measure, onRowLayout, pastOffset, nextSpacerH, onScroll };
}
