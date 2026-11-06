// What the island route owns for the line's audio source on the one player: the swap
// (loadSource under the open cover), the pending-play flag, the stale status filter after
// a swap, the neighbour prefetch, seekTop, waitForSwap and the lock screen metadata.
import { type AudioMetadata, type AudioPlayer, type AudioStatus } from 'expo-audio';
import type { Dispatch, MutableRefObject, RefObject, SetStateAction } from 'react';
import { useEffect, useEffectEvent, useRef, useState } from 'react';

import { STAGE_SPEEDS } from '@/components/tide/ladder/stage-model';
import { useStableHandler } from '@/hooks/use-stable-handler';
import * as api from '@/lib/api';
import { lockArtwork, startPlayback } from '@/lib/audio-mode';
import { afterCoverGone, openCoverUp } from '@/lib/card-morph';
import type { TFn } from '@/lib/i18n';
import { PENDING_PLAY_MS, SEEK_WAIT_MS, SPEED_LOAD_WAIT_MS, SWAP_STALE_MS, lockScreen } from '@/lib/island/island-consts';
import { peekLastLine, resumeLine } from '@/lib/last-line';
import { localLineAudio, prefetchLineAudio } from '@/lib/line-audio-cache';
import { getSettingsSync } from '@/lib/settings';
import { peekRung } from '@/lib/speed-ladder';

type Params = {
  id: string;
  player: AudioPlayer;
  island: api.Island | null;
  line: api.Line | undefined;
  idx: number;
  sourceUri: string | null;
  generation: number;
  speed: number;
  ahead: number | null;
  breathMs: number;
  stageUp: boolean;
  /** The island hop, for `hop.ahead`: the cube neighbours' cached islands the prefetch warms. */
  hop: { ahead: api.Island[] };
  hidden: boolean;
  phraseLabel: string | null;
  t: TFn;
  latestStatus: RefObject<AudioStatus>;
  audioFailShown: MutableRefObject<boolean>;
  crossed: MutableRefObject<boolean>;
  playsDone: MutableRefObject<number>;
  lastTick: MutableRefObject<{ time: number; playing: boolean; duration: number; end: number } | null>;
  resetHighlight: () => void;
  setError: Dispatch<SetStateAction<string>>;
};

