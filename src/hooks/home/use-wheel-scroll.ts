import { useEffect, useLayoutEffect, useRef, type MutableRefObject, type RefObject } from 'react';
import type { FlatList } from 'react-native';
import {
  runOnJS,
  useAnimatedReaction,
  useAnimatedScrollHandler,
  useSharedValue,
  type SharedValue,
} from 'react-native-reanimated';

import { STEP } from '@/components/home/island-row';
import { DOCK_REACH } from '@/components/home/practice-dock';
import { PILL_TAB_BAR_REACH } from '@/components/pill-tab-bar';

// How much of the list's bottom the floating tab bar covers. The screen pads
// its bottom by the safe-area inset and the bar sits that inset plus its gap
// above the screen edge, so the inset cancels and only the bar's reach is left.
export const TAB_BAR_OVERLAP = PILL_TAB_BAR_REACH;

/** The part of a list this tall that the tab bar and the practice dock above
 * it leave visible. */
export function visibleOf(listH: number): number {
  return Math.max(1, listH - TAB_BAR_OVERLAP - DOCK_REACH);
}

/** What the list shows: the wheel or the plain search list, and the wheel's
 * height with search closed (0 until measured). */
export type Shape = { wheel: boolean; wheelH: number };

type Params = {
  shape: Shape;
  shownLength: number;
  query: string;
  searchRowH: SharedValue<number>;
  wanted: MutableRefObject<Shape>;
  pendingPlace: MutableRefObject<number | null>;
  centreRef: MutableRefObject<number>;
  moving: MutableRefObject<boolean>;
  searchOpenRef: MutableRefObject<boolean>;
  listRef: RefObject<FlatList<any> | null>;
  requestShape: (next: Shape) => void;
  cancelSettle: () => void;
  updateCentre: (idx: number) => void;
  scheduleSettle: () => void;
};

/** The wheel's scroll state: the offset, whether the wheel is on and the
 * visible height as SharedValues, the scroll handler that feeds the offset,
 * and the JS callbacks for the closed-search height and the search row. */
export function useWheelScroll({
  shape,
  shownLength,
  query,
  searchRowH,
  wanted,
  pendingPlace,
  centreRef,
  moving,
  searchOpenRef,
  listRef,
  requestShape,
  cancelSettle,
  updateCentre,
  scheduleSettle,
}: Params) {
  const scrollY = useSharedValue(0);
  const wheelOn = useSharedValue(true);
  const viewportH = useSharedValue(0);
  // False while the search row has any height, so onLayout ignores the
  // heights the row animation passes through.
  const rowIdle = useRef(true);

  const scrollHandler = useAnimatedScrollHandler((e) => {
    scrollY.value = e.contentOffset.y;
  });

  // The new pad is committed: place the offset before the frame shows, then
  // turn the layout animation back on in the next commit.
  useLayoutEffect(() => {
    wheelOn.set(shape.wheel);
    viewportH.set(shape.wheelH > 0 ? visibleOf(shape.wheelH) : 0);
    const idx = pendingPlace.current;
    if (shape.wheel && shape.wheelH > 0 && idx !== null) {
      pendingPlace.current = null;
      const n = shownLength;
      const at = n > 0 ? Math.min(n - 1, Math.max(0, idx)) : 0;
      const offset = at * STEP;
      scrollY.set(offset);
      listRef.current?.scrollToOffset({ offset, animated: false });
      cancelSettle();
      moving.current = false;
      updateCentre(at);
      scheduleSettle();
    }
  }, [shape, shownLength, wheelOn, viewportH, scrollY, pendingPlace, listRef, moving, cancelSettle, updateCentre, scheduleSettle]);

  // Typing in the plain list shows the results from the top.
  useEffect(() => {
    if (!searchOpenRef.current) return;
    scrollY.set(0);
    listRef.current?.scrollToOffset({ offset: 0, animated: false });
  }, [query, scrollY, searchOpenRef, listRef]);

  // Takes the closed-search height from onLayout. Heights within 1px of the
  // current one are layout noise and change nothing.
  function applyWheelH(h: number) {
    if (!Number.isFinite(h) || h <= 0 || Math.abs(h - wanted.current.wheelH) <= 1) return;
    if (wanted.current.wheel) pendingPlace.current = centreRef.current;
    requestShape({ ...wanted.current, wheelH: h });
  }

  function onRowIdle(idle: boolean) {
    rowIdle.current = idle;
  }

  useAnimatedReaction(
    () => {
      const h = searchRowH.value;
      return Number.isFinite(h) ? h <= 0 : false;
    },
    (idle, prev) => {
      if (idle !== prev) runOnJS(onRowIdle)(idle);
    },
  );

  return { scrollY, wheelOn, viewportH, scrollHandler, rowIdle, applyWheelH };
}
