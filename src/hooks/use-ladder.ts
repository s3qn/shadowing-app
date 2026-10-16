import { useEffect, useRef, useState } from 'react';
import { Easing, cancelAnimation, useSharedValue, withTiming } from 'react-native-reanimated';

import type { AutoEchoSheetProps } from '@/components/tide/auto-echo-sheet';
import type { useTake } from '@/hooks/use-take';
import {
  COUNT_IN_BEATS,
  COUNT_IN_BEAT_MS,
  afterTakePlayed,
  afterTakeSaved,
  armedStepOf,
  fillKindOf,
  isArmedStep,
  isPlayStep,
  isSpeakStep,
  nextOnLineFinish,
  passSpeed,
  speakStepOf,
  type PassStep,
} from '@/lib/pass-programme';
import { getSettingsSync, setAutoEcho, setAutoRecord } from '@/lib/settings';
import { resultTier } from '@/lib/takes';

/** How long the result sparkle holds before the next line starts. */
const RESULT_HOLD_MS = 1400;
/** A take that has not started playing by then is skipped, so the ladder never hangs. */
const PLAY_START_MS = 1500;

/** The player rates both track-span players can set: quarter steps, 0.25–2. */
export const snapRate = (v: number) => Math.min(2, Math.max(0.25, Math.round(v * 4) / 4));

/** The audio glue a track-span player (a video or a podcast) hands the ladder. */
export type LadderIo = {
  /** Current line from its start; the player calls `lineFinished()` at its end. */
  playLine: (speed: number) => void;
  /** Mic on the current line, the line under it unless silent. False when the mic did not open. */
  record: (speed: number) => Promise<boolean>;
  /** Silence the track, drop a take in progress, restore the dock speed. */
  stop: () => void;
  /** The line's ladder finished (after Compare played the take back). */
  onLineDone: () => void;
  /** Move to the next line; false when there is none. */
  advance: () => boolean;
};

type SheetProps = Pick<
  AutoEchoSheetProps,
  | 'step'
  | 'programme'
  | 'countdown'
  | 'countIn'
  | 'level'
  | 'fill'
  | 'result'
  | 'error'
  | 'stopping'
  | 'autoEcho'
  | 'autoRecord'
  | 'onToggleAutoEcho'
  | 'onToggleAutoRecord'
  | 'headset'
  | 'onStart'
  | 'onRecord'
  | 'onStop'
  | 'onRetry'
>;

/**
 * The five-pass ladder for a player whose lines are spans of one track. The
 * step and speed rules are `pass-programme.ts`'s; this wraps them in the
 * timers and the take plumbing and drives `AutoEchoSheet` through `sheet`.
 */
