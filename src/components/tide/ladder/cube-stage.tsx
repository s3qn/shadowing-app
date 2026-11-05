// focus-stories D4: the cube that turns the stage to the next or previous island.
// Owner: Bob G1 (this file, stage-preview.tsx and use-cube-pan.ts only).
//
// `children` is the stage's `fill` tree (top row, bar, dots, label, body, chips),
// the current page. `cubeX` is the finger-driven x from `useCubePan`, clamped to
// [-width, width]. A page at offset `o` draws as `[{perspective: 1000}, {translateX:
// o}, {translateX: pivot}, {rotateY: (o / width) * 90 deg}, {translateX: -pivot}]`
// with `pivot = o < 0 ? width / 2 : -width / 2`, the edge it shares with the page
// beside it: the current page sits at `cubeX`, the next at `cubeX + width`, the
// previous at `cubeX - width`, so the two faces meet at one edge and both recede
// from it, a cube seen from outside. A black overlay on each page at opacity
// `0.5 * |angle| / 90` is the shading. `backfaceVisibility: 'hidden'`, container
// `overflow: 'hidden'`. The still `StagePreview` pages mount with the stage, only on
// sides with a neighbour, so their sentence has fitted long before a swipe, and stay
// mounted at +-width with `pointerEvents="none"`. `sides` is the pan's copy of the
// neighbours, latched when a drag starts. No neighbour on a side: a plain resistance,
// the content alone shifts by the pan's x over a still `sky`, no turn, no shading,
// no edge. `noMotion`: no rotation, the pages crossfade with the drag and the pan's
// 180ms commit. The worklets read only `cubeX`, `sides` and the primitives pulled
// out below (lint `repo/worklet-captures`), and animate transform and opacity only:
// no layout prop, no React render in a drag.
import { type ReactNode } from 'react';
import { StyleSheet, View } from 'react-native';
import Animated, { useAnimatedStyle, type SharedValue } from 'react-native-reanimated';

import { StagePreview } from '@/components/tide/ladder/stage-preview';
import { SIDE_NEXT, SIDE_PREV } from '@/components/tide/ladder/use-cube-pan';
import type { LadderNeighbours } from '@/hooks/ladder/ladder-types';

export type CubeStageProps = {
  cubeX: SharedValue<number>;
  sides: SharedValue<number>;
  width: number;
  neighbours?: LadderNeighbours;
  noMotion: boolean;
  /** The page's background: turns with the page, stays put under a resistance. */
  sky: ReactNode;
  children: ReactNode;
};

const PERSPECTIVE = 1000;
const SHADE = 0.5;

/** The style of the page at offset `o` (its left edge at `o` from the screen's). `shown` false hides it. */
function face(o: number, shown: boolean, w: number, noMotion: boolean) {
  'worklet';
  if (!shown) return { opacity: 0, transform: [{ translateX: 0 }] };
  if (noMotion) return { opacity: 1 - Math.min(1, Math.abs(o) / w), transform: [{ translateX: 0 }] };
  const pivot = o < 0 ? w / 2 : -w / 2;
  return {
    opacity: 1,
    transform: [{ perspective: PERSPECTIVE }, { translateX: o }, { translateX: pivot }, { rotateY: `${(o / w) * 90}deg` }, { translateX: -pivot }],
  };
}

/** The shading over the page at offset `o`: black at `0.5 * |angle| / 90`, none in the crossfade. */
function shade(o: number, shown: boolean, w: number, noMotion: boolean) {
  'worklet';
  return { opacity: shown && !noMotion ? Math.min(SHADE, (SHADE * Math.abs(o)) / w) : 0 };
}

export function CubeStage({ cubeX, sides, width, neighbours, noMotion, sky, children }: CubeStageProps) {
  const w = width > 0 ? width : 1;
  // Primitives for the render: the worklets read the latched `sides`, never `neighbours` itself.
  const hasPrev = !!neighbours?.prev;
  const hasNext = !!neighbours?.next;
  const prevId = neighbours?.prevId;
  const nextId = neighbours?.nextId;
  // The page turns only toward a neighbour; without one it stays put and its content shifts (`bandStyle`).
  const curStyle = useAnimatedStyle(() => {
    const x = Number.isFinite(cubeX.value) ? cubeX.value : 0;
    const has = (sides.value & (x < 0 ? SIDE_NEXT : SIDE_PREV)) !== 0;
    if (!has) return { opacity: 1, transform: [{ translateX: 0 }] };
    return face(x, true, w, noMotion);
  });
  const bandStyle = useAnimatedStyle(() => {
    const x = Number.isFinite(cubeX.value) ? cubeX.value : 0;
    const has = (sides.value & (x < 0 ? SIDE_NEXT : SIDE_PREV)) !== 0;
    return { transform: [{ translateX: has ? 0 : x }] };
  });
  const curShade = useAnimatedStyle(() => {
    const x = Number.isFinite(cubeX.value) ? cubeX.value : 0;
    const has = (sides.value & (x < 0 ? SIDE_NEXT : SIDE_PREV)) !== 0;
    return shade(x, has, w, noMotion);
  });
  const nextStyle = useAnimatedStyle(() => face(cubeX.value + w, cubeX.value < 0 && (sides.value & SIDE_NEXT) !== 0, w, noMotion));
  const nextShade = useAnimatedStyle(() => shade(cubeX.value + w, cubeX.value < 0 && (sides.value & SIDE_NEXT) !== 0, w, noMotion));
  const prevStyle = useAnimatedStyle(() => face(cubeX.value - w, cubeX.value > 0 && (sides.value & SIDE_PREV) !== 0, w, noMotion));
  const prevShade = useAnimatedStyle(() => shade(cubeX.value - w, cubeX.value > 0 && (sides.value & SIDE_PREV) !== 0, w, noMotion));
  return (
    <View style={styles.root}>
      {/* The still faces sit under the live page: in the crossfade the page fades out over them. */}
      {hasPrev ? (
        <Animated.View style={[styles.face, prevStyle]} pointerEvents="none" accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
          <StagePreview key={prevId} id={prevId} />
          <Animated.View style={[styles.shade, prevShade]} pointerEvents="none" />
        </Animated.View>
      ) : null}
      {hasNext ? (
        <Animated.View style={[styles.face, nextStyle]} pointerEvents="none" accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
          <StagePreview key={nextId} id={nextId} />
          <Animated.View style={[styles.shade, nextShade]} pointerEvents="none" />
        </Animated.View>
      ) : null}
      <Animated.View style={[styles.page, curStyle]}>
        {sky}
        <Animated.View style={[styles.fill, bandStyle]}>{children}</Animated.View>
        <Animated.View style={[styles.shade, curShade]} pointerEvents="none" />
      </Animated.View>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, overflow: 'hidden' },
  page: { flex: 1, backfaceVisibility: 'hidden' },
  fill: { flex: 1 },
  face: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, backfaceVisibility: 'hidden' },
  shade: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, backgroundColor: '#000' },
});
