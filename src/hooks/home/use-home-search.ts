import { useCallback, useRef, useState, type MutableRefObject } from 'react';
import {
  Extrapolation,
  interpolate,
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
} from 'react-native-reanimated';

import { startSearchOpen } from '@/components/island-search';
import type * as api from '@/lib/api';
import type { Shape } from '@/hooks/home/use-wheel-scroll';

/** What open and close need from the route. The route fills it each render
 * (after `sortedAll` and `requestShape` exist), so both callbacks stay stable
 * and read the latest values when they run. */
export type HomeSearchCtl = {
  sortedAll: api.IslandSummary[];
  centreRef: MutableRefObject<number>;
  wanted: MutableRefObject<Shape>;
  pendingPlace: MutableRefObject<number | null>;
  cancelSettle: () => void;
  requestShape: (next: Shape) => void;
};

/** Home's search: the query, the open flag, the shared values IslandSearch
 * drives, and the open and close steps that switch the list between wheel and
 * plain shapes. */
export function useHomeSearch() {
  const reducedMotion = useReducedMotion();
  const [query, setQuery] = useState('');
  const [searchOpen, setSearchOpen] = useState(false);
  // 0 closed, 1 open, driven by IslandSearch. The header magnifier fades out
  // as the pill's own magnifier fades in just below it.
  const searchGrow = useSharedValue(0);
  // The search row's height, which moves the header and list below it.
  const searchRowH = useSharedValue(0);
  const searchButtonStyle = useAnimatedStyle(() => ({
    opacity: interpolate(searchGrow.value, [0.1, 0.4], [1, 0], Extrapolation.CLAMP),
  }));
  const searchOpenRef = useRef(false);
  // The island centred when search opened, centred again when it closes.
  const preSearchId = useRef<string | null>(null);
  const ctl = useRef<HomeSearchCtl | null>(null);

  // Search opens from the closed state, where the list is `sortedAll`.
  const openSearch = useCallback(() => {
    const c = ctl.current;
    if (!c) return;
    const n = c.sortedAll.length;
    const at = n > 0 ? Math.min(n - 1, Math.max(0, c.centreRef.current)) : 0;
    preSearchId.current = c.sortedAll[at]?.id ?? null;
    startSearchOpen(searchGrow, searchRowH, reducedMotion);
    searchOpenRef.current = true;
    c.cancelSettle();
    setSearchOpen(true);
    c.requestShape({ ...c.wanted.current, wheel: false });
  }, [reducedMotion, searchGrow, searchRowH]);

  // IslandSearch has already started the close motion; the keyboard hides
  // after this returns.
  const closeSearch = useCallback(() => {
    const c = ctl.current;
    if (!c) return;
    // Clearing the query brings the full list back: centre the island that
    // was centred before search opened, or the first one if it is gone.
    const id = preSearchId.current;
    const full = id ? c.sortedAll.findIndex((i) => i.id === id) : -1;
    c.pendingPlace.current = full >= 0 ? full : 0;
    searchOpenRef.current = false;
    setSearchOpen(false);
    setQuery('');
    c.requestShape({ ...c.wanted.current, wheel: true });
  }, []);

  return {
    query,
    setQuery,
    searchOpen,
    searchGrow,
    searchRowH,
    searchButtonStyle,
    searchOpenRef,
    openSearch,
    closeSearch,
    ctl,
  };
}
