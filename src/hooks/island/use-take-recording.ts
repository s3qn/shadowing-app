// Recording on the island: beginRecording (the one start shared by a take and a speaker
// calibration), calibrateSpeaker, the take error alert and the take's line-start stamp. Owner: I2c.
// `useTake` is still the engine; it, the player and the line's values come in as params.
import type { AudioPlayer, AudioStatus } from 'expo-audio';
import { useEffect, useEffectEvent, useRef, type MutableRefObject } from 'react';

import type { IslandCore } from '@/hooks/island/island-core';
import { takeWatchSec } from '@/hooks/use-ladder';
import type { usePhrase } from '@/hooks/use-phrase';
import type { TakeMode, useTake } from '@/hooks/use-take';
import type * as api from '@/lib/api';
import { startPlayback, stopPlayback } from '@/lib/audio-mode';
import { alertSheet } from '@/lib/confirm-sheet';
import { lineEndOf } from '@/lib/island/player-timing';

export type TakeRecordingParams = {
  core: MutableRefObject<IslandCore | null>;
  take: ReturnType<typeof useTake>;
  player: AudioPlayer;
  line: api.Line | undefined;
  phrase: ReturnType<typeof usePhrase>;
  speed: number;
  lineEnd: number;
  breathSec: number;
  takeLagMs: number;
  sourceUri: string | null;
  latestStatus: MutableRefObject<AudioStatus>;
  rateRef: MutableRefObject<number>;
  // The route's `crossed` ref: the `Ref` suffix tells the compiler lint it is a ref, so the write is allowed.
  crossedRef: MutableRefObject<boolean>;
  clearDragSpan: () => void;
  clearPhrase: () => void;
  landSpeedAhead: () => number | null;
  waitForSwap: () => Promise<void>;
  seekTop: () => Promise<void>;
};

export function useTakeRecording(p: TakeRecordingParams) {
  const { core, take, player, line, phrase, speed, lineEnd, breathSec, takeLagMs, sourceUri, latestStatus, rateRef, crossedRef, clearDragSpan, clearPhrase, landSpeedAhead, waitForSwap, seekTop } = p;
  // The take is only in phase 'recording' once startTake resolves, so the pill
  // stays tappable through the permission and audio mode round trips. This
  // holds the second tap off, which would otherwise prepare the recorder again
  // and start the line twice.
  const startingTake = useRef(false);

  // Shared by startSpeak and calibrateSpeaker: only the recording mode
  // differs between a take and a speaker calibration, so both go through the
  // same cancel, close, drop, seek and play sequence and cannot drift apart.
  // `silent` records without starting the line: the take then ends on its own
  // timer in useTake instead of the line's end. `'auto'` (Speak) probes the
  // input route once the recorder starts and resolves to whichever the
  // headset check decides.
  async function beginRecording(
    mode: TakeMode,
    silent: boolean | 'auto' = false,
    room = false,
  ): Promise<{ silent: boolean } | null> {
    if (!line || startingTake.current) return null;
    startingTake.current = true;
    // A promise finally, not a try finally: the compiler does not lower those.
    const run = async () => {
      core.current?.setPlayWhenLoaded(false);
      core.current?.closePanel();
      clearDragSpan();
      // dropTake(), but waiting for the cancel: it stops a take still
      // recording and releases the session, and that must be done before the
      // new recorder is prepared rather than land under it.
      take.stopTake();
      stopPlayback(player);
      await take.cancel();
      // A speed picked mid-play that has not landed yet: the take runs over
      // the file at that speed at rate 1, so wait for it to load and time the
      // take from its own length.
      const landed = landSpeedAhead();
      if (landed !== null) await waitForSwap();
      const end = landed !== null ? lineEndOf(latestStatus.current.duration, breathSec) : lineEnd;
      await seekTop();
      // The spoken line's length (without the pad) is the watchdog's base: a
      // take that is never ended by the line stops itself a few seconds past it.
      // A calibration is always the whole line (calibrateSpeaker clears a
      // phrase first): the speaker profile is global and a slice is too short
      // to learn it from.
      const span = mode === 'calibrate' ? null : phrase.audio;
      // A ladder take (`room`) gets the ladder's room past the line instead.
      // The rate is 1 under a take (commitSpeed never changes it there), so
      // the file's length is the wall-clock length; divided anyway in case.
      const rate = rateRef.current > 0 && Number.isFinite(rateRef.current) ? rateRef.current : 1;
      const endSec = end / rate;
      const lineSec = room && endSec > 0 ? takeWatchSec(endSec) : endSec || undefined;
      const result = await take.startTake(lineSec, landed ?? speed, mode, takeLagMs, span, silent);
      if (!result) return null;
      crossedRef.current = false;
      if (!result.silent) startPlayback(player);
      return result;
    };
    return run().finally(() => {
      startingTake.current = false;
    });
  }

  // The take hook's message (microphone access off, the recorder failed, a save failed) was never
  // shown on the island: the alert sheet shows each new one once, when it lands.
  const shownTakeError = useRef(0);
  useEffect(() => {
    if (!take.error || take.errorSeq === shownTakeError.current) return;
    shownTakeError.current = take.errorSeq;
    void alertSheet(take.error);
  }, [take.error, take.errorSeq]);

  // Stamps where line time 0 sits in the take (see markLineStart) the first
  // time playback status arrives with a real position during a take, so a
  // headphone take (no echo for the backend to anchor on) can still be
  // scored.
  // Run by onLineStatus for each status, and here when the take starts.
  function markTakeLineStart(s: AudioStatus) {
    if (take.phase === 'recording' && take.mode === 'take' && s.playing && s.currentTime > 0) {
      take.markLineStart(s.currentTime);
    }
  }
  const markTakeLineStartNow = useEffectEvent(() => {
    markTakeLineStart(latestStatus.current);
  });
  useEffect(() => {
    markTakeLineStartNow();
  }, [take.phase, take.mode]);
  // A speed picked during a take loads once the take is over and the line is
  // quiet, so the next play (Compare, the final take) already has its file.
  const landAfterTake = useEffectEvent(() => {
    if (take.phase === 'recording' || startingTake.current || latestStatus.current.playing) return;
    landSpeedAhead();
  });
  useEffect(() => {
    landAfterTake();
  }, [take.phase]);

  // Calibrating with a phrase set goes back to the whole line first and
  // starts once that audio is swapped in (the effect below), so the phone
  // plays exactly the reference the backend calibrates against.
  const calibrateWhenLoaded = useRef(false);
  async function calibrateSpeaker() {
    if (phrase.span) {
      clearPhrase();
      core.current?.setPlayWhenLoaded(false);
      calibrateWhenLoaded.current = true;
      return;
    }
    await beginRecording('calibrate');
  }
  const calibrateOnLoaded = useEffectEvent(() => {
    if (!calibrateWhenLoaded.current || !sourceUri) return;
    calibrateWhenLoaded.current = false;
    void beginRecording('calibrate');
  });
  useEffect(() => {
    calibrateOnLoaded();
  }, [sourceUri]);

  return { startingTake, beginRecording, calibrateSpeaker, markTakeLineStart };
}
