import { useMemo, type RefObject } from 'react';
import { Gesture, type PanGesture, type ScrollView } from 'react-native-gesture-handler';
import { Easing, type SharedValue, useReducedMotion, useSharedValue, withTiming } from 'react-native-reanimated';

/** How long the reveal window takes to bloom in under a fresh touch. */
const IN_MS = 120;
/** How long it takes to frost back over on release. */
const OUT_MS = 220;

/** The finger's last known position and whether the drag is live, all on the
 * UI thread so `SlideReveal`'s per-chunk focus never needs a JS round trip. */
export type RevealFinger = {
  x: SharedValue<number>;
  y: SharedValue<number>;
  /** 0 to 1: eased in on touch-down, eased back out on release. */
  active: SharedValue<number>;
};

/**
 * The drag that reveals a frosted sentence one word at a time. `enabled`
 * gates the gesture itself (Blind off, or English shown, means the reveal
 * never claims the touch); `scrollRef`, when given, holds the outer scroll
 * off until the pan is the one that wins, the same way the player's swipe
 * does.
 */
export function useSlideReveal(
  enabled: boolean,
  scrollRef?: RefObject<ScrollView | null>,
): { gesture: PanGesture; finger: RevealFinger } {
  const x = useSharedValue(0);
  const y = useSharedValue(0);
  const active = useSharedValue(0);
  const reducedMotion = useReducedMotion();

  const gesture = useMemo(() => {
    let pan = Gesture.Pan().enabled(enabled).minDistance(2).maxPointers(1);
    if (scrollRef) pan = pan.blocksExternalGesture(scrollRef);
    return pan
      .onBegin((e) => {
        'worklet';
        if (Number.isFinite(e.x)) x.set(e.x);
        if (Number.isFinite(e.y)) y.set(e.y);
        active.set(reducedMotion ? 1 : withTiming(1, { duration: IN_MS, easing: Easing.out(Easing.quad) }));
      })
      .onUpdate((e) => {
        'worklet';
        if (Number.isFinite(e.x)) x.set(e.x);
        if (Number.isFinite(e.y)) y.set(e.y);
      })
      .onFinalize(() => {
        'worklet';
        active.set(reducedMotion ? 0 : withTiming(0, { duration: OUT_MS, easing: Easing.inOut(Easing.quad) }));
      });
  }, [enabled, reducedMotion, scrollRef, x, y, active]);

  return useMemo(() => ({ gesture, finger: { x, y, active } }), [gesture, x, y, active]);
}
