// What the island route owns for an auto-practice chain: the session refs, the open
// hold, the hold on the next island's title, the move to the next island (also the
// cube hop's), ending or dropping the chain, and the AppState background handling.
import * as Haptics from 'expo-haptics';
import type { useAudioPlayer } from 'expo-audio';
import { router } from 'expo-router';
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type MutableRefObject } from 'react';
import { AppState } from 'react-native';

import type { IslandCore } from '@/hooks/island/island-core';
import type { useTake } from '@/hooks/use-take';
import * as api from '@/lib/api';
import { stopPlayback } from '@/lib/audio-mode';
import {
  autoPlaceOf,
  endAutoPractice,
  finishAutoIsland,
  finishSession,
  routeFor,
  sessionLines,
  type AutoChain,
} from '@/lib/auto-practice';
import { hapticImpact, hapticSelection } from '@/lib/haptics';
import { AUTO_NEXT_HOLD_MS, OPEN_HOLD_MAX_MS } from '@/lib/island/island-consts';
import type { PassStep } from '@/lib/pass-programme';

type Params = {
  id: string;
  auto?: string;
  /** A hop opened this island (`hop.starts`): it opens under the same hold as a session. */
  hopStarts: boolean;
  core: MutableRefObject<IslandCore | null>;
  take: ReturnType<typeof useTake>;
  player: ReturnType<typeof useAudioPlayer>;
  echoRef: MutableRefObject<PassStep>;
  closeSheetThen: (fn: () => void) => void;
  plainBack: () => void;
};

