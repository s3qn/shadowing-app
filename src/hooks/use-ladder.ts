import { useEffect, useRef, useState } from 'react';
import { Easing, cancelAnimation, useSharedValue, withTiming, type SharedValue } from 'react-native-reanimated';

import type { Line } from '@/lib/api';
import { TAIL_MS, type useTake } from '@/hooks/use-take';
import {
  COUNT_IN_BEATS,
  LADDER_PACING,
  LADDER_STAGE_ORDER,
  LADDER_PASSES,
  afterTakePlayed,
  afterTakeSaved,
  fillKindOf,
  hasPrelude,
  isArmedStep,
  isPlayStep,
  isSpeakStep,
  hintKeyOf,
  onLadderLineFinish,
  repeatsOf,
  stageOf,
  stepOfPass,
  textShownAt,
  type LadderStage,
  type PassStep,
  type Prelude,
} from '@/lib/pass-programme';
import { useT } from '@/lib/i18n';
import { getSettingsSync } from '@/lib/settings';
import { wordsKeptUp } from '@/lib/takes';

/** How long a finished line holds (its score and XP still showing) before the next line starts. */
const RESULT_HOLD_MS = 1400;
/** A take that has not started playing by then is skipped, so the ladder never hangs. */
const PLAY_START_MS = 1500;

/**
 * How long a ladder take keeps the mic open, in seconds, for a line that
 * plays for `wallSec`: the line × 1.6 + 1.5s, so a speaker a beat behind is
 * never cut off. Stop ends it sooner at any moment.
 */
export const takeRoomSec = (wallSec: number) => wallSec * 1.6 + 1.5;
/** The line length to hand `startTake` so its own timers (the silent take's tail, the watchdog) allow that room. */
export const takeWatchSec = (wallSec: number) => takeRoomSec(wallSec) - TAIL_MS / 1000;

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
  /** A record-button ladder is over: let the track play on from the next line. */
  resume?: () => void;
  /** Move to the next line; false when there is none. */
  advance: () => boolean;
  /** The current line's text, for the stage view. */
  lineText: string;
  line?: Line | null;
};

/** What the red button in the dock shows and does while the ladder runs. */
export type DockProps = {
  face: 'dot' | 'count' | 'stop' | 'dim';
  countIn: number | null;
  /** One count beat in ms, for the red button's beat ring. */
  beatMs: number;
  recordLabel: string;
  ringDisabled: boolean;
  onRecord: () => void;
};

/** Everything the stage view needs to draw one ladder stage. */
export type LadderStageProps = {
  stage: LadderStage;
  index: number;
  total: number;
  phase: 'announce' | 'count' | 'gap' | 'run' | 'waiting';
  beat: number | null;
  repeat: number;
  repeats: number;
  isRecording: boolean;
  takePlaying: boolean;
  textHidden: boolean;
  text: string;
  /** The line with its words and ruby, for the card's furigana. */
  line?: Line | null;
  /** Live mic level, 0..1, for the recording meter. */
  level?: SharedValue<number>;
  fill: SharedValue<number>;
  hint: string;
  colour: string;
  holdTitle?: string | null;
  /**
   * This line's newest take's score, shown under the rail from the moment it
   * arrives until the next line starts; hidden when total is null. `scoring`
   * while the backend still works on it, `at` the take's recordedAt.
   */
  score?: { total: number | null; keptUp?: string; scoring?: boolean; at?: number };
  /** 2 while on the optional blind take after the recorded one. */
  round?: 1 | 2;
  /** Whether this run ends on the blind take (the blindTake setting). */
  finalOn?: boolean;
  onJump: (i: number) => void;
  onEnd: () => void;
  /** The mic has closed on this take (Stop tapped, or the take ended and is saving). */
  stopped?: boolean;
  /** The dock's red button: stops the take in progress, which then moves on. */
  onStop?: () => void;
  /** The dock's red button while a take waits on the tap: counts in, then records. */
  onRecord?: () => void;
  /** Jumps to the blind take. */
  onFinal?: () => void;
  onHelp?: () => void;
  onSkip?: () => void;
};

/**
 * The five-pass ladder for a player whose lines are spans of one track. The
 * step and speed rules are `pass-programme.ts`'s; this wraps them in the
 * timers and the take plumbing and drives the stage view and the dock's red
 * button through `stage` and `dock`.
 */
