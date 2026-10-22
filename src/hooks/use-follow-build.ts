import { useRouter } from 'expo-router';
import { useCallback, useEffect, useRef, useState } from 'react';

import * as api from '@/lib/api';

/** How long the finished island sits on screen, glowing, before the screen
 * navigates away. */
const READY_HOLD_MS = 900;

/** An estimate rises only when the new one is at least this much higher. */
const ETA_RISE_MIN_S = 30;

type BuildRoute = '/review' | '/island/[id]' | '/podcast/[id]' | '/video/[id]';

/** Polls a building island every 2s, holds the finished one on screen for a
 * beat, then replaces the route with `route`. `onFail` gets the error text when
 * the build fails; `onLand` runs just before the navigation. `stop` clears the
 * poll and the hold; it also runs on unmount. */
export function useFollowBuild(route: BuildRoute, onFail: (message: string) => void, onLand?: () => void) {
  const router = useRouter();
  const [stage, setStage] = useState('queued');
  const [etaS, setEtaS] = useState<number | null>(null);
  const etaRef = useRef<number | null>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const tickRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const readyTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const onFailRef = useRef(onFail);
  onFailRef.current = onFail;
  const onLandRef = useRef(onLand);
  onLandRef.current = onLand;

  const putEta = useCallback((v: number | null) => {
    etaRef.current = v;
    setEtaS(v);
  }, []);

  const stop = useCallback(() => {
    if (tickRef.current) clearInterval(tickRef.current);
    tickRef.current = null;
    if (pollRef.current) clearInterval(pollRef.current);
    if (readyTimerRef.current) clearTimeout(readyTimerRef.current);
    pollRef.current = null;
    readyTimerRef.current = null;
  }, []);

  useEffect(() => stop, [stop]);

  const follow = useCallback(
    (id: string) => {
      stop();
      putEta(null);
      // Between polls the estimate counts down locally, one second at a time.
      tickRef.current = setInterval(() => {
        const cur = etaRef.current;
        if (cur !== null && cur > 0) putEta(cur - 1);
      }, 1000);
      pollRef.current = setInterval(async () => {
        try {
          const island = await api.getIsland(id);
          setStage(island.stage || island.status);
          const next = typeof island.eta_s === 'number' ? island.eta_s : null;
          const cur = etaRef.current;
          // A small rise is jitter, keep the ticking value; a rise of 30 s or more is real.
          if (next === null || cur === null || next < cur || next - cur >= ETA_RISE_MIN_S) putEta(next);
          if (island.status === 'ready') {
            if (pollRef.current) clearInterval(pollRef.current);
            pollRef.current = null;
            setStage('ready');
            readyTimerRef.current = setTimeout(() => {
              onLandRef.current?.();
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
    [putEta, route, router, stop],
  );

  return { stage, setStage, etaS, follow, stop };
}
