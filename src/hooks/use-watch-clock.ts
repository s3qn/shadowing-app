import { useEffect } from 'react';

import { addPractice, flushPractice } from '@/lib/practice';

const TICK_MS = 5000;
// A tick later than this means the timer was suspended (app in the background),
// so only one tick's worth counts.
const MAX_DELTA_S = 10;

/**
 * Counts wall-clock seconds as practice while `playing` is true, for screens
 * that play media with no AudioPlayer (the YouTube iframe). Nothing counts
 * while paused or without an island.
 */
export function useWatchClock(islandId: string | undefined, playing: boolean): void {
  useEffect(() => {
    if (!playing || !islandId) return;
    let last = Date.now();
    const take = () => {
      const now = Date.now();
      const delta = (now - last) / 1000;
      last = now;
      if (delta > 0) addPractice(islandId, delta > MAX_DELTA_S ? TICK_MS / 1000 : delta);
    };
    const timer = setInterval(take, TICK_MS);
    return () => {
      clearInterval(timer);
      const rest = (Date.now() - last) / 1000;
      if (rest > 0) addPractice(islandId, Math.min(rest, TICK_MS / 1000));
      void flushPractice();
    };
  }, [islandId, playing]);
}
