// The ladder's stage fill on the island: the `echoFill` SharedValue, the listening passes' aim
// from the line player's status, the Play step's aim from the take player, and the step effect
// that resets and re-aims it. Owner: I2a. Every timing on the value lives here, with the value.
import type { AudioStatus } from 'expo-audio';
import { useEffect, useEffectEvent, useLayoutEffect, useRef, type MutableRefObject, type RefObject } from 'react';
import { cancelAnimation, Easing, useSharedValue, withSequence, withTiming } from 'react-native-reanimated';

import type { IslandCore } from '@/hooks/island/island-core';
import { takeRoomSec } from '@/hooks/use-ladder';
import { TAIL_MS, type useTake, WATCHDOG_FALLBACK_MS } from '@/hooks/use-take';
import { fillKindOf, type PassStep } from '@/lib/pass-programme';

export type EchoFillParams = {
  /** The island hook contract: every island hook takes the route's actions. This one calls none. */
  core: MutableRefObject<IslandCore | null>;
  echoRef: MutableRefObject<PassStep>;
  rateRef: MutableRefObject<number>;
  latestStatus: RefObject<AudioStatus>;
  takeStatusHandler: MutableRefObject<(s: AudioStatus) => void>;
  ladderStep: PassStep;
  /** The bar segment the step lights (segOf of the ladder's stage), handed the fill with each reset. */
  ladderSeg: number;
  ladderPaused: boolean;
  takePhase: ReturnType<typeof useTake>['phase'];
  lineSecLive: number;
  breathSec: number;
  takeLagMs: number;
};

/** How far the fill may drift from the real position before it is steered back. */
const DRIFT = 0.15;
/** The soft catch-up when the fill lags the real position by more than DRIFT. */
const CATCH_UP_MS = 120;
/** A play's first aim waits for a position this close to the top (file seconds at rate 1)... */
const START_S = 0.25;
/** ...or for this many advancing statuses in a row (a play that did not start at the top). */
const START_RUNS = 3;

/**
 * One status source's history: its last tick, whether this pass has aimed the fill, and
 * whether a new play began (a stop or a jump back) since that aim.
 */
type Track = { tick: { t: number; at: number; playing: boolean } | null; aimed: boolean; fresh: boolean; runs: number };
const newTrack = (): Track => ({ tick: null, aimed: false, fresh: true, runs: 0 });

