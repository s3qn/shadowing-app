// focus-stories D3/D4: the cube's pan gesture and its finger-driven x. Owner: Bob
// G1 (this file, cube-stage.tsx and stage-preview.tsx only).
//
// `pan` is a `Gesture.Pan()` with activeOffsetX +-20 and failOffsetY +-16 (the old
// step swipe's values), UI-thread updates writing `cubeX`, clamped to [-width,
// width]; the composer hands it to `useBodyGesture({ cube })`, which races it
// against the hold and the tap. A drag to the left turns to the next island
// (`onHop(1)`), to the right to the previous (`onHop(-1)`), the same in Hebrew.
// Commit when `|dx| >= 0.3 * width` or a fling (`|vx| >= 600` in the drag's own
// direction): `withTiming(+-width, 280ms, OUT)` then `scheduleOnRN(onHop, dir)`;
// release short of that: `withTiming(0, 220ms, OUT)`, no overshoot. No neighbour
// on that side: a plain resistance, `cubeX = 16 * (1 - e^(-|dx| / 120))` with the
// drag's sign, and on release `withSpring(0, { damping: 20, stiffness: 300 })`, no
// haptic; CubeStage moves only the content for it, no turn. `noMotion`: the same
// commit, 180ms, which CubeStage draws as a crossfade. The sides are latched in
// `sides` when the drag starts, so neighbours landing mid-drag never flip it from a
// resistance to a turn, and the gesture is not rebuilt when they change. Nothing
// runs on JS during the drag: the callbacks read only shared values and primitives.
import { useCallback, useEffect, useMemo, useRef } from 'react';
import { Gesture, type PanGesture } from 'react-native-gesture-handler';
import { cancelAnimation, useSharedValue, withSpring, withTiming, type SharedValue } from 'react-native-reanimated';
import { scheduleOnRN } from 'react-native-worklets';

import { noop, OUT } from '@/components/tide/ladder/stage-tokens';
import type { LadderNeighbours } from '@/hooks/ladder/ladder-types';

export type CubePanOptions = {
  width: number;
  neighbours?: LadderNeighbours;
  onHop?: (dir: -1 | 1) => void;
  noMotion: boolean;
};

/** The share of the width a drag must pass to commit the turn. */
export const COMMIT_SHARE = 0.3;
/** The horizontal speed (pt/s) that commits a shorter drag. */
export const FLING_V = 600;
/** How far (pt) the content shifts at most with no neighbour on that side. */
export const BAND_MAX = 16;
/** The resistance's drag scale (pt): at this drag the content has moved 63% of BAND_MAX. */
const BAND_K = 120;
const TURN_MS = 280;
const FADE_MS = 180;
const CANCEL_MS = 220;
/** Bits of `sides`: a neighbour before, a neighbour after. */
export const SIDE_PREV = 1;
export const SIDE_NEXT = 2;

/** The content's shift for a drag `dx` with no neighbour that way: heavy friction up to BAND_MAX. */
function band(dx: number): number {
  'worklet';
  if (!Number.isFinite(dx)) return 0;
  return Math.sign(dx) * BAND_MAX * (1 - Math.exp(-Math.abs(dx) / BAND_K));
}

export function useCubePan({ width, neighbours, onHop, noMotion }: CubePanOptions): { cubeX: SharedValue<number>; sides: SharedValue<number>; pan: PanGesture | null } {
  const cubeX = useSharedValue(0);
  // The neighbours as bits, for the UI thread: `live` follows the props, `sides` is the drag's copy.
  const bits = (neighbours?.prev ? SIDE_PREV : 0) | (neighbours?.next ? SIDE_NEXT : 0);
  const live = useSharedValue(bits);
  const sides = useSharedValue(bits);
  useEffect(() => {
    live.set(bits);
  }, [bits, live]);
  // No `onHop`: the cube still turns with the finger, but a release always snaps back,
  // so the page is never left turned away with nothing to tap.
  const canHop = !!onHop;
  // One function for the gesture's life: a new `onHop` (new neighbours) never rebuilds the pan mid-drag.
  const hopRef = useRef(onHop ?? noop);
  hopRef.current = onHop ?? noop;
  const hop = useCallback((dir: -1 | 1) => hopRef.current(dir), []);
  // The hop replaces the route, so the next stage mounts at 0; should this instance be
  // reused with the hopped island's neighbours instead, the turned page comes back.
  const hopped = useSharedValue(false);
  const prevId = neighbours?.prevId;
  const nextId = neighbours?.nextId;
  useEffect(() => {
    if (!hopped.get()) return;
    hopped.set(false);
    cubeX.set(0);
  }, [prevId, nextId, cubeX, hopped]);
  const pan = useMemo(() => {
    const commitMs = noMotion ? FADE_MS : TURN_MS;
    return Gesture.Pan()
      .activeOffsetX([-20, 20])
      .failOffsetY([-16, 16])
      .onStart(() => {
        // Committed: the route is being replaced, so a second drag must not hop again.
        if (hopped.get()) return;
        cancelAnimation(cubeX);
        sides.set(live.get());
      })
      .onUpdate((e) => {
        if (hopped.get()) return;
        const dx = Number.isFinite(e.translationX) ? e.translationX : 0;
        const has = (sides.get() & (dx < 0 ? SIDE_NEXT : SIDE_PREV)) !== 0;
        if (has) cubeX.set(Math.max(-width, Math.min(width, dx)));
        else cubeX.set(band(dx));
      })
      .onEnd((e, success) => {
        if (hopped.get()) return;
        const dx = Number.isFinite(e.translationX) ? e.translationX : 0;
        const has = (sides.get() & (dx < 0 ? SIDE_NEXT : SIDE_PREV)) !== 0;
        if (!has) {
          cubeX.set(withSpring(0, { damping: 20, stiffness: 300 }));
          return;
        }
        const vx = e.velocityX;
        const fling = Math.abs(vx) >= FLING_V && vx < 0 === dx < 0;
        if (success && canHop && (Math.abs(dx) >= COMMIT_SHARE * width || fling)) {
          const dir: -1 | 1 = dx < 0 ? 1 : -1;
          cubeX.set(
            withTiming(dir === 1 ? -width : width, { duration: commitMs, easing: OUT }, (done) => {
              if (done) {
                hopped.set(true);
                scheduleOnRN(hop, dir);
              }
            }),
          );
        } else {
          cubeX.set(withTiming(0, { duration: CANCEL_MS, easing: OUT }));
        }
      });
  }, [cubeX, hopped, sides, live, width, canHop, hop, noMotion]);
  return { cubeX, sides, pan };
}
