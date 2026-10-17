import { useRouter } from 'expo-router';
import { useEffect, useRef, useState, type MutableRefObject } from 'react';

import { snapRate, useLadder, type LadderIo } from '@/hooks/use-ladder';
import type { useTake } from '@/hooks/use-take';
import * as api from '@/lib/api';
import { finishAutoIsland, finishSession, noteSessionLine, routeFor } from '@/lib/auto-practice';
import { helpPassOf } from '@/lib/pass-programme';
import { addLadder } from '@/lib/practice';

type Opts = {
  take: ReturnType<typeof useTake>;
  speedLive: number;
  lines: api.Line[];
  lineRef: MutableRefObject<number>;
  ladderRef: MutableRefObject<ReturnType<typeof useLadder> | null>;
  island: api.Island | null;
  activeLine: number;
  seekToLine: (i: number) => void;
  setRate: (r: number) => void;
  gradeOnce: (idx: number) => void;
  /** The screen's own audio: play the line at the snapped pass rate, open the mic, silence its track. */
  playLine: (snapped: number) => void;
  record: (snapped: number) => Promise<boolean>;
  stop: () => void;
  /** After the record button's one-line ladder: play on from the next line. */
  resume?: () => void;
  /** What the dock record button starts from idle: the ladder over every line (default) or on the current line only. */
  onRecordStart?: 'ladder' | 'line';
  /** A practice session: lines are reported and the last line hops to the next project. */
  session?: boolean;
};

/**
 * Review mode runs the shadowing ladder on each saved line (the same passes
 * as the island); a finished ladder marks the card reviewed on its own. The
 * screen supplies its audio, this holds the rest of the wiring.
 */
export function useLadderWiring(o: Opts) {
  const router = useRouter();
  const [helpOpen, setHelpOpen] = useState(false);
  // The pass whose help is open, frozen while it is read.
  const [helpPass, setHelpPass] = useState<0 | 1 | 2 | 3 | 4>(0);
  // When the line's ladder started, for the session's seconds per line (0 = not started).
  const lineStart = useRef(0);
  const io: LadderIo = {
    playLine: (speed) => {
      // The pass rate lives in `rate` only: speedLive stays the dock speed
      // the passes are taken from.
      const snapped = snapRate(speed);
      o.setRate(snapped);
      o.playLine(snapped);
    },
    record: (speed) => {
      const snapped = snapRate(speed);
      o.setRate(snapped);
      return o.record(snapped);
    },
    stop: () => {
      o.stop();
      o.take.stopTake();
      void o.take.cancel();
      o.setRate(o.speedLive);
    },
    resume: o.resume,
    onLineDone: () => {
      const line = o.lines[o.lineRef.current];
      o.gradeOnce(line?.idx ?? -1);
      if (o.island) addLadder(o.island.id);
      if (o.session && o.island && line) {
        noteSessionLine(o.island.id, line.idx, lineStart.current ? (Date.now() - lineStart.current) / 1000 : 0, line);
        lineStart.current = 0;
      }
    },
    advance: () => {
      const next = o.lineRef.current + 1;
      if (next >= o.lines.length) {
        const to = o.session && o.island ? finishAutoIsland(o.island.id, 'shadowed') : null;
        if (to) router.replace(routeFor(to.nextId, to.nextKind));
        else {
          if (o.session) finishSession(true);
          router.back();
        }
        return false;
      }
      lineStart.current = Date.now();
      o.seekToLine(next);
      o.lineRef.current = next;
      return true;
    },
    lineText: o.lines[o.activeLine]?.ja ?? '',
    line: o.lines[o.activeLine] ?? null,
  };
  const ladder = useLadder(o.take, o.speedLive, o.lines[o.activeLine]?.duration ?? 0, io, {
    onRecordStart: o.onRecordStart,
  });
  o.ladderRef.current = ladder;
  // A finished ladder hands the player back at the dock speed.
  // A stopped or finished run closes its help.
  useEffect(() => {
    if (ladder.step !== 'idle' && ladder.step !== 'done' && !lineStart.current) lineStart.current = Date.now();
    if (ladder.step === 'done') o.setRate(o.speedLive);
    if (ladder.step === 'idle' || ladder.step === 'done') setHelpOpen(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ladder.step]);
  const livePass = helpPassOf(ladder.step);
  const onPassHelp = () => {
    setHelpPass(livePass);
    setHelpOpen(true);
  };
  return { ladder, helpOpen, setHelpOpen, helpPass, onPassHelp };
}
