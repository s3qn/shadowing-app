import { useRouter } from 'expo-router';
import { useCallback, useEffect, useRef, useState } from 'react';

import * as api from '@/lib/api';

/** How long the finished island sits on screen, glowing, before the screen
 * navigates away. */
const READY_HOLD_MS = 900;

type BuildRoute = '/island/[id]' | '/podcast/[id]' | '/video/[id]';

/** Polls a building island every 2s, holds the finished one on screen for a
 * beat, then replaces the route with `route`. `onFail` gets the error text when
 * the build fails. `stop` clears the poll and the hold; it also runs on unmount. */
export function useFollowBuild(route: BuildRoute, onFail: (message: string) => void) {
  const router = useRouter();
  const [stage, setStage] = useState('queued');
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const readyTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const onFailRef = useRef(onFail);
  onFailRef.current = onFail;

  const stop = useCallback(() => {
    if (pollRef.current) clearInterval(pollRef.current);
    if (readyTimerRef.current) clearTimeout(readyTimerRef.current);
    pollRef.current = null;
    readyTimerRef.current = null;
  }, []);

  useEffect(() => stop, [stop]);

  const follow = useCallback(
    (id: string) => {
      stop();
      pollRef.current = setInterval(async () => {
        try {
          const island = await api.getIsland(id);
          setStage(island.stage || island.status);
          if (island.status === 'ready') {
            if (pollRef.current) clearInterval(pollRef.current);
            pollRef.current = null;
            setStage('ready');
            readyTimerRef.current = setTimeout(() => {
              router.replace({ pathname: route, params: { id } });
            }, READY_HOLD_MS);
          } else if (island.status === 'failed') {
            if (pollRef.current) clearInterval(pollRef.current);
            pollRef.current = null;
            onFailRef.current(api.islandErrorText(island));
          }
        } catch {
          // A dropped poll is not fatal, the next tick retries.
        }
      }, 2000);
    },
    [route, router, stop],
  );

  return { stage, setStage, follow, stop };
}
