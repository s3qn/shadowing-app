// What the island route owns for getting an island on screen: the warm start read,
// the load effect (local copy, then the network), the offline retry, the one-shot
// ready signal to a covering morph, and the last-line save.
import type { Dispatch, MutableRefObject, SetStateAction } from 'react';
import { useEffect, useEffectEvent, useLayoutEffect, useRef } from 'react';
import { AppState } from 'react-native';

import * as api from '@/lib/api';
import { endAutoPractice } from '@/lib/auto-practice';
import { afterCoverGone, isActive as morphActive, playerGone, playerReady } from '@/lib/card-morph';
import { OFFLINE_RETRY_MS, REFRESH_AFTER_COVER_MS } from '@/lib/island/island-consts';
import { invalidateCachedIsland, peekCachedIsland, readCachedIsland, writeCachedIsland } from '@/lib/island-cache';
import { getLastLine, peekLastLine, resumeLine, setLastLine } from '@/lib/last-line';
import { requestLoader } from '@/lib/loading-overlay';
import { isDownloaded } from '@/lib/offline-islands';
import { t } from '@/lib/i18n';

/** The local copy parsed for the first render, when a morph or a cube hop opened the screen. */
export function readWarmStart(id: string, hopParam: string | undefined) {
  if (!morphActive() && hopParam !== '1') return null;
  const cached = peekCachedIsland(id);
  if (!cached) return null;
  const n = cached.island.lines.length;
  const saved = peekLastLine(id);
  if (saved === undefined) return null;
  return { ...cached, idx: resumeLine(saved, n) };
}

type WarmStart = NonNullable<ReturnType<typeof readWarmStart>>;

type Params = {
  id: string;
  attempt: number;
  auto: string | undefined;
  ytLine: string | undefined;
  island: api.Island | null;
  error: string;
  cacheMissed: boolean;
  offline: boolean;
  lineIdx: number;
  warmStartRef: MutableRefObject<WarmStart | null>;
  refreshRef: MutableRefObject<(() => Promise<void>) | null>;
  carryError: MutableRefObject<string>;
  openHoldRef: MutableRefObject<boolean>;
  autoRunRef: MutableRefObject<boolean>;
  forSession: <T extends { lines: api.Line[] }>(data: T) => T;
  setIdx: Dispatch<SetStateAction<number>>;
  setIsland: Dispatch<SetStateAction<api.Island | null>>;
  setError: Dispatch<SetStateAction<string>>;
  setOffline: Dispatch<SetStateAction<boolean>>;
  setCacheMissed: Dispatch<SetStateAction<boolean>>;
  resumeRevoice: (islandId: string) => void;
  skipUnloadedIsland: () => boolean;
};

