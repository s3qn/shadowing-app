import {
  AudioQuality,
  getRecordingPermissionsAsync,
  IOSOutputFormat,
  requestRecordingPermissionsAsync,
  RecordingPresets,
  useAudioPlayer,
  useAudioPlayerStatus,
  useAudioRecorder,
  useAudioRecorderState,
  type RecordingOptions,
} from 'expo-audio';
import { File } from 'expo-file-system';
import { useEffect, useRef, useState } from 'react';

import { meterLevel } from '@/components/level-bars';
import { cleanTakeUrl, uploadTake, type AudioSpan } from '@/lib/api';
import {
  applyPlaybackMode,
  applyRecordingMode,
  releaseAudioSession,
  startPlayback,
  stopPlayback,
  useSessionPlayer,
} from '@/lib/audio-mode';
import { cleanTakeFile, deleteTake, findTake, saveTake, type Take } from '@/lib/takes';

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

/** What mode a recording in progress, or the most recent one, was made in. */
export type TakeMode = 'take' | 'calibrate';

/**
 * Status of the backend echo cleanup for the current take, or for a speaker
 * calibration run. `note` carries backend text: for a calibration `done` it
 * is what saved the profile ("Speaker profile saved"), which is how the row
 * tells a calibration result apart from a take result at the same state.
 */
export type CleanStatus = {
  state: 'idle' | 'working' | 'done' | 'skipped' | 'failed';
  erleDb: number | null;
  note: string;
};

const IDLE_CLEAN: CleanStatus = { state: 'idle', erleDb: null, note: '' };

// Takes are recorded as 24 kHz mono 16 bit LPCM wav so the backend cleaner
// gets the phone mic at the same rate as the cached line reference and never
// resamples either side. AAC (the HIGH_QUALITY preset) hides its own
// quantisation noise right where the cleaned signal needs to sit. If a real
// iOS device ever refuses 24000 for LPCM, the documented fallback is 44100
// with the backend resampling the take before cleaning; not needed so far.
const WAV_RECORDING_OPTIONS: RecordingOptions = {
  extension: '.wav',
  sampleRate: 24000,
  numberOfChannels: 1,
  bitRate: 384000,
  isMeteringEnabled: true,
  ios: {
    outputFormat: IOSOutputFormat.LINEARPCM,
    audioQuality: AudioQuality.MAX,
    linearPCMBitDepth: 16,
    linearPCMIsBigEndian: false,
    linearPCMIsFloat: false,
  },
  android: RecordingPresets.HIGH_QUALITY.android,
  // The app never records on web; kept only because RecordingOptions requires it.
  web: RecordingPresets.HIGH_QUALITY.web,
};

/**
 * Records the learner's own voice over one line and plays it back. A take is
 * one shot: it starts with the line, keeps recording for a second, plus the
 * lag, after the line ends, then saves. There is never more than one
 * recording in flight.
 *
 * Recording needs the `.playAndRecord` audio category, which routes playback
 * to the bottom speaker and drops the stereo mix. The `audio-mode` helpers
 * switch the mode back to plain playback as soon as a take stops or is
 * dropped, so every other screen keeps its normal loudness and speaker
 * routing, and on iOS hand the volume back to other apps once the take ends.
 *
 * Every take is also sent to the backend, which removes the played line from
 * the recording by subtracting it with a path learned from a speaker
 * calibration. The raw take is what plays, and is all that ever plays if the
 * cleanup fails, until a cleaned file comes back and takes over.
 */