export function useLadder(
  take: ReturnType<typeof useTake>,
  base: number,
  lineSec: number,
  io: LadderIo,
): {
  step: PassStep;
  active: boolean;
  start: () => void;
  stop: () => void;
  lineFinished: () => void;
  sheet: SheetProps;
} {
  const [step, setStepState] = useState<PassStep>('idle');
  const stepRef = useRef<PassStep>('idle');
  const [result, setResult] = useState<AutoEchoSheetProps['result']>(null);
  const [countIn, setCountIn] = useState<number | null>(null);
  const [stopping, setStopping] = useState(false);
  const [autoEcho, setAutoEchoState] = useState(() => getSettingsSync().autoEcho);
  const [autoRecord, setAutoRecordState] = useState(() => getSettingsSync().autoRecord);
  const fill = useSharedValue(0);
  const countTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const holdTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const playTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const startedAt = useRef(0);
  const starting = useRef(false);
  const wasPlaying = useRef(false);
  // Timers and effects read the latest render's values through this.
  const live = useRef({ take, base, lineSec, io, autoEcho, autoRecord });
  live.current = { take, base, lineSec, io, autoEcho, autoRecord };

  const setStep = (next: PassStep) => {
    stepRef.current = next;
    setStepState(next);
  };
  const clearTimers = () => {
    if (countTimer.current) clearTimeout(countTimer.current);
    if (holdTimer.current) clearTimeout(holdTimer.current);
    if (playTimer.current) clearTimeout(playTimer.current);
    countTimer.current = null;
    holdTimer.current = null;
    playTimer.current = null;
    setCountIn(null);
  };

  // The line's ladder is over: show the result, then move on or stop.
  const finishLine = () => {
    if (playTimer.current) clearTimeout(playTimer.current);
    playTimer.current = null;
    const l = live.current;
    setResult({ id: Date.now(), tier: resultTier(null, l.take.takeDuration, l.lineSec) });
    l.io.onLineDone();
    if (l.autoEcho) {
      holdTimer.current = setTimeout(() => {
        holdTimer.current = null;
        if (!live.current.autoEcho) {
          setStep(afterTakePlayed(stepRef.current, false));
        } else if (live.current.io.advance()) {
          start();
        } else {
          setStep('done');
        }
      }, RESULT_HOLD_MS);
    } else {
      setStep('done');
    }
  };

  // Plays the take back; one that never starts counts as played.
  const playTake = () => {
    live.current.take.playTake();
    if (playTimer.current) clearTimeout(playTimer.current);
    playTimer.current = setTimeout(() => {
      playTimer.current = null;
      if (isPlayStep(stepRef.current) && !wasPlaying.current && !live.current.take.takePlaying) finishLine();
    }, PLAY_START_MS);
  };

  const start = () => {
    clearTimers();
    setResult(null);
    setStep('ladderListen');
    live.current.io.playLine(passSpeed(live.current.base, 'ladderListen'));
  };

  const stop = () => {
    clearTimers();
    starting.current = false;
    setStopping(false);
    setStep('idle');
    live.current.io.stop();
  };

  const startSpeak = async () => {
    if (starting.current) return;
    starting.current = true;
    startedAt.current = Date.now();
    setStopping(false);
    setStep(speakStepOf('ladder'));
    setResult(null);
    const ok = await live.current.io.record(passSpeed(live.current.base, 'ladderShadow'));
    starting.current = false;
    // Closed while the mic was opening: drop that take.
    if (ok && !isSpeakStep(stepRef.current)) void live.current.take.cancel();
    else if (!ok) setStep('idle');
  };

  const lineFinished = () => {
    const { take: tk, autoRecord: auto, base: b, io: o } = live.current;
    const cur = stepRef.current;
    if (isSpeakStep(cur)) {
      if (tk.phase === 'recording') tk.scheduleStop();
      return;
    }
    const after = nextOnLineFinish(cur, auto);
    if (after === cur) return;
    if (isSpeakStep(after)) {
      void startSpeak();
      return;
    }
    setStep(after);
    if (isArmedStep(after)) return;
    if (isPlayStep(after)) playTake();
    else o.playLine(passSpeed(b, after));
  };

  const beat = (n: number) => {
    setCountIn(n);
    countTimer.current = setTimeout(() => {
      countTimer.current = null;
      if (n > 1) {
        beat(n - 1);
      } else {
        setCountIn(null);
        void startSpeak();
      }
    }, COUNT_IN_BEAT_MS);
  };

  const countInThenSpeak = () => {
    if (countTimer.current) {
      clearTimeout(countTimer.current);
      countTimer.current = null;
      setCountIn(null);
      return;
    }
    if (starting.current) return;
    const { take: tk, io: o } = live.current;
    if (tk.phase === 'recording') {
      o.stop();
      void tk.cancel();
    }
    setStopping(false);
    setStep(armedStepOf('ladder'));
    beat(COUNT_IN_BEATS);
  };

  // A saved take from this Shadow pass moves on to Compare: the line plays,
  // then the take answers it.
  useEffect(() => {
    const after = afterTakeSaved(stepRef.current);
    if (
      after !== stepRef.current &&
      take.phase === 'ready' &&
      take.clean.state !== 'working' &&
      take.takeLoaded &&
      take.take &&
      take.take.recordedAt > startedAt.current
    ) {
      setStopping(false);
      setStep(after);
      if (isPlayStep(after)) playTake();
      else live.current.io.playLine(passSpeed(live.current.base, after));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [take.phase, take.take?.recordedAt, take.takeLoaded, take.clean.state]);

  // The take finishing playback ends the line's ladder.
  useEffect(() => {
    if (take.takePlaying && playTimer.current) {
      clearTimeout(playTimer.current);
      playTimer.current = null;
    }
    if (wasPlaying.current && !take.takePlaying && isPlayStep(stepRef.current)) finishLine();
    wasPlaying.current = take.takePlaying;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [take.takePlaying]);

  // The active bar fills over the step's own duration.
  useEffect(() => {
    cancelAnimation(fill);
    fill.value = 0;
    const kind = fillKindOf(step);
    const ms =
      kind === 'line' || kind === 'record'
        ? (lineSec / snapRate(passSpeed(base, step))) * 1000
        : kind === 'take'
          ? take.takeDuration * 1000
          : 0;
    if (ms > 0) fill.value = withTiming(1, { duration: ms, easing: Easing.linear });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [step, take.takeDuration]);

  useEffect(() => clearTimers, []);

  return {
    step,
    active: step !== 'idle' && step !== 'done',
    start,
    stop,
    lineFinished,
    sheet: {
      step,
      programme: 'ladder',
      countdown: null,
      countIn,
      level: take.level,
      fill,
      result,
      error: take.error,
      stopping: stopping && !take.error,
      autoEcho,
      autoRecord,
      onToggleAutoEcho: () => {
        const next = !live.current.autoEcho;
        setAutoEchoState(next);
        setAutoEcho(next).catch(() => {});
      },
      onToggleAutoRecord: () => {
        const next = !live.current.autoRecord;
        setAutoRecordState(next);
        setAutoRecord(next).catch(() => {});
      },
      headset: take.headset,
      onStart: start,
      onRecord: countInThenSpeak,
      onStop: () => {
        setStopping(true);
        void take.finishNow();
      },
      onRetry: countInThenSpeak,
    },
  };
}
