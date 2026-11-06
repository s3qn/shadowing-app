import { useEffect, useMemo, useRef, useState } from 'react';
import { Easing, cancelAnimation, useSharedValue, withTiming } from 'react-native-reanimated';

import type { DockProps, LadderIo, LadderStageProps } from './ladder/ladder-types';
import { segOf } from '@/components/tide/ladder/stage-model';
import { TAIL_MS, type useTake } from '@/hooks/use-take';
import { devAutoPause, devBlindTake, devCountSlow, devFakeTake, devFakeTakeScore, devForcedRoute, devHandsFree, devNoNeighbours, devNoTranslation } from '@/lib/dev-simulate';
import {
  COUNT_DROPS,
  COUNT_IN_BEATS,
  LADDER_PACING,
  LADDER_STAGE_ORDER,
  LADDER_PASSES,
  afterTakeSaved,
  fillKindOf,
  hasPrelude,
  isArmedStep,
  isDropsCount,
  isPlayStep,
  isSpeakStep,
  onLadderLineFinish,
  repeatsOf,
  stageOf,
  stepOfPass,
  textShownAt,
  type LadderPace,
  type PassStep,
  type Prelude,
} from '@/lib/pass-programme';
import { useT } from '@/lib/i18n';
import { getSettingsSync, setLadderPace, subscribeSettings } from '@/lib/settings';
import { wordsKeptUp } from '@/lib/takes';

/** How long a finished line holds (its score and XP still showing) before the next line starts. */
const RESULT_HOLD_MS = 1400;
/** bl106-countin: how long before the hold ends the sentence and score lift away. */
const LEAVE_MS = 300;
/** A take that has not started playing by then is skipped, so the ladder never hangs. */
const PLAY_START_MS = 1500;
/** The longest a headset take's playback waits on its echo cleanup before the raw take plays. */
const CLEAN_WAIT_MS = 4000;
/** The dev fake take (`ladder-fake-take`): the mic "opens" for this long, then the take "plays" for FAKE_PLAY_MS. */
const FAKE_RECORD_MS = 2000;
const FAKE_PLAY_MS = 800;

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

/** What `pause()` froze, so `resume()` can re-enter it. */
type Snapshot = { step: PassStep; repeat: number; final: boolean; inHold: boolean; holdMs: number; counting: boolean };

/**
 * The score of a take recorded in this run of this line (an older saved take keeps
 * its score to itself), or the dev fake take's. Shared by the render and finishLine,
 * so the line's end reads the same score the stage shows, on the same tick.
 */
