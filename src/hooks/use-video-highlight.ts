import type { YoutubeIframeRef } from 'react-native-youtube-iframe';
import { type RefObject, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { type FrameInfo, useFrameCallback, useSharedValue } from 'react-native-reanimated';
import { scheduleOnRN } from 'react-native-worklets';

import { buildTable, type Highlight, type HighlightState, IDLE, type Table } from '@/components/word-highlight';
import type { Line } from '@/lib/api';

/**
 * Follows the YouTube IFrame player and drives the same word highlight the
 * island player uses. The player gives no continuous clock, only an async
 * `getCurrentTime`, so it is polled and the position between polls is
 * extrapolated on every frame at the playback rate.
 */

/** How often the player is asked for its time while playing. */
const POLL_MS = 250;
/** A poll within this of the estimate is postMessage jitter, not a seek. */
const JITTER_S = 0.08;
/** Frames keep running this long after a stop so the highlight can fade. */
const TAIL_MS = 300;
/** How long the highlight takes to fade in or out. */
const GATE_MS = 100;
/** Run the highlight this far ahead of the player's reported time. YouTube's
 * caption timings and the IFrame clock both trail the audio slightly, so a
 * small lead keeps the glow on the word as it is spoken, not after. */
const HIGHLIGHT_LEAD_S = 0.45;

type Anchor = { seq: number; time: number; rate: number; playing: boolean; hard: boolean };
type Clock = { seq: number; time: number; at: number; rate: number; playing: boolean };

export type VideoStateName = 'unstarted' | 'ended' | 'playing' | 'paused' | 'buffering' | 'video cued';

export function useVideoHighlight(
  playerRef: RefObject<YoutubeIframeRef | null>,
  lines: Line[],
  startS: number,
): {
  highlight: Highlight;
  activeLine: number;
  onChangeState: (state: string) => void;
  onPlaybackRateChange: (rate: string | number) => void;
  seekToLine: (index: number) => void;
} {
  const anchor = useSharedValue<Anchor>({ seq: 0, time: 0, rate: 1, playing: false, hard: true });
  const clock = useSharedValue<Clock>({ seq: -1, time: 0, at: 0, rate: 1, playing: false });
  const gate = useSharedValue(0);
  const highlight = useSharedValue<HighlightState>(IDLE);
  const tables = useSharedValue<(Table | null)[]>([]);
  const starts = useSharedValue<number[]>([]);
  const lastLine = useSharedValue(-1);
  const [activeLine, setActiveLine] = useState(0);

  const starting = useMemo(() => lines.map((l) => startS + (l.offset ?? 0)), [lines, startS]);
  useEffect(() => {
    starts.value = starting;
    tables.value = lines.map((l, i) => buildTable(l.words, 1, -starting[i]!, 0, l.words.length - 1));
    lastLine.value = -1;
  }, [lines, starting, starts, tables, lastLine]);

  const seq = useRef(0);
  const rate = useRef(1);
  const playing = useRef(false);
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);
  const idleTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const onFrame = useCallback(
    (info: FrameInfo) => {
      'worklet';
      const now = performance.now();
      const a = anchor.value;
      let c = clock.value;
      if (a.seq !== c.seq) {
        const est = c.playing ? c.time + ((now - c.at) / 1000) * c.rate : c.time;
        const keep = !a.hard && Math.abs(est - a.time) < JITTER_S;
        c = { seq: a.seq, time: keep ? est : a.time, at: now, rate: a.rate, playing: a.playing };
        clock.value = c;
        if (a.hard) gate.value = 0;
      }
      const pos = c.playing ? c.time + ((now - c.at) / 1000) * c.rate + HIGHLIGHT_LEAD_S : c.time;

      const dt = Math.min(34, info.timeSincePreviousFrame ?? 16);
      const target = c.playing ? 1 : 0;
      let g = gate.value;
      if (g !== target) {
        g = target > g ? Math.min(1, g + dt / GATE_MS) : Math.max(0, g - dt / GATE_MS);
        gate.value = g;
      }

      const s = starts.value;
      let line = 0;
      for (let i = 0; i < s.length; i += 1) {
        if (s[i]! <= pos) line = i;
        else break;
      }
      if (line !== lastLine.value) {
        lastLine.value = line;
        scheduleOnRN(setActiveLine, line);
      }

      const t = tables.value[line] ?? null;
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
    },
    [anchor, clock, gate, starts, tables, lastLine, highlight],
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
    (time: number, lag: number, isPlaying: boolean, hard: boolean) => {
      seq.current += 1;
      anchor.value = {
        seq: seq.current,
        time: time + (isPlaying ? (lag / 1000) * rate.current : 0),
        rate: rate.current,
        playing: isPlaying,
        hard,
      };
      wake(isPlaying);
    },
    [anchor, wake],
  );

  const read = useCallback(
    (isPlaying: boolean) => {
      const p = playerRef.current;
      if (!p) return;
      const sent = performance.now();
      p.getCurrentTime()
        .then((time) => {
          if (typeof time !== 'number' || !Number.isFinite(time)) return;
          // The answer is the player's time somewhere in the middle of the round trip.
          write(time, (performance.now() - sent) / 2, isPlaying && playing.current, false);
        })
        .catch(() => {});
    },
    [playerRef, write],
  );

  const stopPolling = useCallback(() => {
    if (timer.current) {
      clearInterval(timer.current);
      timer.current = null;
    }
  }, []);

  const onChangeState = useCallback(
    (state: string) => {
      if (state === 'playing') {
        playing.current = true;
        stopPolling();
        read(true);
        timer.current = setInterval(() => read(true), POLL_MS);
        return;
      }
      playing.current = false;
      stopPolling();
      if (state === 'paused' || state === 'ended' || state === 'buffering') read(false);
    },
    [read, stopPolling],
  );

  const onPlaybackRateChange = useCallback(
    (value: string | number) => {
      const r = Number(value);
      if (Number.isFinite(r) && r > 0) rate.current = r;
      read(playing.current);
    },
    [read],
  );

  const seekToLine = useCallback(
    (index: number) => {
      const at = starting[index];
      if (at === undefined) return;
      playerRef.current?.seekTo(at, true);
      setActiveLine(index);
      write(at, 0, playing.current, true);
    },
    [starting, playerRef, write],
  );

  useEffect(
    () => () => {
      stopPolling();
      if (idleTimer.current) clearTimeout(idleTimer.current);
    },
    [stopPolling],
  );

  return { highlight, activeLine, onChangeState, onPlaybackRateChange, seekToLine };
}