export function useLineSource({
  id,
  player,
  island,
  line,
  idx,
  sourceUri,
  generation,
  speed,
  ahead,
  breathMs,
  stageUp,
  hop,
  hidden,
  phraseLabel,
  t,
  latestStatus,
  audioFailShown,
  // The route's names, suffixed here so the compiler lint reads them as refs.
  crossed: crossedRef,
  playsDone: playsDoneRef,
  lastTick: lastTickRef,
  resetHighlight,
  setError,
}: Params) {
  // The source the player last loaded, and the moment it did with the old
  // source's duration: a status the old source sent just before the swap can
  // still arrive after it, and must not count for the new one (see
  // isStaleStatus).
  const loadedUri = useRef<string | null>(null);
  const swap = useRef<{ at: number; oldDuration: number } | null>(null);

  // After a line switch that should keep playing, start the new source as
  // soon as it is swapped in; the native player begins when the item is ready.
  const playWhenLoaded = useRef(false);

  // A continuous run stops the player between plays: a new line swaps the
  // source in and loads it, and a repeat seeks back to the top. `playing` is
  // false for that gap, so the ring button would flash Play at every line.
  // This holds "we asked for playback and it has not started yet", which the
  // button reads next to `playing`. Cleared by the first playing status
  // (onLineStatus), by any stop that cancels the continuation, or after
  // PENDING_PLAY_MS if the audio never starts.
  const [pendingPlay, setPendingPlayState] = useState(false);
  const pendingPlayRef = useRef(false);
  function setPendingPlay(on: boolean) {
    pendingPlayRef.current = on;
    setPendingPlayState(on);
  }
  function setPlayWhenLoaded(on: boolean) {
    playWhenLoaded.current = on;
    setPendingPlay(on);
  }
  // A play that never loads its audio (offline mid-play, a server error) says
  // so once instead of going quiet; see audioFailShown.
  useEffect(() => {
    if (!pendingPlay) return;
    const timer = setTimeout(() => {
      setPendingPlay(false);
      if (latestStatus.current.isLoaded || audioFailShown.current) return;
      audioFailShown.current = true;
      setError(t('player.couldNotLoadIsland'));
    }, PENDING_PLAY_MS);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pendingPlay]);

  // Loads a new source into the one player, and starts it when a line switch
  // should keep playing (the native player begins once the item is ready).
  // Everything that used to reset with a new player resets here: the crossing,
  // the play count, the last tick and the highlight.
  // Under the open morph's cover the first load waits until the cover is gone
  // (a Play tap before that loads it at once, see playFromTop).
  // Loads this render's source if the player does not hold it yet. Safe to
  // call more than once. Declared before the effect that runs it so the
  // effect can list it (its identity never changes).
  const loadSource = useStableHandler(() => {
    if (!sourceUri || sourceUri === loadedUri.current) return;
    const first = loadedUri.current === null;
    swap.current = first ? null : { at: Date.now(), oldDuration: latestStatus.current.duration };
    loadedUri.current = sourceUri;
    crossedRef.current = false;
    playsDoneRef.current = 0;
    lastTickRef.current = null;
    if (!first) resetHighlight();
    // A downloaded file loads at once; a remote URL makes iOS build the item
    // on the main thread while it waits on the network. Everything else here
    // (loadedUri, kickUri, finishUri) keeps the logical URL, not the file,
    // and the logical URL has no access token, so a refresh is not a swap.
    const local = line ? localLineAudio(sourceUri, line.ja) : null;
    try {
      player.replace({ uri: local ?? api.withUser(sourceUri) });
    } catch {
      // The screen is unmounting and the player is already released.
      return;
    }
    kickUri.current = null;
    if (!playWhenLoaded.current) return;
    playWhenLoaded.current = false;
    kickUri.current = sourceUri;
    startPlayback(player);
  });
  // A continuous run stops the player between plays: see setPendingPlay.
  // Under the open morph's cover the first load waits until the cover is gone
  // (a Play tap before that loads it at once, see playFromTop).
  useEffect(() => {
    if (!sourceUri || sourceUri === loadedUri.current) return;
    if (openCoverUp(id)) return afterCoverGone(id, loadSource);
    loadSource();
  }, [sourceUri, player, id, loadSource]);
  // The lines around the current one download in the background, so the next
  // line change (or a step back) loads a local file. It runs after the change
  // has committed, and a new line, speed or pause replaces what is still
  // queued. The phrase's own render is not fetched ahead: it is only ever
  // played for the line on screen.
  // With the focus stage up, the line on screen is fetched at each of the
  // stage chip's speeds right after the next line, so the file a chip tap
  // asks for is local by the next play. The neighbours follow the speed
  // picked last, also one still waiting to land.
  useEffect(() => {
    if (!island || island.lines.length === 0) return;
    const t = setTimeout(() => {
      const n = island.lines.length;
      const order = [idx + 1, idx + 2, idx - 1, idx].map((i) => (i + n) % n);
      const version = `${island.speaker}-${generation}`;
      const at = ahead ?? speed;
      const item = (i: number, s: number) => {
        const l = island.lines[i]!;
        return { url: api.withUser(api.lineAudioUrl(island.id, l.idx, version, s, breathMs)), tag: l.ja };
      };
      const items = [...new Set(order)].map((i) => item(i, at));
      const chip = stageUp ? STAGE_SPEEDS.filter((s) => s !== at).map((s) => item(idx, s)) : [];
      // focus-stories: last, the line each cube neighbour opens on, at the speed it will open at, so a hop's
      // run starts on a local file.
      const hopAhead = hop.ahead.flatMap((n) => {
        const l = n.lines[resumeLine(peekLastLine(n.id), n.lines.length)];
        if (!l) return [];
        const s = peekRung(n.id)?.speed ?? getSettingsSync().defaultSpeed;
        return [{ url: api.withUser(api.lineAudioUrl(n.id, l.idx, `${n.speaker}-0`, s, breathMs)), tag: l.ja }];
      });
      prefetchLineAudio([...items.slice(0, 1), ...chip, ...items.slice(1), ...hopAhead]);
    }, 0);
    return () => clearTimeout(t);
  }, [island, idx, generation, speed, ahead, breathMs, stageUp, hop.ahead]);
  // No expo-audio preload() for the next line: on iOS, replace() with a
  // preloaded URL moves that item out of the AVPlayer that loaded it into this
  // one (AudioModule.swift `replace`), and with it the line after the first
  // showed playing, stayed silent, and a seek on it never returned. A plain
  // replace() builds a fresh item, the path the first line plays through.

  // The source a swap asked to play. play() lands while the item is still
  // loading; if the first status that shows it loaded is still paused while
  // the play is pending, it is asked once more (see onLineStatus).
  const kickUri = useRef<string | null>(null);

  // seekTo resolves when the native seek completes, and a seek on an item
  // that never loads never completes. Play goes ahead after SEEK_WAIT_MS
  // either way, so a tap on the button always does something.
  async function seekTop() {
    let timer: ReturnType<typeof setTimeout> | undefined;
    // A promise finally, not a try finally: the compiler does not lower those.
    const run = async () => {
      try {
        await Promise.race([
          player.seekTo(0),
          new Promise<void>((resolve) => {
            timer = setTimeout(resolve, SEEK_WAIT_MS);
          }),
        ]);
      } catch {
        // A seek can fail while the item is still loading; play anyway.
      }
    };
    await run().finally(() => clearTimeout(timer));
  }

  // Resolves once the source swap the last render asked for has loaded (a
  // status with a duration of its own), or after SPEED_LOAD_WAIT_MS.
  async function waitForSwap() {
    const from = loadedUri.current;
    const until = Date.now() + SPEED_LOAD_WAIT_MS;
    while (Date.now() < until) {
      await new Promise<void>((resolve) => setTimeout(resolve, 50));
      const s = latestStatus.current;
      if (loadedUri.current !== from && !swap.current && s.isLoaded && s.duration > 0) return;
    }
  }

  // A status the old source sent just before a swap and delivered after it:
  // it still carries the old source's duration. Once the new source reports
  // its own duration, nothing more is filtered.
  function isStaleStatus(s: AudioStatus): boolean {
    const sw = swap.current;
    if (!sw) return false;
    if (Date.now() - sw.at > SWAP_STALE_MS) {
      swap.current = null;
      return false;
    }
    if (s.duration > 0 && s.duration === sw.oldDuration) return true;
    if (s.duration > 0) swap.current = null;
    return false;
  }

  // Lock screen / notification text. A hidden sentence never shows the
  // Japanese, whether Blind hid it or a ladder pass did.
  function lockMeta(): AudioMetadata {
    const pos = t('player.lineOfTotal', { index: idx + 1, total: island!.lines.length });
    const artist = island!.title || t('player.island');
    const artworkUrl = lockArtwork();
    return hidden
      ? { title: pos, artist, artworkUrl }
      : { title: phraseLabel ?? line!.ja, artist, albumTitle: pos, artworkUrl };
  }

  // The line player is the lock screen / notification's active player. It
  // lives as long as the screen, and releasing it on unmount clears the lock
  // screen on both platforms, so there is no explicit clear anywhere here.
  // Under the open morph's cover it waits until the cover is gone, and then
  // carries the metadata of that moment.
  const activateLockScreen = useStableHandler(() => {
    if (!lockScreen || !island || !line) return;
    player.setActiveForLockScreen(true, lockMeta(), { showSeekForward: false, showSeekBackward: false });
  });
  // Effect events: each effect runs for the deps it lists and reads the
  // rest as of that render.
  const activateOnCoverGone = useEffectEvent(() => {
    if (!lockScreen || !island || !line) return;
    return afterCoverGone(id, activateLockScreen);
  });
  useEffect(() => activateOnCoverGone(), [player, island?.id, generation]);

  const updateLockMeta = useEffectEvent(() => {
    if (!lockScreen || !island || !line || openCoverUp(id)) return;
    player.updateLockScreenMetadata(lockMeta());
  });
  useEffect(() => {
    updateLockMeta();
  }, [hidden, idx, island?.title, island?.lines.length, line?.ja, phraseLabel]);

  return {
    loadedUri,
    kickUri,
    playWhenLoaded,
    pendingPlay,
    pendingPlayRef,
    setPendingPlay,
    setPlayWhenLoaded,
    loadSource,
    seekTop,
    waitForSwap,
    isStaleStatus,
  };
}
