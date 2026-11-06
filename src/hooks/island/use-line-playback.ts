// The island line's playback: the status tick (the line's end, a take's end, the pending play
// kick), the finish handler (repeat or advance), play from the top, pause, toggle, and the speed
// picks (the live readout, a mid-play commit at a native rate, landing the picked file). Owner: I3.
import type { AudioPlayer, AudioStatus } from 'expo-audio';
import { useEffect, useEffectEvent, useLayoutEffect, useRef, type Dispatch, type RefObject, type SetStateAction } from 'react';

import type { IslandCore } from '@/hooks/island/island-core';
import type { useLadder } from '@/hooks/use-ladder';
import type { usePhrase } from '@/hooks/use-phrase';
import type { useTake } from '@/hooks/use-take';
import type * as api from '@/lib/api';
import { scheduleAudioSessionRelease, startPlayback, stopPlayback } from '@/lib/audio-mode';
import type { useT } from '@/lib/i18n';
import { FINISH_GUARD_MS, RATE_MAX, RATE_MIN } from '@/lib/island/island-consts';
import { lineEndOf } from '@/lib/island/player-timing';
import { isSpeakStep, type PassStep } from '@/lib/pass-programme';
import { setRungSpeed } from '@/lib/speed-ladder';

export type LineTick = { time: number; playing: boolean; duration: number; end: number };

// What this hook reads from useTakeRecording, which the route calls after it (it takes
// landSpeedAhead from here). The route fills the ref once that hook has returned.
export type TakeRecordingLinks = {
  startingTake: RefObject<boolean>;
  markTakeLineStart: (s: AudioStatus) => void;
};

export type LinePlaybackParams = {
  core: RefObject<IslandCore | null>;
  player: AudioPlayer;
  take: ReturnType<typeof useTake>;
  island: api.Island | null;
  status: AudioStatus;
  latestStatus: RefObject<AudioStatus>;
  sourceUri: string | null;
  speed: number;
  setSpeed: Dispatch<SetStateAction<number>>;
  setSpeedLive: Dispatch<SetStateAction<number>>;
  times: number;
  phrase: ReturnType<typeof usePhrase>;
  breathSec: number;
  playsOnce: boolean;
  echoRef: RefObject<PassStep>;
  ladderRef: RefObject<ReturnType<typeof useLadder> | null>;
  // The route's refs this hook writes carry the `Ref` suffix, so the compiler lint allows the write.
  crossedRef: RefObject<boolean>;
  lastTickRef: RefObject<LineTick | null>;
  playsDoneRef: RefObject<number>;
  audioFailShownRef: RefObject<boolean>;
  kickUriRef: RefObject<string | null>;
  speedTouchedRef: RefObject<boolean>;
  ladderEpochRef: RefObject<number>;
  ladderNextRef: RefObject<number | null>;
  // useLineStatus is called before this hook: it reads the tick handler through this ref.
  onLineStatusRef: RefObject<(s: AudioStatus) => void>;
  loadedUri: RefObject<string | null>;
  playWhenLoaded: RefObject<boolean>;
  pendingPlayRef: RefObject<boolean>;
  speedAhead: RefObject<number | null>;
  rateRef: RefObject<number>;
  takeRec: RefObject<TakeRecordingLinks | null>;
  setPendingPlay: (on: boolean) => void;
  loadSource: () => void;
  seekTop: () => Promise<void>;
  resetHighlight: () => void;
  holdHighlight: () => void;
  setError: Dispatch<SetStateAction<string>>;
  setIdx: Dispatch<SetStateAction<number>>;
  setLadderMove: Dispatch<SetStateAction<{ dir: 'up' | 'down'; speed: number } | null>>;
  setAhead: (v: number | null) => void;
  setLiveRate: (r: number) => void;
  aimEchoLine: (s: AudioStatus, force?: boolean) => void;
  applyLadderNext: () => void;
  clearDragSpan: () => void;
  t: ReturnType<typeof useT>['t'];
};

