import { useEffect, useRef, useState } from 'react';
import { Easing, cancelAnimation, useSharedValue, withTiming } from 'react-native-reanimated';

/**
 * Repeat count and pause state for the video player: the replays left, the
 * pass shown, the pause timers, the countdown seconds and the ring progress.
 * The route decides what a line end means and calls `startPause` to hold.
 */
export function useRepeatPause(times: number) {
  const loopLeft = useRef(0);
  const loopTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const secsTimer = useRef<ReturnType<typeof setInterval> | null>(null);
  const [repeatPass, setRepeatPass] = useState(1);
  const [secsLeft, setSecsLeft] = useState<number | null>(null);
  const ringProgress = useSharedValue(0);

  // Ring to rest and seconds cleared: a pause ended or was aborted.
  const endPauseUi = () => {
    if (secsTimer.current) {
      clearInterval(secsTimer.current);
      secsTimer.current = null;
    }
    cancelAnimation(ringProgress);
    ringProgress.value = 0;
    setSecsLeft(null);
  };
  const clearLoopTimer = () => {
    if (loopTimer.current) {
      clearTimeout(loopTimer.current);
      loopTimer.current = null;
    }
    endPauseUi();
  };
  /** Runs the ring and the seconds countdown, then calls onDone after pauseMs. */
  const startPause = (pauseMs: number, onDone: () => void) => {
    let secs = Math.ceil(pauseMs / 1000);
    setSecsLeft(secs);
    ringProgress.value = 1;
    ringProgress.value = withTiming(0, { duration: pauseMs, easing: Easing.linear });
    secsTimer.current = setInterval(() => {
      secs = Math.max(1, secs - 1);
      setSecsLeft(secs);
    }, 1000);
    loopTimer.current = setTimeout(() => {
      loopTimer.current = null;
      endPauseUi();
      onDone();
    }, pauseMs);
  };

  /** A new line or a new count refills the replays and ends any pause. */
  const refill = () => {
    loopLeft.current = Math.max(0, times - 1);
    setRepeatPass(1);
    endPauseUi();
  };
  useEffect(
    () => () => {
      if (loopTimer.current) clearTimeout(loopTimer.current);
      if (secsTimer.current) clearInterval(secsTimer.current);
    },
    [],
  );

  return { loopLeft, repeatPass, setRepeatPass, secsLeft, ringProgress, refill, clearLoopTimer, startPause };
}