export function useIslandLoad({
  id,
  attempt,
  auto,
  ytLine,
  island,
  error,
  cacheMissed,
  offline,
  lineIdx,
  warmStartRef,
  refreshRef,
  carryError,
  openHoldRef,
  autoRunRef,
  forSession,
  setIdx,
  setIsland,
  setError,
  setOffline,
  setCacheMissed,
  resumeRevoice,
  skipUnloadedIsland,
}: Params): void {
  useEffect(() => {
    let alive = true;
    // The raw text of what is on screen, once something is: the local copy
    // or the network's answer, whichever lands first.
    let shownText: string | null = null;
    let cachedText: string | null = null;
    // The first render already showed the local copy: only the network
    // refresh is left to run.
    const warm = attempt === 0 && warmStartRef.current?.island.id === id ? warmStartRef.current : null;
    if (warm) {
      shownText = warm.text;
      cachedText = warm.text;
    }
    // Puts an island on screen for the first time on this open.
    async function show(data: api.Island, text: string) {
      // A ready island reopens where it was left; a chain starts at the top.
      if (ytLine !== undefined && Number.isFinite(Number(ytLine))) { // youtube-shadowing
        setIdx(Math.max(0, Math.min(Math.floor(Number(ytLine)), data.lines.length - 1))); // youtube-shadowing
      } else if (auto === '1') {
        setIdx((i) => Math.max(0, Math.min(i, data.lines.length - 1)));
      } else if (data.status === 'ready') {
        const saved = await getLastLine(id);
        if (!alive || shownText !== null) return false;
        setIdx(resumeLine(saved, data.lines.length));
      } else {
        setIdx((i) => Math.max(0, Math.min(i, data.lines.length - 1)));
      }
      shownText = text;
      setIsland(forSession(data));
      setError(carryError.current);
      carryError.current = '';
      return true;
    }
    async function readCache() {
      const cached = await readCachedIsland(id);
      if (!alive) return;
      if (!cached) {
        setCacheMissed(true);
        return;
      }
      cachedText = cached.text;
      if (shownText !== null) return;
      await show(cached.island, cached.text);
    }
    // The local copy is read and parsed after the first frame, so the open
    // transition starts before any of that work. Under a card morph the
    // transition already ran (and Home started this read on press-in), so
    // it is picked up at once.
    const raf = warm
      ? null
      : morphActive()
        ? null
        : requestAnimationFrame(() => {
            setTimeout(() => void readCache(), 0);
          });
    if (!warm && raf === null) void readCache();
    const refresh = async () => {
      try {
        const text = await api.getIslandText(id);
        if (!alive) return;
        setOffline(false); // offline-islands
        // The same bytes as what is on screen (and so in the local copy):
        // nothing to parse, set or write.
        if (shownText !== null && text === shownText) {
          return;
        }
        const data = JSON.parse(text) as api.Island;
        // Lines with a working status: a re-voice is running on the server.
        if (data.status === 'working' && data.lines.length > 0) resumeRevoice(id);
        if (shownText === null && (await show(data, text))) {
          // Nothing left to do here: show() already put the island on screen.
        } else if (!alive) {
          return;
        } else if (shownText !== null && text !== shownText) {
          // The server moved past the local copy: swap it in where the
          // user is now, inside the new line count.
          shownText = text;
          setIdx((i) => Math.max(0, Math.min(i, data.lines.length - 1)));
          setIsland(forSession(data));
        }
        if (text && data.status === 'ready') {
          if (text !== cachedText) setTimeout(() => writeCachedIsland(data, text), 0);
        } else {
          invalidateCachedIsland(id);
        }
      } catch (e) {
        // offline-islands: only a failed fetch (no response) means offline; an HTTP error surfaces as before.
        if (e instanceof TypeError && isDownloaded(id)) {
          if (alive) setOffline(true);
          return;
        }
        // night-wave: offline in an auto-practice chain with nothing on screen: skip it.
        if (e instanceof TypeError && shownText === null && alive && skipUnloadedIsland()) return;
        if (alive) setError(e instanceof Error ? e.message : t('player.couldNotLoadIsland'));
      }
    };
    // Opened from the local copy under the morph: the refresh waits until the
    // cover is gone and the reveal has run, so its download and any parse
    // stay out of the landing.
    const stopRefresh = warm ? afterCoverGone(id, () => void refresh(), REFRESH_AFTER_COVER_MS) : null;
    if (!warm) void refresh();
    refreshRef.current = refresh; // offline-islands
    return () => {
      alive = false;
      refreshRef.current = null; // offline-islands
      stopRefresh?.();
      if (raf !== null) cancelAnimationFrame(raf);
    };
  }, [id, attempt]);

  // offline-islands: while offline, try the server again on return to the app
  // and every 15 s; a success clears offline inside refresh.
  useEffect(() => {
    if (!offline) return;
    const retry = () => void refreshRef.current?.();
    const timer = setInterval(retry, OFFLINE_RETRY_MS);
    const sub = AppState.addEventListener('change', (state) => {
      if (state === 'active') retry();
    });
    return () => {
      clearInterval(timer);
      sub.remove();
    };
  }, [offline]);

  // Tells a covering card morph the player has its first content on screen:
  // the island, an error, or no local copy (the network's answer then fades
  // in on its own). Two frames, so the content is laid out and drawn first.
  const firstContent = island !== null || !!error || cacheMissed;
  const readySentRef = useRef(false);
  // One-shot: fires from commit (not from an effect that waits a tick after
  // it), one frame so the content just committed is laid out and drawn
  // first, then never again for this mount.
  // The ref is set inside the frame, so a cancelled frame (a StrictMode
  // remount) sends again. With the lines in hand the loader is cleared right
  // here, without waiting for the landing render and its effect.
  // Sent straight from the commit, not from a frame: a frame waits out the
  // whole JS backlog, and the morph's landing worklet does the rest on the UI
  // thread. The ref makes it once per mount (a StrictMode re-run sends
  // nothing new).
  // An effect event: island and error are read once, at the first content.
  const sendReady = useEffectEvent(() => {
    if (!firstContent || readySentRef.current) return;
    const waiting = island === null && !error;
    readySentRef.current = true;
    playerReady(id, { waiting });
    if (!waiting && !openHoldRef.current) requestLoader(false);
  });
  useLayoutEffect(() => {
    sendReady();
  }, [firstContent, id]);

  // A back morph waits for this before it shrinks into the card.
  useEffect(() => () => playerGone(id), [id]);
  useEffect(() => () => endAutoPractice(id), [id]); // auto-practice

  // Remembers the line an island was left on, so reopening it resumes here.
  useEffect(() => {
    if (island && !autoRunRef.current) setLastLine(id, lineIdx);
  }, [id, lineIdx, island]);
}
