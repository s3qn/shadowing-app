// The ladder's stage fill on the island: the `echoFill` SharedValue, the listening passes' aim
// from the line player's status, the Play step's aim from the take player, and the step effect
// that resets and re-aims it. Owner: I2a. Every timing on the value lives here, with the value.
import type { AudioStatus } from 'expo-audio';
import { useEffect, useEffectEvent, useLayoutEffect, useRef, type MutableRefObject, type RefObject } from 'react';
import { cancelAnimation, Easing, useSharedValue, withTiming } from 'react-native-reanimated';

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
  ladderPaused: boolean;
  takePhase: ReturnType<typeof useTake>['phase'];
  lineSecLive: number;
  breathSec: number;
  takeLagMs: number;
};

export function useEchoFill(p: EchoFillParams) {
  const { echoRef, rateRef, latestStatus, takeStatusHandler, ladderStep, ladderPaused, takePhase, lineSecLive, breathSec, takeLagMs } = p;
  // The ladder's active stage fill, 0..1, animated on the UI thread the same
  // way: one shared value, aimed with withTiming over the step's real
  // duration, re-aimed only on drift. Which segment reads it is decided by
  // the step (see the effect below).
  const echoFill = useSharedValue(0);
  // The Play step's fill: aimed from the take player's status updates rather
  // than a render per tick. Aims once from 0, then re-aims only if the fill
  // has drifted from the real position by more than 0.08.
  const aimTakeFill = (s: AudioStatus) => {
    if (fillKindOf(echoRef.current) !== 'take' || !s.isLoaded) return;
    if (!Number.isFinite(s.duration) || !Number.isFinite(s.currentTime) || s.duration <= 0) return;
    const target = Math.min(1, Math.max(0, s.currentTime / s.duration));
    if (echoFill.value === 0 || Math.abs(echoFill.value - target) > 0.08) {
      cancelAnimation(echoFill);
      echoFill.value = target;
      const remaining = Math.max(0, (s.duration - s.currentTime) * 1000);
      echoFill.value = withTiming(1, { duration: remaining, easing: Easing.linear });
    }
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
  // fill alone: the effect resets it to 0 first, then aims it.
  // `force` re-aims at once: a mid-play speed pick changes how fast the rest runs.
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
    if (!s.playing || !Number.isFinite(span) || span <= 0) return;
    const target = Math.min(1, s.currentTime / span);
    if (force || echoFill.value === 0 || Math.abs(echoFill.value - target) > 0.08) {
      cancelAnimation(echoFill);
      echoFill.value = target;
      // File seconds over the live rate: the wall-clock time the rest takes.
      const rate = rateRef.current > 0 && Number.isFinite(rateRef.current) ? rateRef.current : 1;
      const remaining = Math.max(0, ((span - s.currentTime) * 1000) / rate);
      echoFill.value = withTiming(1, { duration: remaining, easing: Easing.linear });
    }
  }
  // An effect event, so the effect below runs for the deps it lists and
  // reads everything else as of that render.
  const aimEchoStep = useEffectEvent(() => {
    if (echoFillStep.current !== ladderStep) {
      echoFillStep.current = ladderStep;
      cancelAnimation(echoFill);
      echoFill.value = 0;
    }
    if (ladderPaused) {
      // Pause silences the line: the bar rests empty until Resume replays the pass.
      cancelAnimation(echoFill);
      echoFill.value = 0;
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
  }, [ladderStep, ladderPaused, lineSecLive, breathSec, takePhase, takeLagMs]);

  return { echoFill, aimEchoLine };
}
