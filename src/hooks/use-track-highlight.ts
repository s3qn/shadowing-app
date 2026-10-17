import type { AudioPlayer, AudioStatus } from 'expo-audio';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { type FrameInfo, useFrameCallback, useSharedValue } from 'react-native-reanimated';
import { scheduleOnRN } from 'react-native-worklets';

import { buildTable, type Highlight, type HighlightState, IDLE, levelAt, type Table } from '@/components/word-highlight';
import type { Line } from '@/lib/api';

/**
 * Follows one expo-audio player that plays a whole track (a podcast episode)
 * and drives the word highlight for every line of it. Line `i` starts at
 * `lines[i].offset` seconds into the track and its word times are relative to
 * that start. Same shape as useVideoHighlight (many lines, one clock), fed by
 * the expo-audio status like useWordHighlight instead of by polling.
 */

/** Frames keep running this long after a stop so the highlight can fade. */
const TAIL_MS = 300;
/** How long the highlight takes to fade in or out. */
const GATE_MS = 100;
/** Extrapolation never runs further ahead of the last native time than this. */
const LEAD_CAP_S = 0.25;
/** Run the highlight this far ahead of the player's time. The expo-audio clock
 * is the audio clock and whisper word times need no YouTube-style lead. Raise
 * to about 0.15 only if the glow is seen trailing the voice. */
const LEAD_S = 0;
/** After a seek, statuses this far from the target are the old position
 * arriving late, for up to SEEK_GUARD_MS. */
const SEEK_TOL_S = 1;
const SEEK_GUARD_MS = 1000;

type Anchor = { seq: number; time: number; rate: number; advancing: boolean; playing: boolean; hard: boolean };
type Clock = { seq: number; time: number; at: number; rate: number; advancing: boolean; playing: boolean; native: number };

export function useTrackHighlight(
  player: AudioPlayer,
  lines: Line[],
): { highlight: Highlight; activeLine: number; seekToLine: (index: number) => void } {
  const anchor = useSharedValue<Anchor>({ seq: 0, time: 0, rate: 1, advancing: false, playing: false, hard: true });
  const clock = useSharedValue<Clock>({ seq: -1, time: 0, at: 0, rate: 1, advancing: false, playing: false, native: 0 });
  const gate = useSharedValue(0);
  const highlight = useSharedValue<HighlightState>(IDLE);
  const tables = useSharedValue<(Table | null)[]>([]);
  const starts = useSharedValue<number[]>([]);
  const lastLine = useSharedValue(-1);
  const [activeLine, setActiveLine] = useState(0);

  const starting = useMemo(() => lines.map((l) => l.offset ?? 0), [lines]);
  useEffect(() => {
    starts.value = starting;
    tables.value = lines.map((l, i) => buildTable(l.words, 1, -starting[i]!, 0, l.words.length - 1));
    lastLine.value = -1;
  }, [lines, starting, starts, tables, lastLine]);

  const seq = useRef(0);
  const guard = useRef<{ to: number; until: number } | null>(null);
  const idleTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const onFrame = useCallback(
    (info: FrameInfo) => {
      'worklet';
      const now = info.timestamp;
      const a = anchor.value;
      let c = clock.value;
      if (a.seq !== c.seq) {
        const est = c.advancing ? Math.min(c.time + ((now - c.at) / 1000) * c.rate, c.native + LEAD_CAP_S) : c.time;
        // A native update slightly behind the estimate is delivery delay, not
        // the audio going back: keep the estimate so no word flashes back.
        const keep = !a.hard && est > a.time && est - a.time < LEAD_CAP_S;
        c = {
          seq: a.seq,
          time: keep ? est : a.time,
          at: now,
          rate: a.rate,
          advancing: a.advancing,
          playing: a.playing,
          native: a.time,
        };
        clock.value = c;
        if (a.hard) gate.value = 0;
      }
      const pos =
        (c.advancing ? Math.min(c.time + ((now - c.at) / 1000) * c.rate, c.native + LEAD_CAP_S) : c.time) + LEAD_S;

      // Capped: the first frame after the callback wakes reports the whole idle gap.
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
        const level = levelAt(t, pos);
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

  useEffect(() => {
    const sub = player.addListener('playbackStatusUpdate', (s: AudioStatus) => {
      const g = guard.current;
      if (g) {
        if (performance.now() < g.until && Math.abs(s.currentTime - g.to) > SEEK_TOL_S) return;
        guard.current = null;
      }
      seq.current += 1;
      anchor.value = {
        seq: seq.current,
        time: s.currentTime,
        rate: s.playbackRate || 1,
        advancing: s.playing && !s.isBuffering,
        playing: s.playing,
        hard: false,
      };
      wake(s.playing);
    });
    return () => sub.remove();
  }, [player, anchor, wake]);

  useEffect(
    () => () => {
      if (idleTimer.current) clearTimeout(idleTimer.current);
    },
    [],
  );

  const seekToLine = useCallback(
    (index: number) => {
      const at = starting[index];
      if (at === undefined) return;
      guard.current = { to: at, until: performance.now() + SEEK_GUARD_MS };
      void player.seekTo(at);
      setActiveLine(index);
      seq.current += 1;
      const prev = anchor.value;
      anchor.value = {
        seq: seq.current,
        time: at,
        rate: prev.rate,
        advancing: prev.playing,
        playing: prev.playing,
        hard: true,
      };
      wake(prev.playing);
    },
    [starting, player, anchor, wake],
  );

  return { highlight, activeLine, seekToLine };
}
