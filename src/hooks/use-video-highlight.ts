import type { YoutubeIframeRef } from 'react-native-youtube-iframe';
import { AppState } from 'react-native';
import { type RefObject, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { type FrameInfo, useFrameCallback, useSharedValue } from 'react-native-reanimated';
import { scheduleOnRN } from 'react-native-worklets';

import { type Highlight, type HighlightState, IDLE, levelAt } from '@/components/word-highlight';
import type { Line } from '@/lib/api';

/**
 * Follows the YouTube IFrame player and drives the video's word highlight. The
 * player gives no continuous clock, only an async `getCurrentTime`, so it is
 * polled single-flight and the position between polls is predicted on every
 * frame at the playback rate. A new sample corrects the prediction softly (a
 * late clock slews, an early one runs slower, never backwards) and a seek
 * re-anchors it hard. Replies sent before the latest seek are dropped by epoch.
 */

/** How often the player is asked for its time while playing or buffering. */
const POLL_MS = 250;
/** Frames keep running this long after a stop so the highlight can fade. */
const TAIL_MS = 300;
/** How long the highlight takes to fade in or out. */
const GATE_MS = 100;
/** Visual lead over the reported clock; calibrated on device, see plan. */
const LEAD_S = 0.06;
/** A sample off the estimate by more than this is a seek, not drift. */
const SNAP_S = 0.5;
/** A sample within this of the estimate is postMessage jitter. */
const JITTER_S = 0.08;
/** Share of a positive error absorbed per sample. */
const SLEW = 0.3;
/** The estimate never runs further than this past the last sampled time. */
const MAX_AHEAD_S = 0.5;
/** Words closer than this are contiguous (the light does not stop between them). */
const JOIN_GAP_S = 0.25;
/** The shortest a word may stay lit. */
const MIN_WORD_S = 0.08;
/** Width of one word handoff, in seconds: the whole word lights at once over
 * this crossfade, as in the island player (see word-highlight.ts). */
const FADE_S = 0.1;
/** A getCurrentTime that has not answered in this long is given up on. */
const INFLIGHT_MAX_MS = 1000;
/** A looped line ends this long after its last word, so the trailing silence
 * is cut short. */
const END_TAIL_S = 0.25;
/** A looped line ends at least this long before the next line starts, so the
 * seek back lands before the next line's first word is heard or lit. */
const END_LEAD_S = 0.15;
/** A line shorter than this to its end point never loops (no seek storm). */
const MIN_LOOP_S = 0.3;

/** Anchor: JS to UI thread. `hard` jumps to `time` and gates to 0, `hold` freezes at the current estimate. */
type Anchor = {
  seq: number;
  time: number;
  rate: number;
  advancing: boolean;
  lit: boolean;
  hard: boolean;
  hold: boolean;
};
/** Clock: UI thread. `native` is the last sampled player time. */
type Clock = {
  seq: number;
  time: number;
  at: number;
  rate: number;
  advancing: boolean;
  lit: boolean;
  native: number;
};
/** The line's word boundaries in absolute player seconds (each word's start,
 * then the last word's end) and each boundary's crossfade width. */
type WordTable = { from: number; to: number; c: number[]; w: number[] };

export type VideoStateName = 'unstarted' | 'ended' | 'playing' | 'paused' | 'buffering' | 'video cued';

/** The play intent after a player state: only playing and paused/ended change it. */
export function playIntent(prev: boolean, state: string): boolean {
  if (state === 'playing') return true;
  if (state === 'paused' || state === 'ended') return false;
  return prev;
}

function buildWords(line: Line, lineStart: number): WordTable | null {
  const words = line.words;
  const n = words.length;
  if (n === 0) return null;
  const s: number[] = [];
  const e: number[] = [];
  for (let j = 0; j < n; j += 1) {
    const w = words[j]!;
    const rawS = lineStart + w.start;
    const rawE = lineStart + w.end;
    const nextS = j < n - 1 ? lineStart + words[j + 1]!.start : Infinity;
    const start = j > 0 ? Math.max(rawS, e[j - 1]!) : rawS;
    let end = j < n - 1 && nextS - rawE < JOIN_GAP_S ? nextS : Math.max(rawE, start + MIN_WORD_S);
    end = Math.max(Math.min(end, nextS), start);
    s.push(start);
    e.push(end);
  }
  const c = [...s, e[n - 1]!];
  const w = c.map((cj, j) => {
    const left = j > 0 ? cj - c[j - 1]! : Infinity;
    const right = j < c.length - 1 ? c[j + 1]! - cj : Infinity;
    return Math.max(0, Math.min(FADE_S, left, right));
  });
  return { from: 0, to: n - 1, c, w };
}

/** Where each line ends for Repeat, in absolute player seconds, or -1 when it
 * has no usable end. With `spans`, a line is capped by its own duration
 * instead of the next entry, which in a filtered list is not its neighbour. */
function lineEnds(starting: number[], tables: (WordTable | null)[], spans?: number[]): number[] {
  return starting.map((start, i) => {
    const span = spans?.[i];
    const next = spans ? (span !== undefined && Number.isFinite(span) && span > 0 ? start + span : undefined) : starting[i + 1];
    const t = tables[i];
    const wordEnd = t ? t.c[t.c.length - 1]! + END_TAIL_S : Infinity;
    const end = Math.min(next !== undefined ? next - END_LEAD_S : Infinity, wordEnd);
    return Number.isFinite(end) && end - start >= MIN_LOOP_S ? end : -1;
  });
}

/** Repeat: with `on`, the clock stops at each line's end and holds that line
 * on screen until the caller seeks back (`seekToLine`) or carries on
 * (`releaseLine`). */
export type LineLoop = {
  on: boolean;
  onLineEnd: (line: number) => void;
  /** End each line at its own offset plus duration, for a list with gaps. */
  ownEnds?: boolean;
};

export function useVideoHighlight(
  playerRef: RefObject<YoutubeIframeRef | null>,
  lines: Line[],
  startS: number,
  loop?: LineLoop,
): {
  highlight: Highlight;
  activeLine: number;
  onChangeState: (state: string) => void;
  onPlaybackRateChange: (rate: string | number) => void;
  seekToLine: (index: number) => void;
  releaseLine: () => void;
} {
  const anchor = useSharedValue<Anchor>({
    seq: 0,
    time: 0,
    rate: 1,
    advancing: false,
    lit: false,
    hard: true,
    hold: false,
  });
  const clock = useSharedValue<Clock>({
    seq: -1,
    time: 0,
    at: 0,
    rate: 1,
    advancing: false,
    lit: false,
    native: 0,
  });
  const gate = useSharedValue(0);
  const highlight = useSharedValue<HighlightState>(IDLE);
  const tables = useSharedValue<(WordTable | null)[]>([]);
  const starts = useSharedValue<number[]>([]);
  const lastLine = useSharedValue(-1);
  const ends = useSharedValue<number[]>([]);
  const looping = useSharedValue(false);
  /** The line held at its end, waiting on the caller, or -1. */
  const heldLine = useSharedValue(-1);
  /** The last line whose end fired, so a line fires once per pass. */
  const firedLine = useSharedValue(-1);
  const [activeLine, setActiveLine] = useState(0);
  /** The line the card on screen shows. The UI thread switches lines a few
   * frames before React renders the new card, and the old card reads the same
   * highlight, so until this catches up nothing lights: otherwise the new
   * line's first word lights word 0 of the line still on screen. */
  const shownLine = useSharedValue(0);
  useEffect(() => {
    shownLine.value = activeLine;
  }, [activeLine, shownLine]);

  const starting = useMemo(() => lines.map((l) => startS + (l.offset ?? 0)), [lines, startS]);
  const ownEnds = loop?.ownEnds ?? false;
  useEffect(() => {
    const built = lines.map((l, i) => buildWords(l, starting[i]!));
    starts.value = starting;
    tables.value = built;
    ends.value = lineEnds(starting, built, ownEnds ? lines.map((l) => l.duration) : undefined);
    lastLine.value = -1;
    heldLine.value = -1;
    firedLine.value = -1;
  }, [lines, starting, ownEnds, starts, tables, ends, lastLine, heldLine, firedLine]);

  const loopOn = loop?.on ?? false;
  const onLineEndRef = useRef(loop?.onLineEnd);
  onLineEndRef.current = loop?.onLineEnd;
  useEffect(() => {
    looping.value = loopOn;
    if (!loopOn) heldLine.value = -1;
  }, [loopOn, looping, heldLine]);
  const releaseLine = useCallback(() => {
    heldLine.value = -1;
  }, [heldLine]);
  const lineEnded = useCallback(
    (line: number) => {
      const cb = onLineEndRef.current;
      if (cb) cb(line);
      else heldLine.value = -1;
    },
    [heldLine],
  );

  const seq = useRef(0);
  const epoch = useRef(0);
  const rate = useRef(1);
  const state = useRef<string>('unstarted');
  const inflight = useRef(false);
  const inflightAt = useRef(0);
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);
  const idleTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const seekTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const onFrame = useCallback(
    (info: FrameInfo) => {
      'worklet';
      const now = performance.now();
      const a = anchor.value;
      let c = clock.value;
      if (a.seq !== c.seq) {
        const est = c.advancing ? Math.min(c.time + ((now - c.at) / 1000) * c.rate, c.native + MAX_AHEAD_S) : c.time;
        let time = a.time;
        let r = a.rate;
        let native = a.time;
        if (a.hard) {
          gate.value = 0;
        } else if (a.hold) {
          time = est;
          native = c.native;
        } else if (a.advancing && c.advancing) {
          const err = a.time - est;
          if (Math.abs(err) > SNAP_S) {
            time = a.time;
          } else if (err > JITTER_S) {
            time = est + SLEW * err;
          } else if (err < -JITTER_S) {
            time = est;
            r = a.rate * Math.max(0.7, 1 + err / SNAP_S);
          } else {
            time = est;
          }
        }
        c = { seq: a.seq, time, at: now, rate: r, advancing: a.advancing, lit: a.lit, native };
        clock.value = c;
      }
      const est = c.advancing ? Math.min(c.time + ((now - c.at) / 1000) * c.rate, c.native + MAX_AHEAD_S) : c.time;
      let pos = est + LEAD_S;

      const dt = Math.min(34, info.timeSincePreviousFrame ?? 16);
      const target = c.lit ? 1 : 0;
      let g = gate.value;
      if (g !== target) {
        g = target > g ? Math.min(1, g + dt / GATE_MS) : Math.max(0, g - dt / GATE_MS);
        gate.value = g;
      }

      const st = starts.value;
      let line = 0;
      for (let i = 0; i < st.length; i += 1) {
        if (st[i]! <= pos) line = i;
        else break;
      }
      // Repeat: a line held at its end stays on screen, frozen at that end,
      // until the caller seeks back or lets it go.
      const held = heldLine.value;
      if (held >= 0 && held < st.length) {
        line = held;
        const he = ends.value[held] ?? -1;
        if (he > 0) pos = Math.min(pos, he);
      } else if (looping.value && c.advancing && line !== firedLine.value) {
        const e = ends.value[line] ?? -1;
        if (e > 0 && pos >= e) {
          firedLine.value = line;
          heldLine.value = line;
          pos = e;
          scheduleOnRN(lineEnded, line);
        }
      }
      if (line !== lastLine.value) {
        lastLine.value = line;
        scheduleOnRN(setActiveLine, line);
      }

      const t = line === shownLine.value ? (tables.value[line] ?? null) : null;
      let next: HighlightState = IDLE;
      if (t) {
        const level = levelAt(t, pos);
        next = { level, on: g, from: t.from, to: t.to };
      }
      const h = highlight.value;
      if (h.level !== next.level || h.on !== next.on || h.from !== next.from || h.to !== next.to) {
        highlight.value = next;
      }
    },
    [anchor, clock, gate, starts, tables, lastLine, shownLine, highlight, ends, looping, heldLine, firedLine, lineEnded],
  );
  const frame = useFrameCallback(onFrame, false);
  const setFrames = frame.setActive;

  const wake = useCallback(
    (running: boolean) => {
      if (idleTimer.current) {
        clearTimeout(idleTimer.current);
        idleTimer.current = null;
      }
      setFrames(true);
      if (!running) {
        idleTimer.current = setTimeout(() => {
          idleTimer.current = null;
          setFrames(false);
        }, TAIL_MS);
      }
    },
    [setFrames],
  );

  const write = useCallback(
    (a: { time: number; advancing: boolean; lit: boolean; hard?: boolean; hold?: boolean }) => {
      seq.current += 1;
      anchor.value = {
        seq: seq.current,
        time: a.time,
        rate: rate.current,
        advancing: a.advancing,
        lit: a.lit,
        hard: a.hard ?? false,
        hold: a.hold ?? false,
      };
      wake(a.lit);
    },
    [anchor, wake],
  );

  /** Freeze the clock where it is and set the new run/gate flags. */
  const hold = useCallback(
    (advancing: boolean, lit: boolean) => write({ time: 0, advancing, lit, hold: true }),
    [write],
  );

  /** Ask the player for its time. Returns false when a request is already out. */
  const read = useCallback(
    (hard: boolean): boolean => {
      const p = playerRef.current;
      if (!p) return false;
      const sent = performance.now();
      if (inflight.current && sent - inflightAt.current < INFLIGHT_MAX_MS) return false;
      inflight.current = true;
      inflightAt.current = sent;
      const sentEpoch = epoch.current;
      p.getCurrentTime()
        .then((time) => {
          inflight.current = false;
          if (sentEpoch !== epoch.current) return;
          if (typeof time !== 'number' || !Number.isFinite(time)) return;
          const advancing = state.current === 'playing';
          const lit = advancing || state.current === 'buffering';
          const rtt = performance.now() - sent;
          write({ time: time + (advancing ? (rtt / 2 / 1000) * rate.current : 0), advancing, lit, hard });
        })
        .catch(() => {
          inflight.current = false;
        });
      return true;
    },
    [playerRef, write],
  );

  const stopPolling = useCallback(() => {
    if (timer.current) {
      clearInterval(timer.current);
      timer.current = null;
    }
  }, []);
  const startPolling = useCallback(() => {
    if (timer.current) return;
    timer.current = setInterval(() => read(false), POLL_MS);
  }, [read]);

  const onChangeState = useCallback(
    (next: string) => {
      state.current = next;
      if (next === 'playing') {
        hold(true, true);
        startPolling();
        read(false);
      } else if (next === 'buffering') {
        hold(false, true);
        startPolling();
      } else if (next === 'paused' || next === 'ended') {
        stopPolling();
        hold(false, false);
        read(false);
      } else {
        stopPolling();
        hold(false, false);
      }
    },
    [hold, read, startPolling, stopPolling],
  );

  const onPlaybackRateChange = useCallback(
    (value: string | number) => {
      const r = Number(value);
      if (Number.isFinite(r) && r > 0) rate.current = r;
      epoch.current += 1;
      read(true);
    },
    [read],
  );

  const seekToLine = useCallback(
    (index: number) => {
      const at = starting[index];
      if (at === undefined) return;
      epoch.current += 1;
      playerRef.current?.seekTo(at, true);
      setActiveLine(index);
      lastLine.value = index;
      const playing = state.current === 'playing';
      write({ time: at, advancing: playing, lit: playing || state.current === 'buffering', hard: true });
      // After the anchor, so no frame sees the hold lifted on the old clock.
      heldLine.value = -1;
      firedLine.value = -1;
      // The player snaps to a keyframe, so ask again once it has landed.
      if (seekTimer.current) clearTimeout(seekTimer.current);
      let tries = 0;
      const again = () => {
        seekTimer.current = null;
        if (!read(false) && tries < 5) {
          tries += 1;
          seekTimer.current = setTimeout(again, 100);
        }
      };
      seekTimer.current = setTimeout(again, 300);
    },
    [starting, playerRef, write, read, lastLine, heldLine, firedLine],
  );

  useEffect(() => {
    const sub = AppState.addEventListener('change', (s) => {
      if (s === 'active' && state.current === 'playing') {
        epoch.current += 1;
        read(true);
      }
    });
    return () => sub.remove();
  }, [read]);

  useEffect(
    () => () => {
      stopPolling();
      if (idleTimer.current) clearTimeout(idleTimer.current);
      if (seekTimer.current) clearTimeout(seekTimer.current);
    },
    [stopPolling],
  );

  return { highlight, activeLine, onChangeState, onPlaybackRateChange, seekToLine, releaseLine };
}
