import { useEffect, useRef, useState } from 'react';
import { Easing, cancelAnimation, useSharedValue, withTiming } from 'react-native-reanimated';

import type { PassStripProps } from '@/components/tide/pass-strip';
import type { SparkleResultData } from '@/components/tide/sparkle-result';
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
  hintKeyOf,
  nextOnLineFinish,
  speakStepOf,
  stepOfPass,
  type PassStep,
} from '@/lib/pass-programme';
import { useT } from '@/lib/i18n';
import { getSettingsSync } from '@/lib/settings';
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
  /** The single pass is over: let the track play on from the next line. */
  resume?: () => void;
  /** Move to the next line; false when there is none. */
  advance: () => boolean;
};

/** What the red button in the dock shows and does while the ladder runs. */
type DockProps = {
  face: 'dot' | 'count' | 'stop' | 'dim';
  countIn: number | null;
  recordLabel: string;
  ringDisabled: boolean;
  onRecord: () => void;
};

/**
 * The five-pass ladder for a player whose lines are spans of one track. The
 * step and speed rules are `pass-programme.ts`'s; this wraps them in the
 * timers and the take plumbing and drives the pass strip and the dock's red
 * button through `strip` and `dock`.
 */
export function useLadder(
  take: ReturnType<typeof useTake>,
  base: number,
  lineSec: number,
  io: LadderIo,
  opts?: { onRecordStart?: 'ladder' | 'once' },
): {
  step: PassStep;
  active: boolean;
  /** True while a single in-place pass runs, not the full ladder. */
  once: boolean;
  start: () => void;
  stop: () => void;
  lineFinished: () => void;
  jumpTo: (i: number) => void;
  strip: Omit<PassStripProps, 'onHelp'>;
  dock: DockProps;
} {
  const { t } = useT();
  const [step, setStepState] = useState<PassStep>('idle');
  const stepRef = useRef<PassStep>('idle');
  const [result, setResult] = useState<SparkleResultData>(null);
  const [countIn, setCountIn] = useState<number | null>(null);
  const [stopping, setStopping] = useState(false);
  // Read once at mount: the toggles left the run UI, Settings > Playback owns them.
  const [autoEcho] = useState(() => getSettingsSync().autoEcho);
  const [autoRecord] = useState(() => getSettingsSync().autoRecord);
  const fill = useSharedValue(0);
  const countTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const holdTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const playTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const startedAt = useRef(0);
  const starting = useRef(false);
  const wasPlaying = useRef(false);
  const once = useRef(false);
  const [onceOn, setOnceOn] = useState(false);
  // Timers and effects read the latest render's values through this.
  const live = useRef({ take, base, lineSec, io, autoEcho, autoRecord });
  live.current = { take, base, lineSec, io, autoEcho, autoRecord };

  const setOnce = (v: boolean) => {
    once.current = v;
    setOnceOn(v);
  };
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
    if (once.current) {
      // A casual single pass earns nothing; the track plays on.
      setOnce(false);
      setStep('idle');
      l.io.resume?.();
      return;
    }
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
    setOnce(false);
    setResult(null);
    setStep('ladderListen');
    live.current.io.playLine(live.current.base);
  };

  const stop = () => {
    clearTimers();
    setOnce(false);
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
    const ok = await live.current.io.record(live.current.base);
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
      // Shadow always counts three beats before the mic opens.
      setStep(armedStepOf('ladder'));
      beat(COUNT_IN_BEATS);
      return;
    }
    setStep(after);
    if (isArmedStep(after)) return;
    if (isPlayStep(after)) playTake();
    else o.playLine(b);
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
    // A line, a take or a recording still running stops before the count.
    live.current.io.stop();
    if (playTimer.current) clearTimeout(playTimer.current);
    playTimer.current = null;
    setStopping(false);
    setStep(armedStepOf('ladder'));
    beat(COUNT_IN_BEATS);
  };

  // One shadow pass on the current line: count in, record under the line, Compare.
  const startShadowOnce = () => {
    clearTimers();
    setResult(null);
    setOnce(true);
    countInThenSpeak();
  };

  // A tap on a mark: that pass on this line. A count or a take in progress is dropped first.
  const jumpTo = (i: number) => {
    const { take: tk, io: o, base: b } = live.current;
    const next = stepOfPass('ladder', i, tk.phase === 'ready' && !!tk.take);
    if (isArmedStep(next)) {
      if (countTimer.current) {
        clearTimeout(countTimer.current);
        countTimer.current = null;
      }
      countInThenSpeak();
      return;
    }
    clearTimers();
    if (tk.phase === 'recording') {
      o.stop();
      void tk.cancel();
    } else {
      tk.stopTake();
    }
    setStopping(false);
    setResult(null);
    setStep(next);
    o.playLine(b);
  };

  const onRecord = () => {
    const cur = stepRef.current;
    if (once.current) {
      if (isSpeakStep(cur)) {
        setStopping(true);
        void live.current.take.finishNow();
      } else stop();
    } else if (cur === 'idle' && opts?.onRecordStart === 'once') startShadowOnce();
    else if (cur === 'idle') start();
    else if (cur === 'done') start();
    else if (isSpeakStep(cur)) {
      setStopping(true);
      void live.current.take.finishNow();
    } else if (!isPlayStep(cur)) countInThenSpeak();
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
      else live.current.io.playLine(live.current.base);
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
        ? (lineSec / snapRate(base)) * 1000
        : kind === 'take'
          ? take.takeDuration * 1000
          : 0;
    if (ms > 0) fill.value = withTiming(1, { duration: ms, easing: Easing.linear });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [step, take.takeDuration]);

  useEffect(() => clearTimers, []);

  const armed = isArmedStep(step);
  return {
    step,
    active: step !== 'idle' && step !== 'done',
    once: onceOn,
    start,
    stop,
    lineFinished,
    jumpTo,
    strip: {
      programme: 'ladder',
      step,
      fill,
      result,
      hint: t((armed || isSpeakStep(step)) && take.headset === false ? 'player.headsetPrompt' : hintKeyOf(step, 'ladder')),
      onJump: jumpTo,
      onEnd: stop,
    },
    dock: {
      face: countIn !== null ? 'count' : isSpeakStep(step) ? (stopping && !take.error ? 'dim' : 'stop') : isPlayStep(step) ? 'dim' : 'dot',
      countIn,
      recordLabel: t(
        countIn !== null
          ? 'player.cancelCountIn'
          : step === 'idle'
            ? opts?.onRecordStart === 'once'
              ? 'player.recordMyTake'
              : 'player.startLadder'
            : step === 'done'
              ? 'player.startAgain'
              : isSpeakStep(step)
                ? 'player.stopRecording'
                : onceOn
                  ? 'player.stop'
                  : isArmedStep(step)
                    ? 'player.record'
                    : 'player.recordNow',
      ),
      ringDisabled: countIn !== null || isSpeakStep(step) || isPlayStep(step),
      onRecord,
    },
  };
}