function takeScore(take: ReturnType<typeof useTake>, since: number, fakeScored: boolean) {
  const fresh = take.phase === 'ready' && !!take.take && take.take.recordedAt > since;
  const sc = fresh ? (take.take?.score ?? null) : null;
  const fake = fakeScored && devFakeTake();
  const fakeScore = fake ? devFakeTakeScore() : null;
  return { fresh, sc, fake, fakeScore, total: fakeScore ?? sc?.total ?? null };
}

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
  paused: boolean;
  pause: () => void;
  resume: () => void;
  loop: boolean;
  setLoop: (on: boolean) => void;
  goLine: (i: number) => void;
  next: () => void;
  prev: () => void;
  pace: LadderPace;
  setPace: (p: LadderPace) => void;
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
  const [blindTake] = useState(() => devBlindTake() ?? getSettingsSync().blindTake);
  // The pace follows Settings live (and the pace sheet): it applies from the next stage or repeat.
  const [pace, setPaceState] = useState<LadderPace>(() => getSettingsSync().ladderPace);
  const paceRef = useRef(pace);
  paceRef.current = pace;
  useEffect(() => subscribeSettings(() => setPaceState(getSettingsSync().ladderPace)), []);
  const pacing = LADDER_PACING[pace];
  // bl106-countin: the announce enterStage chose (the drops' lead on Listen, the pace's announce elsewhere), and
  // the leave LEAVE_MS before a hold ends, so the sentence and score lift away before the next line.
  const [announceMs, setAnnounceMs] = useState(pacing.announceMs);
  // Counts every announce, so an announce that restarts on top of one (a repeat Listen tap in the short lead)
  // restarts the stage's count clock along with the timer.
  const [announceRun, setAnnounceRun] = useState(0);
  const [leaving, setLeaving] = useState(false);
  const leaveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const fill = useSharedValue(0);
  const fillStep = useSharedValue(-1);
  // One timer walks a stage's prelude: the announce hold, the 3 beats, a gap between repeats.
  const preludeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const holdTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const playTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const fakeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // `ladder-paused`: the run pauses itself shortly after it starts.
  const pauseTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
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
  // Compare reached the take while its echo cleanup still runs: it plays once the cleanup lands.
  const playWhenClean = useRef(false);
  const wasPlaying = useRef(false);
  // The blind take after the recorded one (blindTake on): round 2.
  const final = useRef(false);
  const [finalOn, setFinalOn] = useState(false);
  // Pause: the frozen step, and the one transition that arrived while frozen.
  const [paused, setPausedState] = useState(false);
  const pausedRef = useRef(false);
  const snap = useRef<Snapshot | null>(null);
  const pending = useRef<(() => void) | null>(null);
  // The hold after a line's score, so Next can skip it and Pause can keep it.
  const inHold = useRef(false);
  // That hold's length (the Easy offer holds longer), so a Resume holds as long again.
  const holdMsRef = useRef(RESULT_HOLD_MS);
  const [loop, setLoopState] = useState(false);
  const loopRef = useRef(false);
  // The dev fake take has "played": its score shows through the hold.
  const [fakeScored, setFakeScoredState] = useState(false);
  const fakeScoredRef = useRef(false);
  const setFakeScored = (v: boolean) => {
    fakeScoredRef.current = v;
    setFakeScoredState(v);
  };
  // Timers and effects read the latest render's values through this.
  // `handsFree` is the same value the stage gets: dev key, then the host's override, then the setting.
  const handsFreeNow = devHandsFree() ?? io.autoEcho ?? autoEcho;
  const live = useRef({ take, base, lineSec, io, autoEcho, autoRecord, handsFree: handsFreeNow });
  live.current = { take, base, lineSec, io, autoEcho, autoRecord, handsFree: handsFreeNow };

  const setFinal = (v: boolean) => {
    final.current = v;
    setFinalOn(v);
  };
  const setStep = (next: PassStep) => {
    stepRef.current = next;
    setStepState(next);
  };
  const setPaused = (v: boolean) => {
    pausedRef.current = v;
    setPausedState(v);
  };
  const setLoop = (on: boolean) => {
    loopRef.current = on;
    setLoopState(on);
  };
  const clearTimers = () => {
    if (preludeTimer.current) clearTimeout(preludeTimer.current);
    if (holdTimer.current) clearTimeout(holdTimer.current);
    if (playTimer.current) clearTimeout(playTimer.current);
    if (roomTimer.current) clearTimeout(roomTimer.current);
    if (fakeTimer.current) clearTimeout(fakeTimer.current);
    if (pauseTimer.current) clearTimeout(pauseTimer.current);
    if (leaveTimer.current) clearTimeout(leaveTimer.current);
    preludeTimer.current = null;
    holdTimer.current = null;
    playTimer.current = null;
    roomTimer.current = null;
    fakeTimer.current = null;
    pauseTimer.current = null;
    leaveTimer.current = null;
    inHold.current = false;
    stopWhenOpen.current = false;
    playWhenClean.current = false;
    setPreludeState(null);
    setLeaving(false);
  };
  // Any jump, start, stop or record tap drops a pause and what it deferred.
  const clearPause = () => {
    if (!pausedRef.current && !pending.current) return;
    pending.current = null;
    snap.current = null;
    setPaused(false);
  };

  const setRepeat = (n: number) => {
    repeatRef.current = n;
    setRepeatState(n);
  };

  // After the hold: the same line again on Loop (unless Next skipped the hold), else the next line, else the run is over.
  const afterHold = (skipLoop = false) => {
    const l = live.current;
    if (loopRef.current && !skipLoop) {
      start();
      return;
    }
    if (opts?.onRecordStart === 'line') {
      // The record button's ladder covers one line: the track plays on.
      setStep('idle');
      l.io.resume?.();
    } else if (l.io.advance()) {
      start();
    } else {
      setLoop(false);
      setStep('done');
    }
  };

  // The hold on a line's score. Next skips it; Pause keeps the score up until Resume.
  const scheduleAfterLine = (holdMs = RESULT_HOLD_MS) => {
    const l = live.current;
    holdMsRef.current = holdMs;
    if (holdTimer.current) clearTimeout(holdTimer.current);
    if (leaveTimer.current) clearTimeout(leaveTimer.current);
    leaveTimer.current = null;
    if (opts?.onRecordStart !== 'line' && !l.handsFree && !loopRef.current) {
      // Hands-free off: no timer, the run rests on the score until a right tap, scrub, swipe or End.
      holdTimer.current = null;
      inHold.current = true;
      return;
    }
    inHold.current = true;
    holdTimer.current = setTimeout(() => {
      holdTimer.current = null;
      inHold.current = false;
      afterHold();
    }, holdMs);
    // bl106-countin: the sentence and score lift away over the hold's last LEAVE_MS.
    leaveTimer.current = setTimeout(() => {
      leaveTimer.current = null;
      setLeaving(true);
    }, Math.max(0, holdMs - LEAVE_MS));
  };

  // The line's ladder is over: grade it once, then hold on its score.
  const finishLine = () => {
    if (playTimer.current) clearTimeout(playTimer.current);
    playTimer.current = null;
    // A late take ending during the hold already counted: grade the line once.
    wasPlaying.current = false;
    if (inHold.current) return;
    // Read from the take itself, not from a render: the offer at 90+ needs this tick's score.
    const r = live.current.io.onLineDone(takeScore(live.current.take, startedAt.current, fakeScoredRef.current).total);
    scheduleAfterLine(r?.holdMs);
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

  // Compare's take: a headset take (the line played under it) waits for its
  // echo cleanup, capped, so the cleaned file is what plays. A take with no line
  // under it has nothing to clean and plays at once, its score landing behind.
  const playTakeWhenClean = () => {
    const tk = live.current.take;
    if (tk.headset !== true || tk.clean.state !== 'working' || rush.current) {
      playTake();
      return;
    }
    playWhenClean.current = true;
    if (playTimer.current) clearTimeout(playTimer.current);
    playTimer.current = setTimeout(() => {
      playTimer.current = null;
      if (!playWhenClean.current) return;
      playWhenClean.current = false;
      playTake();
    }, CLEAN_WAIT_MS);
  };

  // `sameKey`: the stage key is unchanged (a restart on Listen), so the plate does not fall and the count takes the short lead.
  const start = (sameKey = false) => {
    clearTimers();
    clearPause();
    // A new line's run: a take saved before it is not this run's, nor is its score.
    startedAt.current = Date.now();
    setFakeScored(false);
    setFinal(false);
    enterStage('ladderListen', sameKey);
    if (devAutoPause()) {
      pauseTimer.current = setTimeout(() => {
        pauseTimer.current = null;
        pause();
      }, 1500);
    }
  };

  const stop = () => {
    clearTimers();
    clearPause();
    starting.current = false;
    rush.current = false;
    setStopping(false);
    setLoop(false);
    setStep('idle');
    live.current.io.stop();
  };

  // ladder-fake-take: the mic "opens" for 2 s, the take "plays" for 800 ms, then the line is done.
  const fakeSpeak = () => {
    setStep('ladderRecord');
    fakeTimer.current = setTimeout(() => {
      fakeTimer.current = null;
      fakePlay();
    }, FAKE_RECORD_MS);
  };
  const fakePlay = () => {
    // The first take with the blind take on: the final take runs by itself, like a real one saved.
    if (blindTake && !final.current) {
      setFinal(true);
      enterStage('ladderRecord');
      return;
    }
    setFakeScored(true);
    setStep('ladderPlay');
    fakeTimer.current = setTimeout(() => {
      fakeTimer.current = null;
      if (pausedRef.current) {
        pending.current = finishLine;
        return;
      }
      finishLine();
    }, FAKE_PLAY_MS);
  };

  const startSpeak = async () => {
    if (starting.current) return;
    if (devFakeTake()) {
      fakeSpeak();
      return;
    }
    starting.current = true;
    startedAt.current = Date.now();
    stopWhenOpen.current = false;
    rush.current = false;
    setStopping(false);
    setStep('ladderRecord');
    const ok = await live.current.io.record(live.current.base);
    starting.current = false;
    micAt.current = Date.now();
    // Closed or moved to another line while the mic was opening: drop that take, keep the new run.
    if (!isSpeakStep(stepRef.current)) {
      if (ok) void live.current.take.cancel();
    } else if (!ok) setStep(live.current.io.armOnMicFail ? 'ladderArmed' : 'idle');
  };

  // Every stage but Compare opens the same way: announce it, count 3, 2, 1, then it runs.
  // Record enters as the armed step so the red button shows the count.
  // bl106-countin: Listen counts with the drops. Its announce is the drops' lead (the plate's fall and park), or the
  // short lead when the stage key is unchanged (`sameKey`: a resume, a jump to the running step, the same line again).
  const enterStage = (next: PassStep, sameKey = false) => {
    if (preludeTimer.current) clearTimeout(preludeTimer.current);
    preludeTimer.current = null;
    setStep(isSpeakStep(next) ? 'ladderArmed' : next);
    setRepeat(1);
    const drops = isDropsCount(next);
    const lead = drops
      ? (sameKey ? COUNT_DROPS.shortLeadMs : COUNT_DROPS.leadMs) * devCountSlow()
      : LADDER_PACING[paceRef.current].announceMs;
    setAnnounceMs(lead);
    setLeaving(false);
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
    setAnnounceRun((n) => n + 1);
    preludeTimer.current = setTimeout(() => countBeat(COUNT_IN_BEATS, next), lead);
  };

  // A drops count runs its beats at the slow factor, and the last beat lasts the impact longer, so the line
  // starts exactly when the drop flattens.
  const countBeat = (n: number, next: PassStep) => {
    setPreludeState({ phase: 'count', beat: n });
    const drops = isDropsCount(next);
    const s = drops ? devCountSlow() : 1;
    const beatMs = LADDER_PACING[paceRef.current].beatMs * s + (n === 1 && drops ? COUNT_DROPS.impactMs * s : 0);
    preludeTimer.current = setTimeout(() => {
      preludeTimer.current = null;
      if (n > 1) {
        countBeat(n - 1, next);
      } else {
        setPreludeState(null);
        if (isSpeakStep(next)) void startSpeak();
        else live.current.io.playLine(live.current.base);
      }
    }, beatMs);
  };

  const lineFinished = () => {
    // A line still sounding while a stage announces or counts is not this stage's line.
    if (preludeTimer.current) return;
    // Paused: the track was silenced, not finished. Resume replays the pass.
    if (pausedRef.current) return;
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
    const r = onLadderLineFinish(cur, repeatRef.current, auto, paceRef.current, o.prep ?? true);
    if (r.kind === 'repeat') {
      // Same stage again after a short gap, no count.
      setRepeat(repeatRef.current + 1);
      setPreludeState({ phase: 'gap' });
      preludeTimer.current = setTimeout(() => {
        preludeTimer.current = null;
        setPreludeState(null);
        o.playLine(b);
      }, LADDER_PACING[paceRef.current].gapMs);
      return;
    }
    const after = r.step;
    if (after === cur) return;
    if (isPlayStep(after)) {
      setStep(after);
      playTakeWhenClean();
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
    clearPause();
    // A line, a take, a recording or the hold still running stops before the count.
    live.current.io.stop();
    if (playTimer.current) clearTimeout(playTimer.current);
    playTimer.current = null;
    if (fakeTimer.current) clearTimeout(fakeTimer.current);
    fakeTimer.current = null;
    if (holdTimer.current) clearTimeout(holdTimer.current);
    holdTimer.current = null;
    inHold.current = false;
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
    clearPause();
    o.stop();
    setStopping(false);
    // The step already running (a Listen restart): its plate stays parked, so the short lead.
    enterStage(next, stepRef.current === next);
  };

  // The blind take: announces, counts and opens the mic with the text hidden (Auto Record off waits on a tap).
  const jumpToFinal = () => {
    clearTimers();
    clearPause();
    live.current.io.stop();
    setStopping(false);
    setFinal(true);
    enterStage('ladderRecord');
  };

  const onRecord = () => {
    const cur = stepRef.current;
    // Paused, the circle records now on any stage, Compare too (State row 10).
    if (pausedRef.current) {
      countInThenSpeak();
      return;
    }
    if (cur === 'idle' && opts?.onRecordStart === 'line') {
      // The track may be playing: silence it before the ladder announces.
      live.current.io.stop();
      start();
    } else if (cur === 'idle') start();
    else if (cur === 'done') start();
    else if (isSpeakStep(cur)) {
      if (fakeTimer.current) {
        // Stop on the fake take: it has "played" at once.
        clearTimeout(fakeTimer.current);
        fakeTimer.current = null;
        fakePlay();
        return;
      }
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

  // Pause: freeze the step, silence the track, keep a saved take. On Record it
  // waits for this run's take to be saved: a mic opening, open or closing after
  // Stop has nothing to freeze, and resetting `stopping` there could strand the run.
  const pause = () => {
    const cur = stepRef.current;
    if (pausedRef.current || cur === 'idle' || cur === 'done') return;
    const tk = live.current.take;
    const takeFresh = tk.phase === 'ready' && !!tk.take && tk.take.recordedAt > startedAt.current;
    if (isSpeakStep(cur) && (!takeFresh || starting.current || fakeTimer.current)) return;
    // The Record stage's announce or count: Resume runs it again rather than waiting on a tap.
    const counting = isArmedStep(cur) && preludeTimer.current !== null;
    snap.current = { step: cur, repeat: repeatRef.current, final: final.current, inHold: inHold.current, holdMs: holdMsRef.current, counting };
    pending.current = null;
    clearTimers();
    cancelAnimation(fill);
    fill.value = 0;
    live.current.io.stop();
    setPaused(true);
  };

  // Resume: run what arrived while paused, else re-enter the frozen step from its start.
  const resume = () => {
    if (!pausedRef.current) return;
    const p = pending.current;
    const s = snap.current;
    pending.current = null;
    snap.current = null;
    setPaused(false);
    if (p) {
      p();
      return;
    }
    if (!s) return;
    if (s.inHold) {
      scheduleAfterLine(s.holdMs);
      return;
    }
    if (isArmedStep(s.step)) {
      if (s.counting) enterStage('ladderRecord');
      return;
    }
    if (isPlayStep(s.step)) {
      setStep(s.step);
      if (devFakeTake()) fakePlay();
      else playTake();
      return;
    }
    if (isSpeakStep(s.step)) {
      // The take was saved and still scoring when paused: Compare follows once it lands.
      setStep(s.step);
      return;
    }
    // The frozen step's plate is still parked: the short lead.
    enterStage(s.step, true);
    if (s.repeat > 1) setRepeat(s.repeat);
  };

  // Lines: seek to `i` and run its ladder from Listen. Past the ends, nothing.
  const goLine = (i: number) => {
    const o = live.current.io;
    if (!o.goTo) return;
    clearTimers();
    clearPause();
    // `starting` stays set while io.record is pending: startSpeak clears it when the call
    // returns and drops that take, since the step is no longer Record.
    rush.current = false;
    setStopping(false);
    o.stop();
    // The same line again from Listen keeps its plate parked: the short lead. Read before the seek moves the line.
    const sameKey = i === (o.lineIndex ?? -1) && stepRef.current === 'ladderListen';
    // A refused seek (past the ends) does not restart the line.
    if (!o.goTo(i)) return;
    start(sameKey);
  };
  const next = () => {
    if (inHold.current) {
      // Skip the hold: the next line now, whatever Loop says.
      clearTimers();
      clearPause();
      afterHold(true);
      return;
    }
    const o = live.current.io;
    const i = (o.lineIndex ?? 0) + 1;
    if (o.goTo && i < (o.lineCount ?? 0)) {
      goLine(i);
      return;
    }
    // Past the last line: the run's natural end (session routing as today).
    clearTimers();
    clearPause();
    o.stop();
    if (o.advance()) start();
    else {
      setLoop(false);
      setStep('done');
    }
  };
  const prev = () => {
    const o = live.current.io;
    goLine(Math.max(0, (o.lineIndex ?? 0) - 1));
  };
  const setPace = (p: LadderPace) => {
    setPaceState(p);
    void setLadderPace(p);
  };
  const setSpeed = (v: number) => live.current.io.setSpeed?.(snapRate(v));

  // A saved take moves on to the blind take (the first take, blindTake on)
  // or to Compare: the line plays, then the take answers it. It never waits
  // on the backend: the score lands behind the next stage (the slot shows it
  // pending), and Compare's playback alone waits on a cleanup (playTakeWhenClean).
  useEffect(() => {
    const after = afterTakeSaved(stepRef.current);
    if (
      after !== stepRef.current &&
      take.phase === 'ready' &&
      take.takeLoaded &&
      take.take &&
      take.take.recordedAt > startedAt.current
    ) {
      const go = () => {
        setStopping(false);
        rush.current = false;
        if (isPlayStep(after)) {
          setStep(after);
          playTake();
        } else if (blindTake && !final.current) {
          // The final take runs by itself: announce, count, mic, with the text hidden.
          setFinal(true);
          enterStage('ladderRecord');
        } else enterStage(after);
      };
      if (pausedRef.current) pending.current = go;
      else go();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [take.phase, take.take?.recordedAt, take.takeLoaded, rushTick]);

  // A take that failed to save (or to stop) never turns phase to 'ready', so the advance above
  // never fires and the stage would sit on a Record step with a dead meter. Leave the step the
  // way a failed mic open does: the red button waits (armed) or the ladder rests, the next tap
  // takes the line again, and nothing advances by itself.
  useEffect(() => {
    if (!take.error || take.phase === 'recording' || starting.current) return;
    if (!isSpeakStep(stepRef.current)) return;
    if (take.take && take.take.recordedAt > startedAt.current) return;
    clearTimers();
    stopWhenOpen.current = false;
    rush.current = false;
    setStopping(false);
    setStep(live.current.io.armOnMicFail ? 'ladderArmed' : 'idle');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [take.phase, take.errorSeq]);

  // The cleanup Compare's take waited on has landed (done, skipped or failed): play it now.
  useEffect(() => {
    if (!playWhenClean.current || take.clean.state === 'working') return;
    playWhenClean.current = false;
    if (isPlayStep(stepRef.current) && !pausedRef.current) playTake();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [take.clean.state]);

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
    // A take silenced by Pause is not finished: Resume plays it again from its start.
    if (wasPlaying.current && !take.takePlaying && isPlayStep(stepRef.current) && !pausedRef.current) finishLine();
    wasPlaying.current = take.takePlaying;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [take.takePlaying]);

  // The bar segment this step lights; the fill is handed to it with the reset below (ET-20).
  const fillSeg = segOf(stageOf(step) ? { stage: stageOf(step)!, isRecording: isSpeakStep(step), round: finalOn ? 2 : 1 } : null);
  // The active bar fills over the step's own duration.
  useEffect(() => {
    cancelAnimation(fill);
    fill.value = 0;
    fillStep.value = fillSeg;
    // The bar stays empty through an announce, a count, a gap or a pause.
    const kind = prelude === null && !paused ? fillKindOf(step) : 'none';
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
  }, [step, fillSeg, prelude === null, take.takeDuration, paused]);

  useEffect(() => clearTimers, []);

  const armed = isArmedStep(step);
  const countIn = armed && prelude?.phase === 'count' ? prelude.beat : null;
  const beat = prelude?.phase === 'count' ? prelude.beat : null;
  const stageKey = stageOf(step);
  const stageIndex = stageKey ? LADDER_STAGE_ORDER.indexOf(stageKey) : -1;
  // Only a take recorded in this run of this line: an older saved take keeps its score to itself.
  const { fresh, sc, fake, fakeScore, total: scoreTotal } = takeScore(take, startedAt.current, fakeScored);
  const kept = wordsKeptUp(sc);
  const scoreKept = fakeScore !== null
    ? (fakeScore >= 90 ? '5 of 5 words' : '4 of 5 words')
    : kept ? t('player.keptUpWords', { kept: kept.kept, total: kept.total }) : undefined;
  const scoring = !fake && fresh && !sc && take.clean.state === 'working';
  const scoreAt = fake ? startedAt.current : take.take?.recordedAt;
  const score = useMemo(
    () => ({ total: scoreTotal, keptUp: scoreKept, scoring, at: scoreAt }),
    [scoreTotal, scoreKept, scoring, scoreAt],
  );
  // Turn-taking: the line will not play under the take. A forced dev route (`ladder-speaker`) stands in for the probe.
  const forced = devForcedRoute();
  const speaker = forced ? forced === 'speaker' : take.headset === false;

  // Every handler on `stage` is one stable proxy reading the latest render (D6), so the
  // memoised view never re-renders for a new closure.
  const fns = useRef({ jumpTo, stop, onRecord, jumpToFinal, pause, resume, setLoop, goLine, next, prev, setPace, setSpeed });
  fns.current = { jumpTo, stop, onRecord, jumpToFinal, pause, resume, setLoop, goLine, next, prev, setPace, setSpeed };
  const proxies = useMemo(
    () => ({
      onJump: (i: number) => fns.current.jumpTo(i),
      onEnd: () => fns.current.stop(),
      onStop: () => fns.current.onRecord(),
      onRecord: () => fns.current.onRecord(),
      onFinal: () => fns.current.jumpToFinal(),
      onPause: () => fns.current.pause(),
      onResume: () => fns.current.resume(),
      onLoop: (on: boolean) => fns.current.setLoop(on),
      onLine: (i: number) => fns.current.goLine(i),
      onSkip: () => fns.current.next(),
      onPrev: () => fns.current.prev(),
      onPace: (p: LadderPace) => fns.current.setPace(p),
      onSpeed: (v: number) => fns.current.setSpeed(v),
      // focus-stories D3: the host's hop, read from the latest io.
      onHop: (dir: -1 | 1) => live.current.io.onHop?.(dir),
    }),
    [],
  );

  const phase: LadderStageProps['phase'] = prelude ? prelude.phase : armed ? 'waiting' : 'run';
  const repeats = repeatsOf(step, pace);
  const isRecording = isSpeakStep(step);
  const stopped = isRecording && (stopping || fresh);
  const textHidden = textShownAt(step, blindTake, finalOn) === false;
  const hasLines = typeof io.lineCount === 'number' && io.lineCount > 0;
  const colour = stageIndex >= 0 ? LADDER_PASSES[stageIndex]!.colour : '';
  const hasGoTo = !!io.goTo;
  const hasSetSpeed = !!io.setSpeed;
  // focus-stories: the stage's pass-throughs. `handsFree` is the run's Hands-free (D6): the dev key, then
  // the host's override, then the setting; scheduleAfterLine's rule for it (no timer when off) reads the same.
  const handsFree = devHandsFree() ?? io.autoEcho ?? autoEcho;
  const translation = devNoTranslation() ? '' : (io.translation ?? io.line?.en ?? '');
  const neighbours = devNoNeighbours() ? undefined : io.neighbours;
  const hasHop = !!io.onHop;
  const stage = useMemo(
    (): LadderStageProps | null =>
      stageKey === null || stageIndex < 0
        ? null
        : {
            stage: stageKey,
            index: stageIndex,
            total: LADDER_STAGE_ORDER.length,
            phase,
            beat,
            announceMs,
            announceRun,
            leaving,
            repeat,
            repeats,
            isRecording,
            stopped,
            takePlaying: take.takePlaying,
            textHidden,
            text: io.lineText,
            line: io.line,
            level: take.level,
            fill,
            fillStep,
            colour,
            speaker,
            // Once per line, after the last take: earlier takes score silently.
            score: stageKey === 'compare' ? score : undefined,
            round: finalOn ? 2 : 1,
            finalOn: blindTake,
            prep: io.prep,
            paused,
            loop,
            lineIndex: hasLines ? io.lineIndex : undefined,
            lineCount: hasLines ? io.lineCount : undefined,
            context: io.context,
            title: io.title,
            pace,
            // The rate the passes play at, so the readout and the slider show what is heard.
            speed: snapRate(base),
            ...proxies,
            onLine: hasGoTo ? proxies.onLine : undefined,
            // Always on: past the last line `next()` falls through to `io.advance()` (the island's own routing).
            onPrev: hasGoTo ? proxies.onPrev : undefined,
            onSpeed: hasSetSpeed ? proxies.onSpeed : undefined,
            // focus-stories: D5 translation, D6 hands-free, D8 word tap, D3 neighbours and the hop.
            translation,
            handsFree,
            word: io.word,
            neighbours,
            onHop: hasHop ? proxies.onHop : undefined,
          },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [
      stageKey, stageIndex, phase, beat, announceMs, announceRun, leaving, repeat, repeats, isRecording, stopped, take.takePlaying, textHidden,
      io.lineText, io.line, take.level, speaker, colour, score, finalOn, blindTake, paused, loop, hasLines,
      io.lineIndex, io.lineCount, io.context, io.title, io.prep, pace, base, hasGoTo, hasSetSpeed,
      translation, handsFree, io.word, neighbours, hasHop,
    ],
  );
  return {
    step,
    active: step !== 'idle' && step !== 'done',
    start,
    stop,
    lineFinished,
    jumpTo,
    beat,
    prelude,
    stage,
    paused,
    pause,
    resume,
    loop,
    setLoop,
    goLine,
    next,
    prev,
    pace,
    setPace,
    dock: {
      face: countIn !== null ? 'count' : isSpeakStep(step) ? (stopping && !take.error ? 'dim' : 'stop') : isPlayStep(step) ? 'dim' : 'dot',
      countIn,
      beatMs: pacing.beatMs,
      recordLabel: t(
        countIn !== null
          ? 'player.cancelCountIn'
          : step === 'idle'
            ? 'player.shadow'
            : step === 'done'
              ? 'player.startAgain'
              : isSpeakStep(step)
                ? 'player.stopRecording'
                : isArmedStep(step)
                  ? 'player.record'
                  : 'player.recordNow',
      ),
      stageIndex,
      ringDisabled: countIn !== null || isSpeakStep(step) || isPlayStep(step),
      onRecord,
    },
  };
}
