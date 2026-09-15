import type { AudioPlayer, AudioStatus } from 'expo-audio';
import { useCallback, useEffect, useRef } from 'react';
import {
  type FrameInfo,
  interpolateColor,
  type SharedValue,
  useAnimatedStyle,
  useFrameCallback,
  useSharedValue,
} from 'react-native-reanimated';

import { tide } from '@/constants/theme';
import type { Word } from '@/lib/api';

/**
 * The active word highlight, worked out on the UI thread from the audio
 * position alone, so the word colour and the underline can never disagree.
 *
 * Why a crossfade and not a left-to-right fill: a fill needs a masked copy of
 * every word, and a furigana word is a wrapping row of columns (one per kanji
 * run), so a fill would have to jump between columns and rows mid-word. A
 * crossfade centred on each word boundary looks the same on a plain word, a
 * ruby word and the Explain header, and at 100ms it reads as exact.
 *
 * The whole state is one number, `level`, in word-index units. Each word
 * boundary adds a 0..1 ramp to it, 100ms wide and centred on the boundary
 * (narrower when the words either side are shorter than that, so no two ramps
 * ever overlap). While word i holds, level is exactly i + 1; during the
 * handoff to i + 1 it runs from i + 1 to i + 2, which dims word i by exactly
 * as much as it lights word i + 1. So at most two words are ever lit, only
 * inside that window, and their two strengths always add up to one.
 */

/** Width of one handoff, in seconds of audio. */
const FADE_S = 0.1;
/** How far the estimate may run past the last native position (buffering). */
const LEAD_CAP_S = 0.25;
/** How long the highlight takes to fade when playback stops. */
const GATE_MS = 100;
/** Every reset is back to the top of the audio; a status still far from it
 * within this long after one is the old position arriving late. */
const RESET_WAIT_MS = 1000;

export type HighlightState = { level: number; on: number; from: number; to: number };
export type Highlight = SharedValue<HighlightState>;
export type WordBox = { x: number; y: number; width: number; height: number };

// `hard`: jump to `time` and drop the highlight at once. `hold`: stop where
// the estimate is now (a pause the screen asked for, ahead of its status).
type Anchor = {
  seq: number;
  time: number;
  rate: number;
  advancing: boolean;
  playing: boolean;
  hard: boolean;
  hold: boolean;
};
// `waiting`: a reset happened, and statuses still carrying the old position
// (a seek to the top not landed yet) are skipped, for up to RESET_WAIT_MS.
type Clock = {
  seq: number;
  time: number;
  at: number;
  rate: number;
  advancing: boolean;
  playing: boolean;
  native: number;
  waiting: boolean;
};
type Table = { from: number; to: number; c: number[]; w: number[] };

const IDLE: HighlightState = { level: -1, on: 0, from: 0, to: -1 };

/** How strongly word `i` is lit, 0..1. */
export function wordIntensity(h: HighlightState, i: number): number {
  'worklet';
  if (i < h.from || i > h.to) return 0;
  const a = Math.min(1, Math.max(0, h.level - i));
  const b = Math.min(1, Math.max(0, h.level - i - 1));
  return (a - b) * h.on;
}

/** The boundaries (entry, each handoff, exit) of words from..to, as times in
 * the player's own audio, and each boundary's ramp width. */
function buildTable(words: Word[], speed: number, offsetSec: number, from: number, to: number): Table | null {
  if (words.length === 0 || from > to || from < 0 || to >= words.length) return null;
  const c: number[] = [];
  for (let i = from; i <= to; i += 1) c.push(words[i]!.start / speed - offsetSec);
  c.push(words[to]!.end / speed - offsetSec);
  for (let j = 1; j < c.length; j += 1) c[j] = Math.max(c[j]!, c[j - 1]!);
  const w = c.map((cj, j) => {
    const left = j > 0 ? cj - c[j - 1]! : Infinity;
    const right = j < c.length - 1 ? c[j + 1]! - cj : Infinity;
    return Math.min(FADE_S, left, right);
  });
  return { from, to, c, w };
}

/**
 * Follows `player` and returns the highlight state, a `reset` for the moments
 * the screen knows the old position is meaningless (a line switch, a restart
 * from the top) and a `hold` for a pause, both ahead of the native status.
 *
 * Native status arrives every `updateInterval` ms (the player is created with
 * 50) and a moment late, so between updates the position is extrapolated on
 * each frame at the playback rate. A native update slightly behind the
 * estimate is the delivery delay, not the audio going back, so it is ignored;
 * that is what keeps the previous word from flashing back at a boundary.
 */