export function useAutoChain({ id, auto, hopStarts, core, take, player, echoRef, closeSheetThen, plainBack }: Params) {
  // auto-practice: the chain this player is part of, if any. Read once at
  // mount; a stale `auto` param with no live session is ignored.
  const [autoStartPlace] = useState(() => (auto === '1' ? autoPlaceOf(id) : null));
  const autoRunRef = useRef(autoStartPlace !== null);
  const autoHoldRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // auto-practice: the island the hold moves on to; set for the whole hold,
  // also while backgrounding has paused its timer.
  const pendingNextRef = useRef<{ id: string; kind: api.SessionKind } | null>(null);
  const autoLeavingRef = useRef(false);
  const autoStartedRef = useRef(false);
  // auto-practice: a session opens straight into the ladder stage, so the loader stands in for
  // the player until the stage is up (or OPEN_HOLD_MAX_MS passes), and the player's own line never
  // shows between the two. A hop (`hopStarts`) opens under the same hold.
  const [openHold, setOpenHold] = useState(autoStartPlace !== null || hopStarts);
  const openHoldRef = useRef(openHold);
  openHoldRef.current = openHold;
  useEffect(() => {
    if (!openHold) return;
    const timer = setTimeout(() => setOpenHold(false), OPEN_HOLD_MAX_MS);
    return () => clearTimeout(timer);
  }, [openHold]);
  // The stage is up: the loader gives way to it.
  const releaseOpenHold = useCallback(() => setOpenHold(false), []);
  const [autoUi, setAutoUi] = useState<AutoChain | null>(
    autoStartPlace ? { at: autoStartPlace.at, total: autoStartPlace.total, next: null } : null,
  );
  // auto-practice: when the current line's ladder started, for the session's seconds per line.
  const lineStartRef = useRef(0);
  // auto-practice: the line already noted on this visit, null once the run moves to another line.
  const notedLineRef = useRef<number | null>(null);
  // The session's picked lines only; the full island otherwise.
  const forSession = <T extends { lines: api.Line[] }>(data: T): T => (auto === '1' ? sessionLines(id, data) : data);
  useEffect(
    () => () => {
      if (autoHoldRef.current) clearTimeout(autoHoldRef.current);
    },
    [],
  );

  // A take made with the phone in a pocket is not a take, and the microphone
  // must never run in the background: dropped as soon as the app backgrounds.
  // The line stops with it; nothing else about playback changes here. The
  // listener is subscribed once, so everything it calls is read through the
  // ref: the first render's dropTake would close over a take whose cancel()
  // still sees `recording` as false and leaves the microphone running.
  // `dropTake` and `endRun` are read from `core` at the event, the same way.
  const backgroundRef = useRef({ take, player, echoRef, startAutoHold });
  useLayoutEffect(() => {
    backgroundRef.current = { take, player, echoRef, startAutoHold };
  });
  useEffect(() => {
    const sub = AppState.addEventListener('change', (state) => {
      // auto-practice: the hold between islands pauses in the background and
      // starts over on return, so the chain never moves on unseen.
      if (state === 'active') {
        const next = pendingNextRef.current;
        if (next && !autoHoldRef.current && autoRunRef.current) backgroundRef.current.startAutoHold(next.id, next.kind);
        return;
      }
      if (state !== 'background') return;
      if (autoHoldRef.current) {
        clearTimeout(autoHoldRef.current);
        autoHoldRef.current = null;
      }
      const { take: t, player: p, echoRef } = backgroundRef.current;
      // The ladder stops the whole run on backgrounding, not just a take in
      // progress: the island is back at idle with Shadow in the dock.
      if (echoRef.current !== 'idle') {
        core.current?.endRun();
        return;
      }
      if (t.phase === 'recording') {
        // The line first: stopPlayback never throws, and neither does the
        // take player's pause inside drop().
        stopPlayback(p);
        void p.seekTo(0);
        core.current?.dropTake();
      }
    });
    return () => sub.remove();
  }, [core]);

  // auto-practice: the island's last line finished. Hold on the next title,
  // then move on; the last island ends the chain.
  function autoIslandDone() {
    const place = autoPlaceOf(id);
    if (!autoRunRef.current || !place) return;
    void hapticSelection();
    const next = finishAutoIsland(id, 'shadowed');
    if (!next) {
      endChain();
      return;
    }
    setAutoUi({ at: place.at, total: place.total, next: next.nextTitle });
    startAutoHold(next.nextId, next.nextKind);
  }

  // auto-practice: (re)starts the hold on the next island's title.
  function startAutoHold(nextId: string, nextKind: api.SessionKind) {
    pendingNextRef.current = { id: nextId, kind: nextKind };
    if (autoHoldRef.current) clearTimeout(autoHoldRef.current);
    autoHoldRef.current = setTimeout(() => {
      autoHoldRef.current = null;
      pendingNextRef.current = null;
      goToIsland(nextId, nextKind);
    }, AUTO_NEXT_HOLD_MS);
  }

  function goToIsland(nextId: string, nextKind: api.SessionKind, hopped = false) {
    if (autoLeavingRef.current) return;
    autoLeavingRef.current = true;
    if (hopped && nextKind === 'island') {
      // A cube hop: the replace first, so the stage never fades out over the island chrome, and the next
      // island opens under its hop cover.
      router.replace({ pathname: '/island/[id]', params: { id: nextId, auto: '1', hop: '1' } });
      core.current?.endRun();
      return;
    }
    core.current?.endRun();
    closeSheetThen(() => router.replace(routeFor(nextId, nextKind)));
  }

  function endChain() {
    core.current?.endRun();
    void hapticImpact(Haptics.ImpactFeedbackStyle.Medium);
    finishSession(true);
    closeSheetThen(plainBack);
  }

  // Drops the chain: the player carries on as a normal one.
  function dropChain() {
    if (!autoRunRef.current) return;
    if (autoHoldRef.current) {
      clearTimeout(autoHoldRef.current);
      autoHoldRef.current = null;
    }
    pendingNextRef.current = null; // auto-practice
    endAutoPractice();
    setAutoUi(null);
    autoRunRef.current = false;
  }

  return {
    autoRunRef,
    autoHoldRef,
    pendingNextRef,
    autoLeavingRef,
    autoStartedRef,
    lineStartRef,
    notedLineRef,
    openHold,
    openHoldRef,
    releaseOpenHold,
    autoUi,
    forSession,
    autoIslandDone,
    startAutoHold,
    goToIsland,
    endChain,
    dropChain,
  };
}
