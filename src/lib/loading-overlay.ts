import { makeMutable } from 'react-native-reanimated';

/** Wakes the pre-mounted root `LoadingOverlay`: 1 to show (after its own
 * grace delay), 0 to hide. A UI-thread mutable, not a shared value from a
 * hook, so the morph's cover-complete worklet can set it without a round
 * trip through JS while the JS thread may still be jammed. */
export const loaderRequest = makeMutable(0);

/** 1 once the open morph's player has reported ready (or has gone): the
 * morph's cover-complete worklet then leaves the loader off, since nothing
 * is left to wait for under the cover. `startOpen` resets it to 0. */
export const loaderCoverSkip = makeMutable(0);

/** How long a wait must last before the loader appears. The overlay applies
 * it to every request, so no caller adds a delay of its own. */
export const LOADER_GRACE_MS = 120;
/** Fade in and fade out durations for the loader layer. */
export const LOADER_IN_MS = 240;
export const LOADER_OUT_MS = 160;
/** The clock's full loop length: a common multiple of the cat's 4500 ms
 * outline loop and the dots' 1200 ms loop, so `withRepeat` never has to
 * restart mid-loop. */
export const CLOCK_MS = 18000;

/** The JS-side entry point: the player calls this for the cache-miss network
 * wait and to hand the loader off once it has landed. */
export function requestLoader(on: boolean): void {
  loaderRequest.value = on ? 1 : 0;
}
