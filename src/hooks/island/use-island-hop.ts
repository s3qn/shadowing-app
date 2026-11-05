// focus-stories D3: the island's neighbours for the cube swipe and the hop to one
// of them. Owner: Bob G2 (this file, src/lib/auto-practice.ts and
// src/app/_layout.tsx only).
//
// Contract: `io` is spread into the island's `LadderIo`: `neighbours` ({ prev,
// next } booleans plus `prevId`/`nextId` for the previews) and `onHop(dir)`.
// Plain open (`auto !== '1'`): one `api.listIslands()` ordered by
// `driveQueue(islands, learningLanguage, showAll)` (Home's order), prev/next by
// `id`; both fetched into memory with `prefetchIsland`; under `devNoNeighbours()` or a failed
// fetch there are none (the swipe bounces). Session (`auto === '1'`): next is
// `finishAutoIsland(id, 'skipped')`, prev the new `prevAutoIsland(id)`. A commit
// calls, in a session, `actions.current.goToIsland(nextId, kind, true)`, which for
// an island replaces with `{ id, auto: '1', hop: '1' }` before it ends the run; plain, `router.replace({ pathname:
// '/island/[id]', params: { id, hop: '1' } })` and then `endRun()`, so the stage
// never drops before the next screen covers it. `starts` is true when this island
// was opened by a hop (`hop === '1'`, read once at mount): the island's hop cover
// shows the still stage until the live sentence has fitted and its auto-start
// effect starts the run at the saved line, as a session does. The plain queue is
// kept across hops, so a hopped island knows its neighbours on its first render.
// `ahead` holds the neighbours' cached islands once read, for the island to fetch
// their first line's audio. Stub: no neighbours, never starts.
import { useRouter } from 'expo-router';
import { useCallback, useEffect, useMemo, useState, type RefObject } from 'react';

import type { LadderIo, LadderNeighbours } from '@/hooks/ladder/ladder-types';
import * as api from '@/lib/api';
import type { SessionKind } from '@/lib/api';
import { finishAutoIsland, peekAutoNeighbours, prevAutoIsland } from '@/lib/auto-practice';
import { devNoNeighbours } from '@/lib/dev-simulate';
import { driveQueue } from '@/lib/drive-queue';
import { prefetchIsland } from '@/lib/island-cache';
import { getSettingsSync } from '@/lib/settings';

/** Home's order as the last plain open fetched it: a hopped island starts from it, then refreshes it. */
let lastQueue: string[] = [];

/** What the island lends the hook, filled after the island's own functions are defined. */
export type HopActions = {
  endRun: () => void;
  goToIsland: (nextId: string, nextKind: SessionKind, hopped?: boolean) => void;
};

export type IslandHopOptions = {
  id: string;
  auto?: string;
  hop?: string;
  actions: RefObject<HopActions | null>;
};

export type IslandHop = {
  /** The run starts by itself once the stage can mount (a hop opened this island). */
  starts: boolean;
  io: Pick<LadderIo, 'neighbours' | 'onHop'>;
  /** The neighbours' cached islands, once read: their first line's audio can be fetched ahead. */
  ahead: api.Island[];
};

export function useIslandHop({ id, auto, hop, actions }: IslandHopOptions): IslandHop {
  const router = useRouter();
  const session = auto === '1';
  // Read once: the param stays on the route, but only the opening counts.
  const [starts] = useState(hop === '1');
  const [queueIds, setQueueIds] = useState<string[]>(() => (session ? [] : lastQueue));

  // Plain open: Home's order, fetched once. A failed fetch keeps the last order (none on a first open).
  useEffect(() => {
    if (session) return;
    let alive = true;
    api
      .listIslands()
      .then((all) => {
        if (!alive) return;
        const s = getSettingsSync();
        const ids = driveQueue(all, s.learningLanguage, s.showAllLanguages).map((i) => i.id);
        lastQueue = ids;
        // The same order keeps the same array, so the neighbours never change mid-drag.
        setQueueIds((cur) => (cur.length === ids.length && cur.every((v, i) => v === ids[i]) ? cur : ids));
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [session]);

  const neighbours = useMemo<LadderNeighbours | undefined>(() => {
    if (devNoNeighbours()) return undefined;
    if (session) {
      const n = peekAutoNeighbours(id);
      return { prev: n.prev !== null, next: n.next !== null, prevId: n.prevId, nextId: n.nextId };
    }
    const at = queueIds.indexOf(id);
    if (at < 0) return undefined;
    const prevId = queueIds[at - 1];
    const nextId = queueIds[at + 1];
    return { prev: prevId !== undefined, next: nextId !== undefined, prevId, nextId };
  }, [id, session, queueIds]);

  // D7: the neighbour's island is in memory before the swipe commits, fetched if no copy is at hand.
  const prevId = neighbours?.prevId;
  const nextId = neighbours?.nextId;
  const [ahead, setAhead] = useState<api.Island[]>([]);
  useEffect(() => {
    // A session neighbour can be a video or podcast: only islands have a cache entry.
    const kinds = session ? peekAutoNeighbours(id) : null;
    const ids: string[] = [];
    if (nextId && (!kinds || kinds.next === 'island')) ids.push(nextId);
    if (prevId && (!kinds || kinds.prev === 'island')) ids.push(prevId);
    let alive = true;
    void Promise.all(ids.map((n) => prefetchIsland(n))).then((got) => {
      if (alive) setAhead(got.flatMap((c) => (c ? [c.island] : [])));
    });
    return () => {
      alive = false;
    };
  }, [id, session, prevId, nextId]);

  const onHop = useCallback(
    (dir: -1 | 1) => {
      const a = actions.current;
      if (!a) return;
      if (session) {
        // Pull the target before ending the run so a refused hop leaves the run alone.
        const n = peekAutoNeighbours(id);
        if ((dir === 1 ? n.next : n.prev) === null) return;
        // goToIsland ends the run itself, after the replace for an island neighbour.
        if (dir === 1) {
          const next = finishAutoIsland(id, 'skipped');
          if (next) a.goToIsland(next.nextId, next.nextKind, true);
          else a.endRun();
        } else {
          const prev = prevAutoIsland(id);
          if (prev) a.goToIsland(prev.prevId, prev.prevKind, true);
          else a.endRun();
        }
        return;
      }
      const target = dir === 1 ? nextId : prevId;
      if (!target) return;
      // The replace first: in the same batch the old screen goes with its stage still up, so the stage
      // never fades out over the island's own chrome before the next screen covers it.
      router.replace({ pathname: '/island/[id]', params: { id: target, hop: '1' } });
      a.endRun();
    },
    [actions, id, session, nextId, prevId, router],
  );

  return useMemo(() => ({ starts, io: { neighbours, onHop }, ahead }), [starts, neighbours, onHop, ahead]);
}
