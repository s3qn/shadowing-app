// The sentence's count-in (focus-controls mock, Round 2 D3): the ink's lift over the grey
// copy, the band's sweep and the sentence's width it runs over, and the grey copy's mount.
// Split out of ladder-stage.tsx as a pure move, no behaviour change.
import { useEffect, useRef, useState } from 'react';
import { cancelAnimation, Easing, ReduceMotion, useAnimatedStyle, useReducedMotion, useSharedValue, withSequence, withTiming } from 'react-native-reanimated';

import { BLUR_MS, OUT, SWEEP_EASING, SWEEP_K } from '@/components/tide/ladder/stage-tokens';
import { devCountSlow } from '@/lib/dev-simulate';
import { COUNT_DROPS } from '@/lib/pass-programme';

const LIFT_MS = 250;
/** The drops' clock rests here between counts: every drops worklet returns its idle state at or past it. */
export const REST = 1e5;
/** The drops enter over the 300ms before the first beat (the board's LEAD): nothing of the count shows before `tk = -300`. */
export const ENTRY_MS = 300;
/** A sentence still on screen when its line counts again sinks away over this long (BL-106). */
const SINK_MS = 300;
/** A count restarted mid-way runs back to its start over this long, then counts again (decision 6). */
const BACK_MS = 150;
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

export type CountClockOptions = {
  counting: boolean;
  countRun: number;
  countMs: number;
  /** A drops count (Listen, BL-106): `tk` runs and the hairline stays off. */
  drops: boolean;
  /** The announce the hook chose, in real ms (a dev slow factor already in it): the drops' lead. */
  leadMs: number;
  beatMs: number;
  paused: boolean;
  lineIndex: number;
};

/**
 * The wait cue's clock (V2 Hairline): `countP` runs linear 0 to 1 over the count, `cueOn` eases up
 * over 150ms at the start and down over 180ms when counting ends. A new `countRun` restarts `countP`
 * from 0 and `cueOn` eases from wherever it is. Under reduced motion `countP` jumps to 1 (a full
 * static line while waiting) and the line is gone at go.
 *
 * The drops' clock (BL-106, one SharedValue `tk` in recipe ms): a drops count starts it at
 * `-leadMs / s` and runs it linear to END (`3 beats + endMs`) at 1/s recipe ms per real ms, so the
 * beats land on the hook's timers and the line's start is the drop's impact; then it rests at REST.
 * A restart mid-count (Resume, the same line again, a jump to the running step) runs it back to
 * its start plus 150ms over 150ms, then on, so the beats still land. A count cancelled early
 * compresses the rest into 180ms, then the fall at real speed (never a cut); one nobody saw yet
 * hides its parts (`shown` 0) and runs the words' rise alone. `prev` is 1 while a sentence that was
 * on screen when its line counted again sinks away. Paused: `tk` freezes where it is.
 */
export function useCountClock({ counting, countRun, countMs, drops, leadMs, beatMs, paused, lineIndex }: CountClockOptions) {
  const reduced = useReducedMotion();
  const countP = useSharedValue(0);
  const cueOn = useSharedValue(0);
  const tk = useSharedValue(REST);
  const shown = useSharedValue(1);
  const prev = useSharedValue(0);
  // Read when a count starts, so a pace change mid-count never restarts the clock.
  const ref = useRef({ ms: countMs, reduced, beatMs });
  useEffect(() => {
    ref.current = { ms: countMs, reduced, beatMs };
  }, [countMs, reduced, beatMs]);
  // The running count's slow factor and line, for the skip curve and the sink.
  const run = useRef({ s: 1, line: -1 });
  // The same at render time: `sameLine` is true from the first render of a drops count on the line the last
  // one ran on, so its sentence (still on screen, the clock at rest) stays up until the sink takes over.
  const [seen, setSeen] = useState({ live: false, line: -1, same: false });
  if (drops !== seen.live || (drops && seen.line !== lineIndex)) setSeen({ live: drops, line: drops ? lineIndex : seen.line, same: drops && seen.line === lineIndex });
  useEffect(() => {
    const { ms, reduced: r, beatMs: b } = ref.current;
    if (counting && !drops) {
      cancelAnimation(countP);
      countP.value = r ? 1 : 0;
      if (!r) countP.value = withTiming(1, { duration: ms, easing: Easing.linear });
      cueOn.value = withTiming(1, { duration: 150, easing: OUT });
    } else cueOn.value = withTiming(0, { duration: 180, easing: OUT });
    if (paused) {
      cancelAnimation(tk);
      return;
    }
    const go = 3 * b;
    const impact = go + COUNT_DROPS.impactMs;
    const end = go + COUNT_DROPS.endMs;
    const v = Number.isFinite(tk.value) ? tk.value : REST;
    // `tk` is a clock, not a motion: Reanimated's default skips a timing under the OS reduced motion and would jump
    // it to END at once (an empty stage through the count). The worklets draw the reduced count themselves.
    const toEnd = (from: number, s: number) =>
      withTiming(end, { duration: Math.max(1, (end - from) * s), easing: Easing.linear, reduceMotion: ReduceMotion.Never }, (done) => {
        'worklet';
        if (done) tk.value = REST;
      });
    if (drops && counting) {
      const s = devCountSlow();
      const start = -leadMs / s;
      cancelAnimation(tk);
      shown.value = 1;
      if (!(v < go) || v <= -ENTRY_MS) {
        // A fresh start (at rest, past go so the line already plays, or nothing of the count on screen yet):
        // running back from past go would bring the drops and the old caption back for a frame or two.
        if (!(v < go) && run.current.line === lineIndex) {
          // The same line again from Listen: its sentence is still on screen and sinks away.
          prev.value = 1;
          prev.value = withTiming(0, { duration: r ? 150 : SINK_MS, easing: OUT, reduceMotion: ReduceMotion.Never });
        }
        tk.value = start;
        tk.value = toEnd(start, s);
      } else {
        const back = start + BACK_MS / s;
        tk.value = withSequence(withTiming(back, { duration: BACK_MS, easing: OUT, reduceMotion: ReduceMotion.Never }), toEnd(back, s));
      }
      run.current = { s, line: lineIndex };
      return;
    }
    // Cancelled before go (the line starts at the impact, a little after the clock's own, so a count that
    // ended on time or during the fall simply runs on).
    if (v < go) {
      const s = run.current.s;
      if (v <= -ENTRY_MS) {
        // Cancelled before anything entered: the words rise as at the impact, the count's parts stay hidden.
        shown.value = 0;
        tk.value = impact;
        tk.value = toEnd(impact, s);
      } else tk.value = withSequence(withTiming(go, { duration: 180, easing: OUT, reduceMotion: ReduceMotion.Never }), toEnd(go, s));
    }
  }, [counting, countRun, drops, paused, lineIndex, leadMs, countP, cueOn, tk, shown, prev]);
  return { countP, cueOn, tk, shown, prev, sameLine: seen.same };
}