export function useTake(islandId: string | undefined, idx: number, generation: number) {
  const recorder = useAudioRecorder(WAV_RECORDING_OPTIONS);
  const recorderState = useAudioRecorderState(recorder, 50);

  const [recording, setRecording] = useState(false);
  const [take, setTake] = useState<Take | null>(null);
  const [error, setError] = useState('');
  const [clean, setClean] = useState<CleanStatus>(IDLE_CLEAN);
  const [mode, setMode] = useState<TakeMode>('take');

  // keepAudioSessionActive: pausing a player tears the audio session down
  // 100ms later, and that check only looks at players, never at recorders. The
  // take player is paused right before a take starts, so without this the
  // teardown lands on the recorder that has just been prepared.
  //
  // Plays take.cleanUri once cleanTake has set it; until then, or if cleanup
  // never succeeds, this plays the raw take, which is what the source falls
  // back to.
  const takePlayer = useAudioPlayer(take ? { uri: take.cleanUri ?? take.uri } : null, {
    keepAudioSessionActive: true,
  });
  const takeStatus = useAudioPlayerStatus(takePlayer);
  useSessionPlayer(takePlayer);

  // The take (or calibration) a recording in progress belongs to, kept in a
  // ref because the tail runs after the line (and possibly the current idx,
  // the speed slider, and the lag setting) has moved on.
  const target = useRef<{
    islandId: string;
    idx: number;
    mode: TakeMode;
    speed: number;
    lagMs: number;
    span: AudioSpan | null;
  } | null>(null);
  const tail = useRef<ReturnType<typeof setTimeout> | null>(null);
  const watchdog = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Current props, read from finish() after the tail delay so it can tell
  // whether the recorded line is still the one on screen.
  const current = useRef({ islandId, idx });
  current.current = { islandId, idx };

  useEffect(() => {
    setTake(islandId ? findTake(islandId, idx) : null);
    // An error, and a clean result, belong to the line they happened on; a
    // new line starts clean.
    setError('');
    setClean(IDLE_CLEAN);
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

  /**
   * Uploads a saved take for echo cleanup and, if the backend found and
   * removed an echo, downloads the cleaned file and switches the take on
   * screen over to it. Never touches the raw take: on any failure, or when
   * the backend reports nothing to clean, the raw take is left exactly as
   * it was and keeps playing. `span`, when set, is the phrase that was
   * playing while the take was recorded, so the cleaner's reference matches it.
   */
  async function cleanTake(
    targetIslandId: string,
    targetIdx: number,
    saved: Take,
    speed: number,
    span: AudioSpan | null,
  ) {
    setClean({ state: 'working', erleDb: null, note: '' });
    try {
      const result = await uploadTake(targetIslandId, targetIdx, saved.uri, speed, false, span);
      if (!result.cleaned) {
        setClean({ state: 'skipped', erleDb: result.erleDb, note: result.note });
        return;
      }
      const downloaded = await File.downloadFileAsync(
        cleanTakeUrl(targetIslandId, targetIdx, saved.recordedAt),
        cleanTakeFile(targetIslandId, targetIdx, saved.recordedAt),
      );
      // Only adopt the cleaned file if the take on screen is still this one:
      // a new take, or a line switch and back, must not resurrect a stale
      // clean result landing after the fact.
      setTake((onScreen) =>
        onScreen && onScreen.recordedAt === saved.recordedAt ? { ...onScreen, cleanUri: downloaded.uri } : onScreen,
      );
      setClean({ state: 'done', erleDb: result.erleDb, note: result.note });
    } catch (e) {
      setClean({ state: 'failed', erleDb: null, note: e instanceof Error ? e.message : '' });
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
        if (savedFor.mode === 'calibrate') {
          try {
            const result = await uploadTake(savedFor.islandId, savedFor.idx, uri, savedFor.speed, true, savedFor.span);
            setClean({ state: 'done', erleDb: result.erleDb, note: result.note });
          } catch (e) {
            setClean({ state: 'failed', erleDb: null, note: e instanceof Error ? e.message : '' });
          }
        } else {
          try {
            const saved = await saveTake(savedFor.islandId, savedFor.idx, uri);
            if (savedFor.islandId === current.current.islandId && savedFor.idx === current.current.idx) {
              setTake(saved);
            }
            void cleanTake(savedFor.islandId, savedFor.idx, saved, savedFor.speed, savedFor.span);
          } catch (e) {
            // The previous take, if any, is untouched: saveTake only replaces
            // it after the move into place succeeds.
            setError(e instanceof Error ? e.message : 'Could not save the take.');
          }
        }
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Recording stopped unexpectedly.');
    } finally {
      setRecording(false);
      try {
        await applyPlaybackMode();
        await releaseAudioSession();
      } catch {
        // Best effort: the next take attempt or the next screen mount fixes it.
      }
    }
  }

  /**
   * Opens the microphone for a take, or for a speaker calibration recording
   * when `mode` is `'calibrate'`. `lineSeconds` is the line's own duration,
   * used only for the watchdog that ends a take the line never ends itself.
   * `speed` is carried through to `finish` in a ref, because the speed
   * slider can still move during the one second tail. `lagMs` is the
   * shadowing lag, added to the one second tail so a take is not cut while
   * the speaker is still a beat behind the line. `span` is the phrase that
   * plays under the take, passed on to the cleaner so its reference is the
   * same audio.
   */
  async function startTake(
    lineSeconds: number | undefined,
    speed: number,
    mode: TakeMode,
    lagMs = 0,
    span: AudioSpan | null = null,
  ): Promise<boolean> {
    if (!islandId) return false;
    setError('');
    let perm = await getRecordingPermissionsAsync();
    if (!perm.granted) perm = await requestRecordingPermissionsAsync();
    if (!perm.granted) {
      setError('Microphone access is off. Turn it on in Settings and try again.');
      return false;
    }
    try {
      await applyRecordingMode();
      await recorder.prepareToRecordAsync();
      recorder.record();
      target.current = { islandId, idx, mode, speed, lagMs, span };
      setMode(mode);
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
      }, lineMs + TAIL_MS + lagMs + WATCHDOG_SLACK_MS);
      setRecording(true);
      return true;
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not start recording.');
      try {
        await applyPlaybackMode();
      } catch {
        // Best effort: the mode is already broken, nothing more to try here.
      }
      return false;
    }
  }

  function scheduleStop() {
    if (!recording || tail.current) return;
    tail.current = setTimeout(finish, TAIL_MS + (target.current?.lagMs ?? 0));
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
      await applyPlaybackMode();
      await releaseAudioSession();
    } catch {
      // Best effort: the next take attempt or the next screen mount fixes it.
    }
  }

  /**
   * Deletes the current line's take from disk and from the screen. Used when
   * the phrase it was recorded over is changed or cleared, since the take no
   * longer matches the audio it would be compared with.
   */
  function discardTake() {
    stopPlayback(takePlayer);
    if (islandId) deleteTake(islandId, idx);
    setTake(null);
    setClean(IDLE_CLEAN);
  }

  function playTake() {
    if (!take) return;
    void takePlayer.seekTo(0);
    startPlayback(takePlayer);
  }

  // Safe on a take player its hook already released (a take saved or a line
  // switched just before), so callers can go on to pause the line after it.
  function stopTake() {
    stopPlayback(takePlayer);
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
    mode,
    level: recording ? meterLevel(recorderState.metering) : 0,
    take,
    takePlaying: takeStatus.playing,
    error,
    clean,
    startTake,
    scheduleStop,
    cancel,
    playTake,
    stopTake,
    discardTake,
  };
}