export function useLinePlayback(p: LinePlaybackParams) {
  const {
    core, player, take, island, status, latestStatus, sourceUri, speed, setSpeed, setSpeedLive, times, phrase, breathSec,
    playsOnce, echoRef, ladderRef, crossedRef, lastTickRef, playsDoneRef, audioFailShownRef, kickUriRef, speedTouchedRef,
    ladderEpochRef, ladderNextRef, onLineStatusRef, loadedUri, playWhenLoaded, pendingPlayRef, speedAhead, rateRef, takeRec,
    setPendingPlay, loadSource, seekTop, resetHighlight, holdHighlight, setError, setIdx, setLadderMove, setAhead, setLiveRate,
    aimEchoLine, applyLadderNext, clearDragSpan, t,
  } = p;

  // The line under a take has ended. A ladder take stays open for its room
  // (the hook's lineFinished: the line × 1.6 + 1.5s from the mic opening),
  // then ends after the tail scheduleStop adds; any other take ends after the tail.
  function endTakeAfterLine() {
    if (isSpeakStep(echoRef.current)) ladderRef.current?.lineFinished();
    else take.scheduleStop();
  }
  function watchLineEnd(s: AudioStatus) {
    const end = lineEndOf(s.duration, breathSec);
    if (!s.playing || end <= 0) return;
    if (s.currentTime < end) {
      crossedRef.current = false;
      return;
    }
    if (crossedRef.current) return;
    crossedRef.current = true;
    if (take.phase === 'recording') {
      stopPlayback(player);
      void player.seekTo(0);
      endTakeAfterLine();
      return;
    }
    // Played from the Explain sheet or under the starter guide: once, then
    // parked at the top of the same line, whatever Repeat says. Advancing
    // would change the line, and a line change closes the sheet.
    if (playsOnce) {
      stopPlayback(player);
      void player.seekTo(0);
      scheduleAudioSessionRelease();
      return;
    }
  }

  // Every native status of the line player lands here, 20 times a second
  // while it plays, without rendering the screen (see useLineStatus). The
  // work is what used to run in effects keyed on the position, in the same
  // order, and only when the position, playing, duration or line end
  // actually changed, as those effects would.
  function onLineStatus(s: AudioStatus) {
    // The player reports a failed load (offline, a server error) at once: say
    // so now, once per outage, instead of waiting out PENDING_PLAY_MS.
    if (s.error && !s.isLoaded && !audioFailShownRef.current) {
      audioFailShownRef.current = true;
      setPendingPlay(false);
      setError(t('player.couldNotLoadIsland'));
    }
    const end = lineEndOf(s.duration, breathSec);
    const prev = lastTickRef.current;
    if (prev && prev.time === s.currentTime && prev.playing === s.playing && prev.duration === s.duration && prev.end === end) {
      return;
    }
    lastTickRef.current = { time: s.currentTime, playing: s.playing, duration: s.duration, end };
    if (s.didJustFinish) finishUri.current = loadedUri.current;
    if (s.playing && pendingPlayRef.current) setPendingPlay(false);
    if (s.playing) kickUriRef.current = null;
    else if (s.isLoaded && s.duration > 0 && kickUriRef.current === loadedUri.current && kickUriRef.current) {
      kickUriRef.current = null;
      if (pendingPlayRef.current) startPlayback(player);
    }
    aimEchoLine(s);
    watchLineEnd(s);
    takeRec.current?.markTakeLineStart(s);
  }
  // Written at commit, like useStableHandler: the status listener only fires between renders.
  useLayoutEffect(() => {
    onLineStatusRef.current = onLineStatus;
  });

  // Every play of a whole line ends here: another play of the same line
  // while fewer than `times` are done, otherwise the next line (wrapping to
  // the first). The pad's silence has already played by now, so that is the
  // pause. A phrase's native loop repeats it until cleared, and the
  // playWhenLoaded bail-out keeps a finish from the old source from counting
  // once a line change is under way. `finishUri` is the source loaded when the
  // finish arrived: a finish that landed in the same render as a line change
  // belongs to the old line and is dropped here (a later one is dropped
  // before it renders, by isStaleStatus).
  const lastFinish = useRef(0);
  const finishUri = useRef<string | null>(null);
  // An effect event: only the finish flag re-runs it; everything else is
  // read as of that render.
  const onLineFinish = useEffectEvent(() => {
    if (!status.didJustFinish || !island || playWhenLoaded.current) return;
    if (finishUri.current !== sourceUri) return;
    const now = Date.now();
    if (now - lastFinish.current < FINISH_GUARD_MS) return;
    lastFinish.current = now;
    // With a 0s pause there is no pad after the line, so the last status can
    // arrive before lineEnd and the crossing effect above never fires. The
    // finish stands in for it: a take ends its tail from here.
    if (take.phase === 'recording') {
      if (!crossedRef.current) {
        crossedRef.current = true;
        void player.seekTo(0);
        endTakeAfterLine();
      }
      return;
    }
    // A speed picked during this play loads now, for the next play.
    const swapped = landSpeedAhead() !== null;
    // A finish that slips past the crossing stop above (or a 0s pause, which
    // has no crossing) still must not advance the line.
    if (playsOnce) {
      void player.seekTo(0);
      scheduleAudioSessionRelease();
      return;
    }
    // A ladder run: the hook takes the finish (a repeat, the next stage, or Compare's take).
    if (ladderRef.current?.active) {
      ladderRef.current.lineFinished();
      return;
    }
    if (phrase.span) return;
    playsDoneRef.current += 1;
    if (playsDoneRef.current < times || island.lines.length === 1) {
      if (playsDoneRef.current >= times) playsDoneRef.current = 0;
      // Same line again: the source stays the same, so the playWhenLoaded
      // effect never fires. Seek and play by hand instead.
      resetHighlight();
      if (swapped) {
        // The file at the picked speed starts as soon as it is swapped in.
        core.current?.setPlayWhenLoaded(true);
        return;
      }
      setPendingPlay(true);
      void (async () => {
        await seekTop();
        // Stopped during the seek: the repeat is cancelled.
        if (!pendingPlayRef.current) return;
        crossedRef.current = false;
        startPlayback(player);
      })();
      return;
    }
    playsDoneRef.current = 0;
    core.current?.setPlayWhenLoaded(true);
    resetHighlight();
    core.current?.resetForNewAudio();
    applyLadderNext();
    setIdx((i) => (i + 1) % island.lines.length);
  });
  useEffect(() => {
    onLineFinish();
  }, [status.didJustFinish]);

  // Starts the line fresh from the top, whether or not it was already
  // playing: shared by the ring's Play tap and a swipe down on the sentence.
  async function playFromTop() {
    // The source may still be waiting for the open morph's cover to go.
    loadSource();
    core.current?.dropTake();
    // A restart mid-word fades the highlight in again from the top instead
    // of snapping the lit word off.
    resetHighlight();
    if (landSpeedAhead() !== null) {
      // A speed picked during the last play: its file starts once swapped in.
      stopPlayback(player);
      crossedRef.current = false;
      playsDoneRef.current = 0;
      core.current?.setPlayWhenLoaded(true);
      return;
    }
    await seekTop();
    // A short phrase can reach lineEnd before a status below it resets this.
    crossedRef.current = false;
    // A restart counts its plays from the top again.
    playsDoneRef.current = 0;
    startPlayback(player);
  }

  // Stops the line exactly like the ring button's own Pause tap: drops any
  // take in progress and hands the audio session back. Safe to call whether
  // or not the line is actually playing. Shared by toggle and the Explain
  // sheet, which must stop the line the moment it opens.
  function pausePlayback() {
    // Pause the player first: it is the one call whose effect the user can
    // actually see and hear, so nothing here should sit in front of it.
    stopPlayback(player);
    core.current?.setPlayWhenLoaded(false);
    core.current?.dropTake();
    // Freeze the highlight where it is now: the paused status lands a moment
    // later, and running on until then could start lighting the next word.
    holdHighlight();
    scheduleAudioSessionRelease();
  }

  // Lines are short, so Play always starts the sentence from the top. There is
  // no resuming from the middle: that is never what you want when shadowing.
  async function toggle() {
    // Between two plays of a run the button shows Stop, so a tap there stops.
    const active = status.playing || pendingPlayRef.current;
    clearDragSpan();
    if (active) {
      pausePlayback();
      return;
    }
    await playFromTop();
  }

  // The Speed popover's ruler follows every step live; only used to update
  // the readout and the tile, never the audio.
  function pickSpeed(next: number) {
    speedTouchedRef.current = true;
    setSpeedLive(next);
  }

  // The Speed ruler's settle and the focus stage's speed chip. A line playing
  // carries on from where it is: the player's rate takes it to the new speed
  // over the file it has, the highlight keeps its word, and the file rendered
  // at the new speed takes over at the next play (landSpeedAhead). A take
  // (or the mic opening for one) hears nothing change until its next play.
  // Otherwise the line is re-rendered now, and a play still waiting starts
  // once it is swapped in.
  function commitSpeed(next: number) {
    speedTouchedRef.current = true;
    ladderEpochRef.current += 1;
    ladderNextRef.current = null;
    setLadderMove(null);
    if (island) void setRungSpeed(island.id, next);
    setSpeedLive(next);
    if (take.phase === 'recording' || takeRec.current?.startingTake.current) {
      setAhead(next);
      return;
    }
    const s = latestStatus.current;
    const rate = next / speed;
    if (s.playing && s.isLoaded && Number.isFinite(rate) && rate >= RATE_MIN && rate <= RATE_MAX) {
      setAhead(next);
      player.setPlaybackRate(rate, 'high');
      setLiveRate(rate);
      aimEchoLine(s, true);
      return;
    }
    if (rateRef.current !== 1) {
      player.setPlaybackRate(1, 'high');
      setLiveRate(1);
    }
    setAhead(null);
    if (next === speed) return;
    const wasActive = s.playing || pendingPlayRef.current;
    // Only a rate the player cannot take reaches here playing: re-rendered from the top, as before.
    if (s.playing) stopPlayback(player);
    core.current?.dropTake();
    core.current?.setPlayWhenLoaded(wasActive);
    core.current?.resetForNewAudio();
    setSpeed(next);
  }

  // A speed picked mid-play lands: the rate goes back to 1 and the file
  // rendered at that speed is loaded. Called where the next play starts or
  // the line stops (never under a playing line or a take). Returns the new
  // speed when the source changes, else null.
  function landSpeedAhead(): number | null {
    const next = speedAhead.current;
    if (next === null) return null;
    setAhead(null);
    if (rateRef.current !== 1) {
      player.setPlaybackRate(1, 'high');
      setLiveRate(1);
    }
    if (next === speed) return null;
    setSpeed(next);
    return next;
  }

  return { playFromTop, pausePlayback, toggle, pickSpeed, commitSpeed, landSpeedAhead };
}
