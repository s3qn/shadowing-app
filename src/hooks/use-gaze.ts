import { useCallback, useEffect, useRef, useSyncExternalStore } from 'react';
import { useWindowDimensions, type GestureResponderEvent } from 'react-native';
import { useReducedMotion } from 'react-native-reanimated';

export type CatRect = { x: number; y: number; width: number; height: number };

const FRAME_MS = 16;
const STEP = 0.02;
/** How long the cat keeps looking at the last touch point after the finger lifts. */
const GAZE_DWELL_MS = 4500;

type Look = { x: number; y: number };
const REST: Look = { x: 0, y: 0 };

// Live gaze lives outside React so a touch-move never re-renders the screen.
// Only a cat that opts in through useGazeValue re-renders.
let current: Look = REST;
const listeners = new Set<() => void>();

function setLook(x: number, y: number) {
  if (x === current.x && y === current.y) return;
  current = x === 0 && y === 0 ? REST : { x, y };
  listeners.forEach((l) => l());
}

const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => {
    listeners.delete(l);
  };
};
const noopSubscribe = () => () => {};

/** Subscribes the calling cat to the live gaze. With `enabled` false it stays at rest and never re-renders. */
export function useGazeValue(enabled: boolean): Look {
  return useSyncExternalStore(
    enabled ? subscribe : noopSubscribe,
    () => (enabled ? current : REST),
    () => REST,
  );
}

const clamp = (v: number) => Math.max(-1, Math.min(1, v));

/**
 * Maps the touch point to where the cat should look, in -1..1 around the cat's
 * centre. The handlers go on a root View as onTouchStart/Move/End/Cancel, which
 * fire without taking the gesture responder, so taps and scrolls underneath
 * are untouched. Writes are gated to one per frame. At rest the gaze is 0,0. On
 * release the last look is held for GAZE_DWELL_MS, then set to 0,0 and the Rive
 * runtime does the easing. A new touch cancels the pending return.
 */
export function useGaze() {
  const reduced = useReducedMotion();
  const { width, height } = useWindowDimensions();
  const rect = useRef<CatRect | null>(null);
  const last = useRef(0);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pending = useRef<{ x: number; y: number } | null>(null);
  const dwell = useRef<ReturnType<typeof setTimeout> | null>(null);

  const clearDwell = useCallback(() => {
    if (dwell.current) {
      clearTimeout(dwell.current);
      dwell.current = null;
    }
  }, []);

  const commit = useCallback((x: number, y: number) => {
    last.current = Date.now();
    const p = current;
    if (x === 0 && y === 0) setLook(0, 0);
    else if (Math.abs(p.x - x) >= STEP || Math.abs(p.y - y) >= STEP) setLook(x, y);
  }, []);

  const flush = useCallback(() => {
    timer.current = null;
    const p = pending.current;
    pending.current = null;
    if (p) commit(p.x, p.y);
  }, [commit]);

  const push = useCallback(
    (x: number, y: number) => {
      pending.current = { x, y };
      if (timer.current) return;
      const wait = Math.max(0, FRAME_MS - (Date.now() - last.current));
      timer.current = setTimeout(flush, wait);
    },
    [flush],
  );

  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
      clearDwell();
      setLook(0, 0);
    },
    [clearDwell],
  );

  const onTouch = useCallback(
    (e: GestureResponderEvent) => {
      clearDwell();
      const r = rect.current;
      if (reduced || !r) return;
      const { pageX, pageY } = e.nativeEvent;
      // Mapping radius is a bit wider than the cat so edge touches stay below the clamp.
      const hw = Math.max(width * 0.5, r.width);
      const hh = Math.max(height * 0.5, r.height);
      push(clamp((pageX - (r.x + r.width / 2)) / hw), clamp((pageY - (r.y + r.height / 2)) / hh));
    },
    [reduced, width, height, push, clearDwell],
  );

  const onRelease = useCallback(() => {
    if (timer.current) {
      clearTimeout(timer.current);
      timer.current = null;
    }
    // Land the last unflushed point, then hold it for the dwell before easing home.
    const p = pending.current;
    pending.current = null;
    if (p) commit(p.x, p.y);
    clearDwell();
    if (reduced || (current.x === 0 && current.y === 0)) return;
    dwell.current = setTimeout(() => {
      dwell.current = null;
      commit(0, 0);
    }, GAZE_DWELL_MS);
  }, [commit, clearDwell, reduced]);

  const setCatRect = useCallback((r: CatRect) => {
    rect.current = r;
  }, []);

  return {
    setCatRect,
    handlers: { onTouchStart: onTouch, onTouchMove: onTouch, onTouchEnd: onRelease, onTouchCancel: onRelease },
  };
}
