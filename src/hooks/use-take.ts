import {
  getRecordingPermissionsAsync,
  requestRecordingPermissionsAsync,
  RecordingPresets,
  setAudioModeAsync,
  useAudioPlayer,
  useAudioPlayerStatus,
  useAudioRecorder,
  useAudioRecorderState,
} from 'expo-audio';
import { useEffect, useRef, useState } from 'react';

import { meterLevel } from '@/components/level-bars';
import { findTake, saveTake, type Take } from '@/lib/takes';

const TAIL_MS = 1000;
// Nothing but the line's own finish event stops a take, and that event does
// not always come: an audio session interruption (a call, Siri, an alarm)
// pauses the recorder silently, and a line that stalls on the tunnel never
// finishes at all. A take therefore also stops itself after the line's own
// length plus the tail plus room for buffering.
const WATCHDOG_SLACK_MS = 5000;
// Used when the line's duration is not known yet. Lines are one sentence.
const WATCHDOG_FALLBACK_MS = 30000;

export type TakePhase = 'idle' | 'recording' | 'ready';

/**
 * Records the learner's own voice over one line and plays it back. A take is
 * one shot: it starts with the line, keeps recording for a second after the
 * line ends, then saves. There is never more than one recording in flight.
 *
 * Recording needs the `.playAndRecord` audio category, which routes playback
 * to the bottom speaker and drops the stereo mix. The mode is switched back
 * to plain playback as soon as a take stops or is dropped, so every other
 * screen keeps its normal loudness and speaker routing.
 */
export function useTake(islandId: string | undefined, idx: number, generation: number) {
  const recorder = useAudioRecorder({ ...RecordingPresets.HIGH_QUALITY, isMeteringEnabled: true });
  const recorderState = useAudioRecorderState(recorder, 50);

  const [recording, setRecording] = useState(false);
  const [take, setTake] = useState<Take | null>(null);
  const [error, setError] = useState('');

  // keepAudioSessionActive: pausing a player tears the audio session down
  // 100ms later, and that check only looks at players, never at recorders. The
  // take player is paused right before a take starts, so without this the
  // teardown lands on the recorder that has just been prepared.
  const takePlayer = useAudioPlayer(take ? { uri: take.uri } : null, { keepAudioSessionActive: true });
  const takeStatus = useAudioPlayerStatus(takePlayer);

  // The take a recording in progress belongs to, kept in a ref because the
  // tail runs after the line (and possibly the current idx) has moved on.
  const target = useRef<{ islandId: string; idx: number } | null>(null);
  const tail = useRef<ReturnType<typeof setTimeout> | null>(null);
  const watchdog = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Current props, read from finish() after the tail delay so it can tell
  // whether the recorded line is still the one on screen.
  const current = useRef({ islandId, idx });
  current.current = { islandId, idx };

  useEffect(() => {
    setTake(islandId ? findTake(islandId, idx) : null);
    // An error belongs to the line it happened on; a new line starts clean.
    setError('');
  }, [islandId, idx, generation]);

  function clearTimers() {
    if (tail.current) {
      clearTimeout(tail.current);
      tail.current = null;
    }
    if (watchdog.current) {
      clearTimeout(watchdog.current);
      watchdog.current = null;
    }
  }

  async function finish() {
    clearTimers();
    const savedFor = target.current;
    target.current = null;
    try {
      await recorder.stop();
      const uri = recorder.uri;
      if (savedFor && uri) {
        try {
          const saved = await saveTake(savedFor.islandId, savedFor.idx, uri);
          if (savedFor.islandId === current.current.islandId && savedFor.idx === current.current.idx) {
            setTake(saved);
          }
        } catch (e) {
          // The previous take, if any, is untouched: saveTake only replaces
          // it after the move into place succeeds.
          setError(e instanceof Error ? e.message : 'Could not save the take.');
        }
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Recording stopped unexpectedly.');
    } finally {
      setRecording(false);
      try {
        await setAudioModeAsync({ playsInSilentMode: true, allowsRecording: false });
      } catch {
        // Best effort: the next take attempt or the next screen mount fixes it.
      }
    }
  }

  /**
   * Opens the microphone for a take. `lineSeconds` is the line's own duration,
   * used only for the watchdog that ends a take the line never ends itself.
   */
  async function startTake(lineSeconds?: number): Promise<boolean> {
    if (!islandId) return false;
    setError('');
    let perm = await getRecordingPermissionsAsync();
    if (!perm.granted) perm = await requestRecordingPermissionsAsync();
    if (!perm.granted) {
      setError('Microphone access is off. Turn it on in Settings and try again.');
      return false;
    }
    try {
      await setAudioModeAsync({ playsInSilentMode: true, allowsRecording: true });
      await recorder.prepareToRecordAsync();
      recorder.record();
      target.current = { islandId, idx };
      // Nothing else should be pending here, but a leftover timer would end
      // this take early.
      clearTimers();
      const lineMs =
        lineSeconds !== undefined && Number.isFinite(lineSeconds) && lineSeconds > 0
          ? lineSeconds * 1000
          : WATCHDOG_FALLBACK_MS;
      watchdog.current = setTimeout(() => {
        watchdog.current = null;
        void finish();
      }, lineMs + TAIL_MS + WATCHDOG_SLACK_MS);
      setRecording(true);
      return true;
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not start recording.');
      try {
        await setAudioModeAsync({ playsInSilentMode: true, allowsRecording: false });
      } catch {
        // Best effort: the mode is already broken, nothing more to try here.
      }
      return false;
    }
  }

  function scheduleStop() {
    if (!recording || tail.current) return;
    tail.current = setTimeout(finish, TAIL_MS);
  }

  async function cancel() {
    clearTimers();
    if (!recording) return;
    try {
      await recorder.stop();
    } catch {
      // Nothing to keep either way.
    }
    target.current = null;
    setRecording(false);
    try {
      await setAudioModeAsync({ playsInSilentMode: true, allowsRecording: false });
    } catch {
      // Best effort: the next take attempt or the next screen mount fixes it.
    }
  }

  function playTake() {
    if (!take) return;
    void takePlayer.seekTo(0);
    takePlayer.play();
  }

  function stopTake() {
    takePlayer.pause();
  }

  // The unmount cleanup below keeps the closure from the render that mounted
  // the hook, where `recording` is still false and cancel() returns at once.
  // It has to reach the current cancel through a ref to restore the audio mode
  // when the screen is left in the middle of a take.
  const cancelRef = useRef(cancel);
  cancelRef.current = cancel;

  useEffect(() => {
    return () => {
      void cancelRef.current();
    };
  }, []);

  const phase: TakePhase = recording ? 'recording' : take ? 'ready' : 'idle';

  return {
    phase,
    level: recording ? meterLevel(recorderState.metering) : 0,
    take,
    takePlaying: takeStatus.playing,
    error,
    startTake,
    scheduleStop,
    cancel,
    playTake,
    stopTake,
  };
}