export function useWordHighlight(
  player: AudioPlayer,
  words: Word[] | undefined,
  speed: number,
  offsetSec: number,
  span: { from: number; to: number } | null,
): { highlight: Highlight; reset: () => void; hold: () => void } {
  const anchor = useSharedValue<Anchor>({
    seq: 0,
    time: 0,
    rate: 1,
    advancing: false,
    playing: false,
    hard: true,
    hold: false,
  });
  const clock = useSharedValue<Clock>({
    seq: -1,
    time: 0,
    at: 0,
    rate: 1,
    advancing: false,
    playing: false,
    native: 0,
    waiting: false,
  });
  const gate = useSharedValue(0);
  const table = useSharedValue<Table | null>(null);
  const highlight = useSharedValue<HighlightState>(IDLE);
  const seq = useRef(0);

  // Memoised: useFrameCallback re-registers whenever the callback identity
  // changes, and this screen re-renders on every 50ms status.
  const onFrame = useCallback((info: FrameInfo) => {
    'worklet';
    const now = info.timestamp;
    const a = anchor.value;
    let c = clock.value;
    if (a.seq !== c.seq && c.waiting && !a.hard && !a.hold && a.time > LEAD_CAP_S && now - c.at < RESET_WAIT_MS) {
      c = { ...c, seq: a.seq };
      clock.value = c;
    } else if (a.seq !== c.seq) {
      const est = c.advancing ? Math.min(c.time + ((now - c.at) / 1000) * c.rate, c.native + LEAD_CAP_S) : c.time;
      const time = a.hold || (!a.hard && est > a.time && est - a.time < LEAD_CAP_S) ? est : a.time;
      const native = a.hold ? c.native : a.time;
      const waiting = a.hard || (c.waiting && a.hold);
      c = { seq: a.seq, time, at: now, rate: a.rate, advancing: a.advancing, playing: a.playing, native, waiting };
      clock.value = c;
      if (a.hard) gate.value = 0;
    }
    const pos = c.advancing ? Math.min(c.time + ((now - c.at) / 1000) * c.rate, c.native + LEAD_CAP_S) : c.time;

    // Capped: the first frame after the callback wakes reports the whole idle gap.
    const dt = Math.min(34, info.timeSincePreviousFrame ?? 16);
    const target = c.playing ? 1 : 0;
    let g = gate.value;
    if (g !== target) {
      g = target > g ? Math.min(1, g + dt / GATE_MS) : Math.max(0, g - dt / GATE_MS);
      gate.value = g;
    }

    const t = table.value;
    let next: HighlightState = IDLE;
    if (t) {
      let level = t.from;
      for (let j = 0; j < t.c.length; j += 1) {
        const cj = t.c[j]!;
        const wj = t.w[j]!;
        if (pos < cj - wj / 2) break;
        if (wj <= 0) {
          level += 1;
          continue;
        }
        const x = Math.min(1, Math.max(0, (pos - cj) / wj + 0.5));
        level += x * x * (3 - 2 * x);
      }
      next = { level, on: g, from: t.from, to: t.to };
    }
    const h = highlight.value;
    if (h.level !== next.level || h.on !== next.on || h.from !== next.from || h.to !== next.to) {
      highlight.value = next;
    }
  }, [anchor, clock, gate, table, highlight]);
  const frame = useFrameCallback(onFrame, false);

  // Frames only run while there is something to move: playing, or the short
  // fade after a stop. An idle player screen asks for no frames at all.
  const idleTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const setActive = frame.setActive;
  const wake = useCallback(
    (playing: boolean) => {
      if (idleTimer.current) {
        clearTimeout(idleTimer.current);
        idleTimer.current = null;
      }
      setActive(true);
      if (!playing) {
        idleTimer.current = setTimeout(() => {
          idleTimer.current = null;
          setActive(false);
        }, GATE_MS * 3);
      }
    },
    [setActive],
  );

  const reset = useCallback(() => {
    seq.current += 1;
    anchor.value = { seq: seq.current, time: 0, rate: 1, advancing: false, playing: false, hard: true, hold: false };
    wake(false);
  }, [anchor, wake]);

  const hold = useCallback(() => {
    seq.current += 1;
    anchor.value = { seq: seq.current, time: 0, rate: 1, advancing: false, playing: false, hard: false, hold: true };
    wake(false);
  }, [anchor, wake]);

  useEffect(() => {
    reset();
    const sub = player.addListener('playbackStatusUpdate', (s: AudioStatus) => {
      seq.current += 1;
      anchor.value = {
        seq: seq.current,
        time: s.currentTime,
        rate: s.playbackRate || 1,
        advancing: s.playing && !s.isBuffering,
        playing: s.playing,
        hard: false,
        hold: false,
      };
      wake(s.playing);
    });
    return () => sub.remove();
  }, [player, anchor, reset, wake]);

  useEffect(
    () => () => {
      if (idleTimer.current) clearTimeout(idleTimer.current);
    },
    [],
  );

  const from = span ? span.from : 0;
  const to = span ? span.to : (words?.length ?? 0) - 1;
  useEffect(() => {
    table.value = words ? buildTable(words, speed, offsetSec, from, to) : null;
    wake(false);
  }, [table, words, speed, offsetSec, from, to, wake]);

  return { highlight, reset, hold };
}

/** The animated text colour for word `index`: `base` at rest, the Japanese
 * accent while lit. Without a highlight it stays `base`. */
export function useWordInk(highlight: Highlight | undefined, index: number, base: string) {
  return useAnimatedStyle(() => {
    const v = highlight ? wordIntensity(highlight.value, index) : 0;
    return { color: v <= 0 ? base : v >= 1 ? tide.lang.ja : interpolateColor(v, [0, 1], [base, tide.lang.ja]) };
  }, [highlight, index, base]);
}
