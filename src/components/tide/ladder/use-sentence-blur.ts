// The Final take's blur of the sentence (mock Round 3 B2): the blur SharedValue with its
// timing, and the grey copy's fade (each Text draws its own blur, see BlurText in ruby-word.tsx).
// Split out of ladder-stage.tsx as a pure move, no behaviour change.
import { useEffect, useRef } from 'react';
import { cancelAnimation, Easing, useAnimatedStyle, useReducedMotion, useSharedValue, withTiming } from 'react-native-reanimated';

import { BLUR_MS, OUT } from '@/components/tide/ladder/stage-tokens';

/** The blur's way out, for a peek and Compare, and back in as a peek ends (in at the count's end is BLUR_MS). */
const UNBLUR_MS = 450;
const REBLUR_MS = 300;

/**
 * The Final take's grain blur (V4 "Grain", research/pre-animator/final-take-blur/recipe.md):
 * `final` means this count-in is the blur itself, over `countMs`, the take starting once fully
 * soft. The returned `grain` goes to each RubyWord.
 */
export type SentenceBlurOptions = { final: boolean; countMs: number };

/** The grain's timings (the board's V4 card, scratchpad/blur-board/index.html): a peek, a peek's end, and Compare. */
const GRAIN_PEEK_MS = 320;
const GRAIN_REBLUR_MS = 380;
/** Reduced motion: the whole sentence at once, 150ms linear, for every change but the count. */
const REDUCED_MS = 150;
/** Each word's grain: the line's seed (`mulberry32(7)`) and each character's share of the blur (`blurSpan`). One object, so RubyWord's memo holds. */
const GRAIN = { seed: 7, span: 0.38 };

/** The blur, 0 sharp to 1 a soft shape, for a `hidden` sentence once it is not `counting`. */
export function useSentenceBlur(hidden: boolean, counting: boolean, opts?: SentenceBlurOptions) {
  const reduced = useReducedMotion();
  const final = !!opts?.final;
  // The Final take's blur (mock Round 3 B2), 0 sharp to 1 a soft shape: sharp through the count-in,
  // blurred from its end (700ms), sharp again for a peek and Compare (450ms), re-blurred as a peek ends (300ms).
  const blur = useSharedValue(hidden && !counting ? 1 : 0);
  const wasCounting = useRef(counting);
  // Read when a count starts, so a pace change mid-count never restarts the blur.
  const optsRef = useRef({ final, countMs: opts?.countMs ?? 0, reduced });
  useEffect(() => {
    optsRef.current = { final, countMs: opts?.countMs ?? 0, reduced };
  }, [final, opts?.countMs, reduced]);
  // The Final take (Sean, 2026-11-05): the blur IS the count-in. It runs 0 to 1 over the whole count,
  // linear (each character's own curve is in its worklet), so the take starts as the sentence goes
  // fully soft. A hold mid-count changes nothing, as on the board; once the count is over, a peek
  // clears it (320ms), a peek's end brings it back (380ms), Compare clears it for good.
  const inCount = useRef(false);
  useEffect(() => {
    const fromCount = wasCounting.current;
    wasCounting.current = counting;
    const o = optsRef.current;
    if (o.final) {
      if (counting) {
        if (inCount.current) return;
        inCount.current = true;
        cancelAnimation(blur);
        blur.value = withTiming(1, { duration: Math.max(1, o.countMs), easing: Easing.linear });
        return;
      }
      inCount.current = false;
      const to = hidden ? 1 : 0;
      cancelAnimation(blur);
      blur.value = withTiming(to, { duration: o.reduced ? REDUCED_MS : to === 0 ? GRAIN_PEEK_MS : GRAIN_REBLUR_MS, easing: Easing.linear });
      return;
    }
    inCount.current = false;
    const k = hidden && !counting ? 1 : 0;
    cancelAnimation(blur);
    if (o.reduced) blur.value = k;
    else blur.value = withTiming(k, { duration: k === 0 ? UNBLUR_MS : fromCount ? BLUR_MS : REBLUR_MS, easing: OUT });
  }, [hidden, counting, blur]);
  // The grey copy fades as it blurs, so its shadow never stays under the ink's.
  const greyStyle = useAnimatedStyle(() => ({ opacity: 1 - (Number.isFinite(blur.value) ? Math.min(1, Math.max(0, blur.value)) : 0) }));
  // Each word's grain, for the Final take with motion on; reduced motion blurs the whole sentence at once.
  const grain: { seed: number; span: number } | undefined = final && !reduced ? GRAIN : undefined;
  return { blur, greyStyle, grain };
}
