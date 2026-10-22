import { Blur, Group, LinearGradient, Path, type SkPath, Skia } from '@shopify/react-native-skia';
import { useEffect } from 'react';
import {
  Easing,
  type SharedValue,
  cancelAnimation,
  useDerivedValue,
  useSharedValue,
  withDelay,
  withRepeat,
  withSpring,
  withTiming,
} from 'react-native-reanimated';

import { verb } from '@/constants/theme';

/**
 * The guide's pointer, Sean's pick r3-v05 (the prism arrow): a triangle 47 pt wide and 30 pt tall,
 * white to #7CC8FF top to bottom, a cyan rim on the left and a rose rim on the right, a white top edge,
 * and a #7CC8FF glow at 0.35. It enters once, dropping 40 pt with a spring (damping 14), then bobs
 * 14 pt away from its target over 900 ms, ease-in-out quad, back and forth, dimming to 0.6 at the top
 * of each bob. Drawn on the hint canvas; the tip follows `tip` (window coordinates, a shared value).
 */

// The mock draws a 44x40 viewBox stretched to 52x40 with the tip at (26, 38): x scales by 52/44.
const SX = 52 / 44;
const px = (x: number) => (x - 22) * SX;
const py = (y: number) => y - 38;
/** The body's height above the tip. */
export const POINTER_H = 30;
/** How far the bob carries the pointer away from its target. */
export const POINTER_BOB = 14;
const DROP = 40;
const BOB_MS = 900;
/** The bob starts once the entrance spring has settled. */
const ENTRANCE_MS = 650;

function line(ax: number, ay: number, bx: number, by: number) {
  const p = Skia.Path.Make();
  p.moveTo(px(ax), py(ay));
  p.lineTo(px(bx), py(by));
  return p;
}

type Shapes = { body: SkPath; rimLeft: SkPath; rimRight: SkPath; topEdge: SkPath };
let shapes: Shapes | null = null;
/** Built on the first render, not at import: on the web Skia loads after the modules. */
function getShapes(): Shapes {
  if (shapes) return shapes;
  const body = Skia.Path.Make();
  body.moveTo(px(6), py(8));
  body.lineTo(px(38), py(8));
  body.quadTo(px(42), py(8), px(40), py(12));
  body.lineTo(px(25), py(34));
  body.quadTo(px(22), py(38), px(19), py(34));
  body.lineTo(px(4), py(12));
  body.quadTo(px(2), py(8), px(6), py(8));
  body.close();
  shapes = { body, rimLeft: line(5, 11, 19.5, 33.5), rimRight: line(39, 11, 24.5, 33.5), topEdge: line(6, 8, 38, 8) };
  return shapes;
}

function num(v: number): number {
  'worklet';
  return Number.isFinite(v) ? v : 0;
}

function unit(v: number): number {
  'worklet';
  return Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : 0;
}

export type GuidePointerProps = {
  /** The tip, in the canvas's coordinates. */
  tip: SharedValue<{ x: number; y: number }>;
  /** True points at a target below the pointer; false flips it to point up. */
  down: boolean;
  /** Hebrew mirrors the rims: rose on the left, cyan on the right. */
  rtl: boolean;
  reduced: boolean;
  /** The loops run while true; the entrance replays when `playKey` changes. */
  active: boolean;
  playKey: string;
};

export function GuidePointer({ tip, down, rtl, reduced, active, playKey }: GuidePointerProps) {
  const drop = useSharedValue(0);
  const appear = useSharedValue(1);
  const bob = useSharedValue(0);
  useEffect(() => {
    if (!active) return;
    if (reduced) {
      drop.value = 0;
      appear.value = 1;
      bob.value = 0;
      return;
    }
    drop.value = -DROP;
    appear.value = 0;
    bob.value = 0;
    drop.value = withSpring(0, { damping: 14, stiffness: 100, mass: 1 });
    appear.value = withTiming(1, { duration: 320, easing: Easing.out(Easing.quad) });
    bob.value = withDelay(ENTRANCE_MS, withRepeat(withTiming(1, { duration: BOB_MS, easing: Easing.inOut(Easing.quad) }), -1, true));
    return () => {
      cancelAnimation(drop);
      cancelAnimation(appear);
      cancelAnimation(bob);
    };
  }, [active, playKey, reduced, drop, appear, bob]);

  const dir = down ? 1 : -1;
  const sx = rtl ? -1 : 1;
  const xf = useDerivedValue(() => [
    { translateX: num(tip.value.x) },
    { translateY: num(tip.value.y) + dir * (num(drop.value) - POINTER_BOB * unit(bob.value)) },
    { scaleX: sx },
    { scaleY: dir },
  ]);
  const op = useDerivedValue(() => unit(appear.value) * (1 - 0.4 * unit(bob.value)));
  const { body, rimLeft, rimRight, topEdge } = getShapes();

  return (
    <Group transform={xf} opacity={op}>
      <Path path={body} color="rgba(124,200,255,0.35)">
        <Blur blur={4.5} />
      </Path>
      <Path path={body}>
        <LinearGradient start={{ x: 0, y: -POINTER_H }} end={{ x: 0, y: 0 }} colors={['rgba(255,255,255,0.95)', 'rgba(124,200,255,0.85)']} />
      </Path>
      <Path path={rimLeft} style="stroke" strokeWidth={2} strokeCap="round" color={verb.listen.c1} />
      <Path path={rimRight} style="stroke" strokeWidth={2} strokeCap="round" color={verb.speak.c1} />
      <Path path={topEdge} style="stroke" strokeWidth={2} strokeCap="round" color="rgba(255,255,255,0.9)" />
    </Group>
  );
}