export function useEchoFill(p: EchoFillParams) {
  const { echoRef, rateRef, latestStatus, takeStatusHandler, ladderStep, ladderSeg, ladderPaused, takePhase, lineSecLive, breathSec, takeLagMs } = p;
  // The ladder's active stage fill, 0..1, animated on the UI thread the same
  // way: one shared value, aimed with withTiming over the step's real
  // duration, re-aimed only on drift. Which segment reads it is decided by
  // the step (see the effect below).
  const echoFill = useSharedValue(0);
  // The bar segment `echoFill` belongs to (segOf). Written with each reset to 0, so the
  // segment a step change mounts draws empty until then, not the last stage's full value (ET-20).
  const echoFillSeg = useSharedValue(-1);
  const lineTrack = useRef<Track>(newTrack());
  const takeTrack = useRef<Track>(newTrack());

  // The fill toward `target` (0..1) with `remainingMs` of the play left. It never runs
  // backward within a pass: a lagging fill catches up in CATCH_UP_MS, a leading one keeps
  // its place and runs the rest over the time left. `restart` sets it outright: the first
  // aim of a pass, or a repeat pass starting over from the top.
  function steer(target: number, remainingMs: number, restart: boolean) {
    cancelAnimation(echoFill);
    const ms = Number.isFinite(remainingMs) ? Math.max(0, remainingMs) : 0;
    if (restart) {
      echoFill.value = target;
      echoFill.value = withTiming(1, { duration: ms, easing: Easing.linear });
    } else if (target - echoFill.value > DRIFT) {
      echoFill.value = withSequence(
        withTiming(target, { duration: CATCH_UP_MS }),
        withTiming(1, { duration: Math.max(0, ms - CATCH_UP_MS), easing: Easing.linear }),
      );
    } else {
      echoFill.value = withTiming(1, { duration: ms, easing: Easing.linear });
    }
  }

  // ET-20 A: the first statuses of a new play can still carry the old position (before the
  // seek to the top or the new source lands), and the real one follows as a jump back. So a
  // status only counts once the position moves forward from the one before it at a
  // believable pace; a stop or a jump back marks a new play. `force` (a speed pick on an
  // aimed pass) re-times from the newest status even when it is the same tick.
  function follow(track: Track, s: AudioStatus, span: number, rate: number, force: boolean) {
    const now = Date.now();
    const prev = track.tick;
    track.tick = { t: s.currentTime, at: now, playing: s.playing };
    if (!s.playing) {
      track.fresh = true;
      track.runs = 0;
      return;
    }
    const dt = prev ? s.currentTime - prev.t : 0;
    if (prev && dt < 0) {
      track.fresh = true;
      track.runs = 0;
      return;
    }
    const advancing = !!prev && prev.playing && dt > 0 && dt <= ((now - prev.at) / 1000) * rate * 2.5 + 0.15;
    if (advancing) track.runs += 1;
    if (!advancing && !(force && track.aimed)) return;
    const target = Math.min(1, Math.max(0, s.currentTime / span));
    // File seconds over the live rate: the wall-clock time the rest takes.
    const remaining = ((span - s.currentTime) * 1000) / rate;
    if (!track.aimed) {
      if (s.currentTime > START_S * rate && track.runs < START_RUNS) return;
      track.aimed = true;
      track.fresh = false;
      steer(target, remaining, true);
      return;
    }
    // A repeat pass: the line started over from the top while the fill stood near full.
    if (track.fresh && target < echoFill.value - DRIFT) {
      track.fresh = false;
      steer(target, remaining, true);
      return;
    }
    track.fresh = false;
    if (force || Math.abs(target - echoFill.value) > DRIFT) steer(target, remaining, false);
  }

  // The Play step's fill: aimed from the take player's status updates rather
  // than a render per tick, then steered only on drift.
  const aimTakeFill = (s: AudioStatus) => {
    if (fillKindOf(echoRef.current) !== 'take' || !s.isLoaded) return;
    if (!Number.isFinite(s.duration) || !Number.isFinite(s.currentTime) || s.duration <= 0) return;
    follow(takeTrack.current, s, s.duration, 1, false);
  };
  useLayoutEffect(() => {
    takeStatusHandler.current = aimTakeFill;
  });

  // The stage fill: which stage is "active" is `step` itself, so this only
  // has to animate `echoFill`
  // toward 1 over that step's real duration. Reset to 0 on every step change,
  // which is also what makes a finished step's fill hold at full: the sheet
  // renders segments before the active one as always full, so once the step
  // moves on this value stops mattering for it.
  const echoFillStep = useRef<PassStep>('idle');
  // The Speak segment has no natural end event to key off (the learner or the
  // watchdog can stop it early), so it is aimed once per recording attempt:
  // the mic opening after a Retry's cancel is a new attempt.
  const echoFillRecAimed = useRef(false);
  // The listening passes follow the line's own position, so they are aimed from
  // onLineStatus on each status as well as from the step effect below. A
  // status landing between a step change's render and that effect leaves the
  // fill alone: the effect resets it to 0 first, then the next statuses aim it.
  // `force` re-times at once: a mid-play speed pick changes how fast the rest runs.
  function aimEchoLine(s: AudioStatus, force = false) {
    const step = echoRef.current;
    if (echoFillStep.current !== step) return;
    // A position that is not a number would reach the sheet's percentage
    // width, and a NaN in a worklet ends Expo Go without a red box.
    if (!Number.isFinite(s.currentTime)) return;
    // A pass owns the pad too (it is the breath before the next pass), so its
    // fill runs the whole source.
    if (fillKindOf(step) !== 'line') return;
    const span = s.duration;
    if (!Number.isFinite(span) || span <= 0) return;
    const rate = rateRef.current > 0 && Number.isFinite(rateRef.current) ? rateRef.current : 1;
    follow(lineTrack.current, s, span, rate, force);
  }
  // An effect event, so the effect below runs for the deps it lists and
  // reads everything else as of that render.
  const aimEchoStep = useEffectEvent(() => {
    if (echoFillStep.current !== ladderStep) {
      echoFillStep.current = ladderStep;
      cancelAnimation(echoFill);
      echoFill.value = 0;
      lineTrack.current = newTrack();
      takeTrack.current = newTrack();
    }
    // Handed over after the reset, in the same pass: the new segment reads 0, never the old value.
    if (echoFillSeg.value !== ladderSeg) echoFillSeg.value = ladderSeg;
    if (ladderPaused) {
      // Pause silences the line: the bar rests empty until Resume replays the pass.
      cancelAnimation(echoFill);
      echoFill.value = 0;
      lineTrack.current = newTrack();
      takeTrack.current = newTrack();
      return;
    }

    const kind = fillKindOf(ladderStep);
    if (kind === 'line') {
      aimEchoLine(latestStatus.current);
      return;
    }

    if (kind === 'record') {
      // Still opening the mic, or the previous take's cleanup finishing:
      // hold empty until this attempt is actually recording.
      if (takePhase !== 'recording') {
        echoFillRecAimed.current = false;
        return;
      }
      if (echoFillRecAimed.current) return;
      echoFillRecAimed.current = true;
      cancelAnimation(echoFill);
      echoFill.value = 0;
      // The ladder take's room past the line, plus the lag the tail adds.
      const expected = (lineSecLive > 0 ? takeRoomSec(lineSecLive) * 1000 : WATCHDOG_FALLBACK_MS + TAIL_MS) + takeLagMs;
      echoFill.value = withTiming(1, { duration: expected, easing: Easing.linear });
      return;
    }

    // play: takeStatusHandler aims the fill from the take player's own
    // status updates, so nothing to do here.
    // idle, armed, done: nothing to animate. Armed holds at the 0 the step
    // change above just set (Speak has not started yet); done and idle show
    // through the sheet's static full/empty rule instead of this value.
  });
  useEffect(() => {
    aimEchoStep();
  }, [ladderStep, ladderSeg, ladderPaused, lineSecLive, breathSec, takePhase, takeLagMs]);

  return { echoFill, echoFillSeg, aimEchoLine };
}