export function useLadder(
  take: ReturnType<typeof useTake>,
  base: number,
  lineSec: number,
  io: LadderIo,
  opts?: { onRecordStart?: 'ladder' | 'line' },
): {
  step: PassStep;
  active: boolean;
  start: () => void;
  stop: () => void;
  lineFinished: () => void;
  jumpTo: (i: number) => void;
  dock: DockProps;
  /** The count beat (3, 2, 1) of any stage's prelude, else null. */
  beat: number | null;
  prelude: Prelude;
  stage: LadderStageProps | null;
} {
  const { t } = useT();
  const [step, setStepState] = useState<PassStep>('idle');
  const stepRef = useRef<PassStep>('idle');
  const [prelude, setPreludeState] = useState<Prelude>(null);
  const [repeat, setRepeatState] = useState(1);
  const repeatRef = useRef(1);
  const [stopping, setStopping] = useState(false);
  // Read once at mount: the toggles left the run UI, Settings > Playback owns them.
  const [autoEcho] = useState(() => getSettingsSync().autoEcho);
  const [autoRecord] = useState(() => getSettingsSync().autoRecord);
  const [pace] = useState(() => getSettingsSync().ladderPace);
  const [blindTake] = useState(() => getSettingsSync().blindTake);
  const pacing = LADDER_PACING[pace];
  const fill = useSharedValue(0);
  // One timer walks a stage's prelude: the announce hold, the 3 beats, a gap between repeats.
  const preludeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const holdTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const playTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const startedAt = useRef(0);
  const starting = useRef(false);
  // When the mic opened, and the timer holding the take open past the line's end (takeRoomSec).
  const micAt = useRef(0);
  const roomTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Stop tapped while the mic was still opening: the take ends as soon as it opens.
  const stopWhenOpen = useRef(false);
  // Stop tapped while the saved take waits on its echo cleanup: move on without it.
  const rush = useRef(false);
  const [rushTick, setRushTick] = useState(0);
  const wasPlaying = useRef(false);
  // The blind take after the recorded one (blindTake on): round 2.
  const final = useRef(false);
  const [finalOn, setFinalOn] = useState(false);
  // Timers and effects read the latest render's values through this.
  const live = useRef({ take, base, lineSec, io, autoEcho, autoRecord });
  live.current = { take, base, lineSec, io, autoEcho, autoRecord };

  const setFinal = (v: boolean) => {
    final.current = v;
    setFinalOn(v);
  };
  const setStep = (next: PassStep) => {
    stepRef.current = next;
    setStepState(next);
  };
  const clearTimers = () => {
    if (preludeTimer.current) clearTimeout(preludeTimer.current);
    if (holdTimer.current) clearTimeout(holdTimer.current);
    if (playTimer.current) clearTimeout(playTimer.current);
    if (roomTimer.current) clearTimeout(roomTimer.current);
    preludeTimer.current = null;
    holdTimer.current = null;
    playTimer.current = null;
    roomTimer.current = null;
    stopWhenOpen.current = false;
    setPreludeState(null);
  };

  const setRepeat = (n: number) => {
    repeatRef.current = n;
    setRepeatState(n);
  };

  // The line's ladder is over: hold on its score, then move on or stop.
  const finishLine = () => {
    if (playTimer.current) clearTimeout(playTimer.current);
    playTimer.current = null;
    const l = live.current;
    l.io.onLineDone();
    if (opts?.onRecordStart === 'line') {
      // The record button's ladder covers one line: hold the score, then the track plays on.
      holdTimer.current = setTimeout(() => {
        holdTimer.current = null;
        setStep('idle');
        live.current.io.resume?.();
      }, RESULT_HOLD_MS);
    } else if (l.autoEcho) {
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
    // A new line's run: a take saved before it is not this run's, nor is its score.
    startedAt.current = Date.now();
    setFinal(false);
    enterStage('ladderListen');
  };

  const stop = () => {
    clearTimers();
    starting.current = false;
    rush.current = false;
    setStopping(false);
    setStep('idle');
    live.current.io.stop();
  };

  const startSpeak = async () => {
    if (starting.current) return;
    starting.current = true;
    startedAt.current = Date.now();
    stopWhenOpen.current = false;
    rush.current = false;
    setStopping(false);
    setStep('ladderRecord');
    const ok = await live.current.io.record(live.current.base);
    starting.current = false;
    micAt.current = Date.now();
    // Closed while the mic was opening: drop that take.
    if (ok && !isSpeakStep(stepRef.current)) void live.current.take.cancel();
    else if (!ok) setStep('idle');
  };

  // Every stage but Compare opens the same way: announce it, count 3, 2, 1, then it runs.
  // Record enters as the armed step so the red button shows the count.
  const enterStage = (next: PassStep) => {
    if (preludeTimer.current) clearTimeout(preludeTimer.current);
    preludeTimer.current = null;
    setStep(isSpeakStep(next) ? 'ladderArmed' : next);
    setRepeat(1);
    if (!hasPrelude(next)) {
      // Compare plays the line at once; the take answers it at the line's end.
      setPreludeState(null);
      preludeTimer.current = setTimeout(() => {
        preludeTimer.current = null;
        live.current.io.playLine(live.current.base);
      }, 0);
      return;
    }
    setPreludeState({ phase: 'announce' });
    preludeTimer.current = setTimeout(() => countBeat(COUNT_IN_BEATS, next), pacing.announceMs);
  };

  const countBeat = (n: number, next: PassStep) => {
    setPreludeState({ phase: 'count', beat: n });
    preludeTimer.current = setTimeout(() => {
      preludeTimer.current = null;
      if (n > 1) {
        countBeat(n - 1, next);
      } else {
        setPreludeState(null);
        if (isSpeakStep(next)) void startSpeak();
        else live.current.io.playLine(live.current.base);
      }
    }, pacing.beatMs);
  };

  const lineFinished = () => {
    // A line still sounding while a stage announces or counts is not this stage's line.
    if (preludeTimer.current) return;
    const { take: tk, autoRecord: auto, base: b, io: o } = live.current;
    const cur = stepRef.current;
    if (isSpeakStep(cur)) {
      if (tk.phase !== 'recording' || roomTimer.current) return;
      // The take stays open for its room, then ends after the tail scheduleStop adds.
      const wait = takeRoomSec(live.current.lineSec / snapRate(b)) * 1000 - (Date.now() - micAt.current) - TAIL_MS;
      if (!(wait > 0)) {
        tk.scheduleStop();
        return;
      }
      roomTimer.current = setTimeout(() => {
        roomTimer.current = null;
        if (isSpeakStep(stepRef.current)) live.current.take.scheduleStop();
      }, wait);
      return;
    }
    const r = onLadderLineFinish(cur, repeatRef.current, auto, pace);
    if (r.kind === 'repeat') {
      // Same stage again after a short gap, no count.
      setRepeat(repeatRef.current + 1);
      setPreludeState({ phase: 'gap' });
      preludeTimer.current = setTimeout(() => {
        preludeTimer.current = null;
        setPreludeState(null);
        o.playLine(b);
      }, pacing.gapMs);
      return;
    }
    const after = r.step;
    if (after === cur) return;
    if (isPlayStep(after)) {
      setStep(after);
      playTake();
    } else if (isArmedStep(after)) {
      // Auto Record off: wait on the tap, which then announces and counts.
      setStep(after);
    } else {
      enterStage(after);
    }
  };

  const countInThenSpeak = () => {
    // A tap while the Record count runs cancels it.
    if (preludeTimer.current && stepRef.current === 'ladderArmed') {
      clearTimeout(preludeTimer.current);
      preludeTimer.current = null;
      setPreludeState(null);
      return;
    }
    if (starting.current) return;
    // A line, a take or a recording still running stops before the count.
    live.current.io.stop();
    if (playTimer.current) clearTimeout(playTimer.current);
    playTimer.current = null;
    setStopping(false);
    enterStage('ladderRecord');
  };

  // A tap on a mark: that pass on this line. The line, a take playing back,
  // a count or a recording all stop first, so nothing plays twice.
  const jumpTo = (i: number) => {
    const { take: tk, io: o } = live.current;
    const next = stepOfPass(i, tk.phase === 'ready' && !!tk.take);
    setFinal(false);
    if (isArmedStep(next)) {
      countInThenSpeak();
      return;
    }
    clearTimers();
    o.stop();
    setStopping(false);
    enterStage(next);
  };

  // The blind take: waits on the Record tap with the text hidden.
  const jumpToFinal = () => {
    clearTimers();
    live.current.io.stop();
    if (playTimer.current) clearTimeout(playTimer.current);
    playTimer.current = null;
    setStopping(false);
    setFinal(true);
    setStep('ladderArmed');
  };

  const onRecord = () => {
    const cur = stepRef.current;
    if (cur === 'idle' && opts?.onRecordStart === 'line') {
      // The track may be playing: silence it before the ladder announces.
      live.current.io.stop();
      start();
    } else if (cur === 'idle') start();
    else if (cur === 'done') start();
    else if (isSpeakStep(cur)) {
      // Stop works at any moment: on an open mic it ends the take now, before
      // the mic opens it ends the take the moment it does, and on a saved take
      // still cleaning it moves on without the cleanup.
      setStopping(true);
      const tk = live.current.take;
      if (tk.phase === 'recording') tk.finishNow();
      else if (tk.take && tk.take.recordedAt > startedAt.current) {
        rush.current = true;
        setRushTick((n) => n + 1);
      } else stopWhenOpen.current = true;
    } else if (!isPlayStep(cur)) countInThenSpeak();
  };

  // A saved take moves on to the blind take (the first take, blindTake on)
  // or to Compare: the line plays, then the take answers it.
  useEffect(() => {
    const after = afterTakeSaved(stepRef.current);
    if (
      after !== stepRef.current &&
      take.phase === 'ready' &&
      (take.clean.state !== 'working' || rush.current) &&
      take.takeLoaded &&
      take.take &&
      take.take.recordedAt > startedAt.current
    ) {
      setStopping(false);
      rush.current = false;
      if (isPlayStep(after)) {
        setStep(after);
        playTake();
      } else if (blindTake && !final.current) {
        // Waits on the Record tap, whatever Auto Record says.
        setFinal(true);
        setStep('ladderArmed');
      } else enterStage(after);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [take.phase, take.take?.recordedAt, take.takeLoaded, take.clean.state, rushTick]);

  // Stop tapped while the mic was opening: the take ends now that it is open.
  useEffect(() => {
    if (take.phase !== 'recording' || !stopWhenOpen.current) return;
    stopWhenOpen.current = false;
    take.finishNow();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [take.phase]);

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
    // The bar stays empty through an announce, a count or a gap.
    const kind = prelude === null ? fillKindOf(step) : 'none';
    const ms =
      kind === 'line'
        ? (lineSec / snapRate(base)) * 1000
        : kind === 'record'
          ? takeRoomSec(lineSec / snapRate(base)) * 1000
          : kind === 'take'
            ? take.takeDuration * 1000
            : 0;
    if (ms > 0) fill.value = withTiming(1, { duration: ms, easing: Easing.linear });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [step, prelude === null, take.takeDuration]);

  useEffect(() => clearTimers, []);

  const armed = isArmedStep(step);
  const countIn = armed && prelude?.phase === 'count' ? prelude.beat : null;
  const beat = prelude?.phase === 'count' ? prelude.beat : null;
  const stageKey = stageOf(step);
  const stageIndex = stageKey ? LADDER_STAGE_ORDER.indexOf(stageKey) : -1;
  // Only a take recorded in this run of this line: an older saved take keeps its score to itself.
  const fresh = take.phase === 'ready' && !!take.take && take.take.recordedAt > startedAt.current;
  const sc = fresh ? (take.take?.score ?? null) : null;
  const kept = wordsKeptUp(sc);
  const score = {
    total: sc?.total ?? null,
    keptUp: kept ? t('player.keptUpWords', { kept: kept.kept, total: kept.total }) : undefined,
    scoring: fresh && !sc && take.clean.state === 'working',
    at: take.take?.recordedAt,
  };
  let hint = t(
    (armed || isSpeakStep(step)) && take.headset === false ? 'player.headsetPrompt' : hintKeyOf(step),
  );
  if (stageIndex >= 0 && prelude?.phase === 'announce') {
    hint = t('player.announce', { name: t(LADDER_PASSES[stageIndex]!.titleKey) });
  } else if (prelude?.phase === 'gap') {
    hint = t('player.again', { n: repeat, total: repeatsOf(step, pace) });
  }
  return {
    step,
    active: step !== 'idle' && step !== 'done',
    start,
    stop,
    lineFinished,
    jumpTo,
    beat,
    prelude,
    stage:
      stageKey === null || stageIndex < 0
        ? null
        : {
            stage: stageKey,
            index: stageIndex,
            total: LADDER_STAGE_ORDER.length,
            phase: prelude ? prelude.phase : armed ? 'waiting' : 'run',
            beat,
            repeat,
            repeats: repeatsOf(step, pace),
            isRecording: isSpeakStep(step),
            stopped:
              isSpeakStep(step) &&
              (stopping || (take.phase === 'ready' && !!take.take && take.take.recordedAt > startedAt.current)),
            takePlaying: take.takePlaying,
            textHidden: textShownAt(step, blindTake, finalOn) === false,
            text: io.lineText,
            line: io.line,
            level: take.level,
            fill,
            hint,
            colour: LADDER_PASSES[stageIndex]!.colour,
            score,
            round: finalOn ? 2 : 1,
            finalOn: blindTake,
            onJump: jumpTo,
            onEnd: stop,
            onStop: onRecord,
            onRecord,
            onFinal: jumpToFinal,
          },
    dock: {
      face: countIn !== null ? 'count' : isSpeakStep(step) ? (stopping && !take.error ? 'dim' : 'stop') : isPlayStep(step) ? 'dim' : 'dot',
      countIn,
      beatMs: pacing.beatMs,
      recordLabel: t(
        countIn !== null
          ? 'player.cancelCountIn'
          : step === 'idle'
            ? opts?.onRecordStart === 'line'
              ? 'player.recordMyTake'
              : 'player.startLadder'
            : step === 'done'
              ? 'player.startAgain'
              : isSpeakStep(step)
                ? 'player.stopRecording'
                : isArmedStep(step)
                  ? 'player.record'
                  : 'player.recordNow',
      ),
      ringDisabled: countIn !== null || isSpeakStep(step) || isPlayStep(step),
      onRecord,
    },
  };
}
