import { useRouter } from 'expo-router';
import { useEffect, useState, type MutableRefObject } from 'react';

import { snapRate, useLadder, type LadderIo } from '@/hooks/use-ladder';
import type { useTake } from '@/hooks/use-take';
import * as api from '@/lib/api';
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
    onLineDone: () => {
      o.gradeOnce(o.lines[o.lineRef.current]?.idx ?? -1);
      if (o.island) addLadder(o.island.id);
    },
    advance: () => {
      const next = o.lineRef.current + 1;
      if (next >= o.lines.length) {
        router.back();
        return false;
      }
      o.seekToLine(next);
      o.lineRef.current = next;
      return true;
    },
  };
  const ladder = useLadder(o.take, o.speedLive, o.lines[o.activeLine]?.duration ?? 0, io);
  o.ladderRef.current = ladder;
  // A finished ladder hands the player back at the dock speed.
  // A stopped or finished run closes its help.
  useEffect(() => {
    if (ladder.step === 'done') o.setRate(o.speedLive);
    if (ladder.step === 'idle' || ladder.step === 'done') setHelpOpen(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ladder.step]);
  const livePass = helpPassOf(ladder.step, 'ladder');
  const onPassHelp =
    livePass === null
      ? undefined
      : () => {
          setHelpPass(livePass);
          setHelpOpen(true);
        };
  return { ladder, helpOpen, setHelpOpen, helpPass, onPassHelp };
}
