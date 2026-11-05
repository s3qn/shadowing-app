// The sentence's count-in (focus-controls mock, Round 2 D3): the ink's lift over the grey
// copy, the band's sweep and the sentence's width it runs over, and the grey copy's mount.
// Split out of ladder-stage.tsx as a pure move, no behaviour change.
import { useEffect, useRef, useState } from 'react';
import { cancelAnimation, Easing, useAnimatedStyle, useReducedMotion, useSharedValue, withTiming } from 'react-native-reanimated';

import { BLUR_MS, OUT, SWEEP_EASING, SWEEP_K } from '@/components/tide/ladder/stage-tokens';

const LIFT_MS = 250;
/** The count-in's dim: the sentence eases from its ink down to the grey as the hint says "get ready". */
const SETTLE_MS = 300;

/**
 * The count-in's motion while `counting`; `countRun` restarts it for a new count-in that
 * follows straight on, and a `hidden` sentence blurs at the end instead of lifting.
 */
/**
 * `final` is the Final take's count-in (V4 "Grain", Sean 2026-11-05): no grey dim and no band, the
 * blur (use-sentence-blur) is the count, so the ink stays lifted and the sweep stays off the left
 * edge; `countMs` is the whole count's length, timed by the blur hook.
 */
export type CountInOptions = { counting: boolean; countRun: number; hidden: boolean; sweepMs: number; final?: boolean; countMs?: number };

export function useCountIn({ counting, countRun, hidden, sweepMs, final = false }: CountInOptions) {
  const reduced = useReducedMotion();
  // The count-in: `lift` is the ink over the grey copy (0 through the count, 1 after the 250ms lift),
  // `sweep` the band's run from off the left edge to off the right, `bandW` the sentence's width.
  const lift = useSharedValue(counting && !final ? 0 : 1);
  const sweep = useSharedValue(0);
  const bandW = useSharedValue(0);
  // The grey copy stays mounted from the count's start to the lift's end; never for the Final take.
  const [grey, setGrey] = useState(counting && !final);
  if (counting && !final && !grey) setGrey(true);
  // Read when a count starts, so a pace change mid-count never restarts the sweep.
  const sweepRef = useRef({ ms: sweepMs, reduced, final });
  useEffect(() => {
    sweepRef.current = { ms: sweepMs, reduced, final };
  }, [sweepMs, reduced, final]);
  // Read when a count ends, so a peek mid-lift never restarts the lift.
  const hiddenRef = useRef(hidden);
  useEffect(() => {
    hiddenRef.current = hidden;
  }, [hidden]);
  useEffect(() => {
    if (counting) {
      const s = sweepRef.current;
      cancelAnimation(lift);
      cancelAnimation(sweep);
      sweep.value = 0;
      if (s.final) {
        // The Final take: the ink stays up (the blur is the count) and the band never leaves the left edge.
        lift.value = withTiming(1, { duration: SETTLE_MS, easing: OUT });
        return;
      }
      // Eased from wherever the ink is, never snapped: the band starts off the left edge meanwhile.
      lift.value = withTiming(0, { duration: SETTLE_MS, easing: OUT });
      if (!s.reduced && s.ms > 0) sweep.value = withTiming(1, { duration: Math.round(s.ms * SWEEP_K), easing: SWEEP_EASING });
      return;
    }
    if (lift.value >= 1) return;
    // A hidden sentence blurs instead of lifting: its ink fades in as a soft shadow over the blur.
    const ms = hiddenRef.current ? (sweepRef.current.reduced ? 0 : BLUR_MS) : LIFT_MS;
    lift.value = withTiming(1, { duration: ms, easing: OUT });
    const id = setTimeout(() => setGrey(false), ms);
    return () => clearTimeout(id);
  }, [counting, countRun, lift, sweep]);
  const greyOn = (counting && !final) || grey;
  const textStyle = useAnimatedStyle(() => ({ opacity: Number.isFinite(lift.value) ? lift.value : 1 }));
  return { sweep, bandW, greyOn, textStyle };
}

/**
 * The wait cue's clock (V2 Hairline): `countP` runs linear 0 to 1 over the count, `cueOn` eases up
 * over 150ms at the start and down over 180ms when counting ends. A new `countRun` restarts `countP`
 * from 0 and `cueOn` eases from wherever it is. Under reduced motion `countP` jumps to 1 (a full
 * static line while waiting) and the line is gone at go.
 */
export function useCountClock({ counting, countRun, countMs }: { counting: boolean; countRun: number; countMs: number }) {
  const reduced = useReducedMotion();
  const countP = useSharedValue(0);
  const cueOn = useSharedValue(0);
  // Read when a count starts, so a pace change mid-count never restarts the clock.
  const ref = useRef({ ms: countMs, reduced });
  useEffect(() => {
    ref.current = { ms: countMs, reduced };
  }, [countMs, reduced]);
  useEffect(() => {
    if (counting) {
      const { ms, reduced: r } = ref.current;
      cancelAnimation(countP);
      countP.value = r ? 1 : 0;
      if (!r) countP.value = withTiming(1, { duration: ms, easing: Easing.linear });
      cueOn.value = withTiming(1, { duration: 150, easing: OUT });
      return;
    }
    cueOn.value = withTiming(0, { duration: 180, easing: OUT });
  }, [counting, countRun, countP, cueOn]);
  return { countP, cueOn };
}
