import {
  type AudioStatus,
  AudioQuality,
  getRecordingPermissionsAsync,
  IOSOutputFormat,
  requestRecordingPermissionsAsync,
  RecordingPresets,
  useAudioPlayer,
  useAudioRecorder,
  type RecordingOptions,
} from 'expo-audio';
import { File } from 'expo-file-system';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useSharedValue } from 'react-native-reanimated';

import { meterLevel } from '@/components/level-bars';
import { useLineStatus } from '@/hooks/use-line-status';
import { cleanTakeUrl, uploadTake, type AudioSpan } from '@/lib/api';
import {
  applyPlaybackMode,
  applyRecordingMode,
  scheduleAudioSessionRelease,
  startPlayback,
  stopPlayback,
  useSessionPlayer,
} from '@/lib/audio-mode';
import { addPass } from '@/lib/practice';
import { cleanTakeFile, deleteTake, findTake, saveTake, saveTakeAnalysis, saveTakeScore, type Take } from '@/lib/takes';

/** How often the recorder's meter is sampled into the level shared value. */
const METER_MS = 50;

// Exported so the Auto Echo sheet's Speak fill can aim at the same expected
// take length this hook's own watchdog uses, instead of a second guess.
export const TAIL_MS = 1000;
// Nothing but the line's own finish event stops a take, and that event does
// not always come: an audio session interruption (a call, Siri, an alarm)
// pauses the recorder silently, and a line that stalls on the tunnel never
// finishes at all. A take therefore also stops itself after the line's own
// length plus the tail plus room for buffering.
const WATCHDOG_SLACK_MS = 5000;
// Used when the line's duration is not known yet. Lines are one sentence.
export const WATCHDOG_FALLBACK_MS = 30000;
// How long after a line change its take is read from disk: past the line
// change's render and the new sentence's rise, so the read never lands in it.
const FIND_TAKE_DELAY_MS = 450;

export type TakePhase = 'idle' | 'recording' | 'ready';

/** What mode a recording in progress, or the most recent one, was made in. */
export type TakeMode = 'take' | 'calibrate';

// Input route types that mean an actual headset mic, checked as an allowlist
// rather than a blocklist: CarAudio, LineIn and Bluetooth car kits must count
// as no headset (line plays out loud into the phone mic), not fall through as
// one just because they are not the built-in mic. Exact strings expo-audio
// reports: iOS returns the raw AVAudioSession.Port value ('MicrophoneWired'
// for a wired headset mic, 'BluetoothHFP' for a Bluetooth headset, 'USBAudio'
// for USB audio; node_modules/expo-audio/ios/AudioUtils.swift). Android maps
// AudioDeviceInfo.TYPE_WIRED_HEADSET to the same 'MicrophoneWired' string and
// TYPE_BLUETOOTH_SCO to 'BluetoothSCO', with everything else (including USB
// and car audio) falling through to 'Unknown device type'
// (node_modules/expo-audio/android/.../AudioUtils.kt). Known limit: on
// Android only a 3.5 mm headset with a mic reports as a headset today; USB-C
// and Bluetooth need setInput with SCO forced on, a later task.
const HEADSET_INPUTS = new Set(['MicrophoneWired', 'BluetoothHFP', 'USBAudio', 'BluetoothSCO']);

// Remembered for the app run so reopening an island after a headset probe
// does not show the no-headset nudge to someone still wearing them.
let lastHeadset: boolean | null = null;

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
export function useTake(
  islandId: string | undefined,
  idx: number,
  generation: number,
  /** Delays the first disk read (it returns a cancel): the player passes the
   * open morph's cover-gone here, so the read stays out of the landing. */
  firstReadAfter?: (run: () => void) => () => void,
  /** Runs for every take player status update (each 50ms position tick
   * while a take plays) without a render; the screen aims the Auto Echo
   * Play fill from it. */
  onStatus?: (s: AudioStatus) => void,
) {
  const recorder = useAudioRecorder(WAV_RECORDING_OPTIONS);

  const [recording, setRecording] = useState(false);

  // Live meter level, 0..1, written from a timer and read on the UI thread
  // by the dock glow, the ripples and the level bars. A shared value so a
  // meter sample never renders the screen.
  const level = useSharedValue(0);
  useEffect(() => {
    if (!recording) {
      level.value = 0;
      return;
    }
    const timer = setInterval(() => {
      try {
        level.value = meterLevel(recorder.getStatus().metering);
      } catch {
        // The recorder is released on unmount before this cleanup runs.
        level.value = 0;
      }
    }, METER_MS);
    return () => {
      clearInterval(timer);
      level.value = 0;
    };
  }, [recording, recorder, level]);
  const [mode, setMode] = useState<TakeMode>('take');
  const [headset, setHeadset] = useState<boolean | null>(lastHeadset);

  // Everything below belongs to one line of one generation. The take, an
  // error and a clean result are each stored with the key of the line they
  // happened on and read only while that line is on screen, so a line change
  // resets them without setting any state (which would render the whole
  // player screen a second time right after the change).
  const lineKey = `${islandId ?? ''}:${idx}:${generation}`;
  const lineKeyRef = useRef(lineKey);
  lineKeyRef.current = lineKey;

  // The newest take per line key, read from disk once per line and kept up
  // to date by every save, score, clean and discard after that. A key with no
  // entry has not been read yet.
  const takes = useRef(new Map<string, Take | null>());
  const [, setTakesTick] = useState(0);
  const firstReadDone = useRef(false);
  const take = takes.current.get(lineKey) ?? null;
  function updateTake(key: string, fn: (onScreen: Take | null) => Take | null) {
    // Not read from disk yet: the file this update describes is already on
    // disk, and the read picks it up.
    if (!takes.current.has(key)) return;
    const prev = takes.current.get(key) ?? null;
    const next = fn(prev);
    if (next === prev) return;
    takes.current.set(key, next);
    setTakesTick((n) => n + 1);
  }
  function putTake(key: string, next: Take | null) {
    takes.current.set(key, next);
    setTakesTick((n) => n + 1);
  }

  const [errorState, setErrorState] = useState({ key: '', message: '' });
  const error = errorState.key === lineKey ? errorState.message : '';
  function setError(message: string) {
    const key = lineKeyRef.current;
    setErrorState((cur) => (cur.message === message && (cur.key === key || !message) ? cur : { key, message }));
  }
  const [cleanState, setCleanState] = useState<{ key: string; clean: CleanStatus }>({ key: '', clean: IDLE_CLEAN });
  const clean = cleanState.key === lineKey ? cleanState.clean : IDLE_CLEAN;
  function setClean(next: CleanStatus, key = lineKeyRef.current) {
    setCleanState({ key, clean: next });
  }

  // ONE take player for the screen's whole life, like the line player: a new
  // take swaps its source with replace() (the effect below). Handing the
  // source to useAudioPlayer releases the native player and builds a new one
  // on every line change where either line has a take.
  //
  // keepAudioSessionActive: pausing a player tears the audio session down
  // 100ms later, and that check only looks at players, never at recorders. The
  // take player is paused right before a take starts, so without this the
  // teardown lands on the recorder that has just been prepared.
  const takePlayer = useAudioPlayer(null, { keepAudioSessionActive: true });
  // Read through a ref so the listener is subscribed once per player and
  // still calls this render's handler.
  const onStatusRef = useRef(onStatus);
  useLayoutEffect(() => {
    onStatusRef.current = onStatus;
  });
  // The screen renders only when the take loads or its playing flag flips,
  // not on each position tick: the status committed on the playing flip
  // carries the duration the play-end result needs.
  const { status: takeStatus } = useLineStatus(
    takePlayer,
    (s) => onStatusRef.current?.(s),
    (s) => `${s.isLoaded}:${s.playing}`,
  );
  useSessionPlayer(takePlayer);

  // Plays take.cleanUri once cleanTake has set it; until then, or if cleanup
  // never succeeds, this plays the raw take, which is what the source falls
  // back to.
  const takeUri = take ? (take.cleanUri ?? take.uri) : null;
  // The uri the native player holds (last handed to replace()), and the one
  // it has reported loaded. The player's status keeps the previous take's
  // values until the new item reports, so `takeLoaded` only reads true once
  // `readyUri` is this take.
  const loadedTakeUri = useRef<string | null>(null);
  const [readyUri, setReadyUri] = useState<string | null>(null);
  useEffect(() => {
    // No take on this line: the old item stays loaded but unreachable, since
    // playTake needs a take and takeLoaded needs this take's uri. Coming back
    // to that same take then needs no swap at all.
    if (!takeUri || takeUri === loadedTakeUri.current) return;
    loadedTakeUri.current = takeUri;
    setReadyUri(null);
    // A new source never starts on its own: a cleaned file landing while the
    // raw take plays would otherwise carry on from the top of the new file.
    stopPlayback(takePlayer);
    try {
      takePlayer.replace({ uri: takeUri });
    } catch {
      // The screen is unmounting and the player is already released.
    }
  }, [takeUri, takePlayer]);
  useEffect(() => {
    const sub = takePlayer.addListener('playbackStatusUpdate', (s) => {
      const uri = loadedTakeUri.current;
      // `isLoaded` on the player itself is the current item's, so a status the
      // previous item sent before the swap cannot mark the new one ready.
      if (!uri || !s.isLoaded) return;
      try {
        if (takePlayer.isLoaded) setReadyUri(uri);
      } catch {
        // Released: nothing to mark.
      }
    });
    return () => sub.remove();
  }, [takePlayer]);
  const takeReady = !!takeUri && readyUri === takeUri;

  // The take (or calibration) a recording in progress belongs to, kept in a
  // ref because the tail runs after the line (and possibly the current idx,
  // the speed slider, and the lag setting) has moved on.
  const target = useRef<{
    key: string;
    islandId: string;
    idx: number;
    mode: TakeMode;
    speed: number;
    lagMs: number;
    span: AudioSpan | null;
    recordStartedAt: number;
    lineStartMs: number | null;
    silent: boolean;
  } | null>(null);
  const tail = useRef<ReturnType<typeof setTimeout> | null>(null);
  const watchdog = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Bumped each time a recording is about to open. A finish() still saving
  // an older take compares against it, so it never switches the session back
  // to playback, or clears `recording`, under a take started after it.
  const takeSeq = useRef(0);

  // Reads a line's take from disk the first time the line shows, a moment
  // after the line change (FIND_TAKE_DELAY_MS), so the folder listing and
  // score JSON reads never sit inside its render. Anything saved for the line
  // in the meantime already filled the entry, and wins.
  useEffect(() => {
    const key = lineKey;
    if (takes.current.has(key)) return;
    if (!islandId) {
      takes.current.set(key, null);
      return;
    }
    const read = () => {
      if (takes.current.has(key)) return;
      const found = findTake(islandId, idx);
      if (takes.current.has(key)) return;
      if (found === null) {
        // Nothing on disk reads the same as not read yet: no render for it.
        takes.current.set(key, null);
        return;
      }
      putTake(key, found);
    };
    if (firstReadAfter && !firstReadDone.current) {
      return firstReadAfter(() => {
        firstReadDone.current = true;
        read();
      });
    }
    const timer = setTimeout(read, FIND_TAKE_DELAY_MS);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lineKey]);

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
   * playing while the take was recorded, so the cleaner's reference matches
   * it. `lagMs` and `lineStartMs` feed the take's timing score; the score,
   * when the backend returns one, is saved and set on the take on screen
   * whether or not the take itself turned out cleanable.
   */
  async function cleanTake(
    key: string,
    targetIslandId: string,
    targetIdx: number,
    saved: Take,
    speed: number,
    span: AudioSpan | null,
    lagMs: number,
    lineStartMs: number | null,
    seq: number,
  ) {
    // The clean status only describes the latest take: a newer take already
    // recording, or saved, owns it.
    const latest = () => seq === takeSeq.current;
    setClean({ state: 'working', erleDb: null, note: '' }, key);
    try {
      const result = await uploadTake(targetIslandId, targetIdx, saved.uri, speed, false, span, lagMs, lineStartMs);
      if (result.score) {
        const score = result.score;
        try {
          saveTakeScore(targetIslandId, targetIdx, saved.recordedAt, score);
        } catch {
          // Best effort: the marks just won't survive a line switch and back.
        }
        // Same recordedAt guard as the cleanUri update below: a new take, or
        // a line switch and back, must not resurrect a stale score.
        updateTake(key, (onScreen) =>
          onScreen && onScreen.recordedAt === saved.recordedAt ? { ...onScreen, score } : onScreen,
        );
      }
      if (result.analysis) {
        // The wire payload still carries `curve` (two 10ms point lists): the
        // row draws per mora instead, so strip it before it reaches disk or
        // state and neither the saved file nor a re-render carries it.
        const { note, aligned, coverage, moras } = result.analysis;
        const analysis = { note, aligned, coverage, moras };
        try {
          saveTakeAnalysis(targetIslandId, targetIdx, saved.recordedAt, analysis);
        } catch {
          // Best effort: the row just won't survive a line switch and back.
        }
        // Same recordedAt guard as the score update above: a new take, or a
        // line switch and back, must not resurrect a stale analysis.
        updateTake(key, (onScreen) =>
          onScreen && onScreen.recordedAt === saved.recordedAt ? { ...onScreen, analysis } : onScreen,
        );
      }
      if (!result.cleaned) {
        if (latest()) setClean({ state: 'skipped', erleDb: result.erleDb, note: result.note }, key);
        return;
      }
      const downloaded = await File.downloadFileAsync(
        cleanTakeUrl(targetIslandId, targetIdx, saved.recordedAt),
        cleanTakeFile(targetIslandId, targetIdx, saved.recordedAt),
      );
      // Only adopt the cleaned file if the take on screen is still this one:
      // a new take, or a line switch and back, must not resurrect a stale
      // clean result landing after the fact.
      updateTake(key, (onScreen) =>
        onScreen && onScreen.recordedAt === saved.recordedAt ? { ...onScreen, cleanUri: downloaded.uri } : onScreen,
      );
      if (latest()) setClean({ state: 'done', erleDb: result.erleDb, note: result.note }, key);
    } catch (e) {
      if (latest()) setClean({ state: 'failed', erleDb: null, note: e instanceof Error ? e.message : '' }, key);
    }
  }

  async function finish() {
    clearTimers();
    const savedFor = target.current;
    target.current = null;
    const seq = takeSeq.current;
    try {
      await recorder.stop();
      const uri = recorder.uri;
      if (savedFor && uri) {
        if (savedFor.mode === 'calibrate') {
          try {
            const result = await uploadTake(savedFor.islandId, savedFor.idx, uri, savedFor.speed, true, savedFor.span);
            setClean({ state: 'done', erleDb: result.erleDb, note: result.note }, savedFor.key);
          } catch (e) {
            setClean({ state: 'failed', erleDb: null, note: e instanceof Error ? e.message : '' }, savedFor.key);
          }
        } else {
          try {
            const saved = await saveTake(savedFor.islandId, savedFor.idx, uri);
            // Stored for the line it was recorded on, which shows it only
            // while that line is on screen.
            putTake(savedFor.key, saved);
            if (savedFor.silent) {
              // A silent take never plays the line (island/[id].tsx only
              // startPlayback(player)s the line when the take is not
              // silent), so usePracticeClock's didJustFinish listener on
              // that same line player never fires for it and this is the
              // only place its pass is counted. A non-silent take does play
              // the line, and that listener already adds the pass when it
              // finishes: adding one here too would count the same take
              // twice.
              addPass(savedFor.islandId);
              // It also has no line in it to remove, and nothing to time
              // the words against, so it is not uploaded and has no score.
              if (seq === takeSeq.current) setClean({ state: 'skipped', erleDb: null, note: '' }, savedFor.key);
              return;
            }
            void cleanTake(
              savedFor.key,
              savedFor.islandId,
              savedFor.idx,
              saved,
              savedFor.speed,
              savedFor.span,
              savedFor.lagMs,
              savedFor.lineStartMs,
              seq,
            );
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
      // A take started while this one was still saving (Auto Echo's Retry)
      // owns the session and `recording` now; leave both to it.
      if (seq === takeSeq.current) {
        try {
          await applyPlaybackMode();
          scheduleAudioSessionRelease();
        } catch {
          // Best effort: the next take attempt or the next screen mount fixes it.
        }
        // Set after the session is back in playback mode, so a caller watching
        // phase turn to 'ready' (Auto Echo's Play step) never starts the take
        // player while the session is still routed for recording. Checked
        // again because a newer take can start during the awaits above.
        if (seq === takeSeq.current) setRecording(false);
      }
    }
  }

  /**
   * Ends a take immediately, skipping the tail delay. Used when the learner
   * taps Stop by hand (Auto Echo's Speak step): the recording is kept and
   * saved exactly as `finish()` would after the tail, just without the wait.
   */
  function finishNow() {
    // No target means finish() already runs (the tail fired, or Stop was
    // tapped twice): stopping the recorder again would race its save.
    if (!recording || !target.current) return;
    void finish();
  }

  /**
   * Reads the recorder's current input route and reports whether it is a
   * headset mic (wired, Bluetooth or USB) rather than the phone's own mic.
   * Valid only once the recorder is actually recording, on both platforms.
   * Any throw (older Android, a route that fails to report) counts as no
   * headset: a false negative here means a silent Speak, never bleed.
   */
  async function probeHeadset(): Promise<boolean> {
    let isHeadset = false;
    try {
      const input = await recorder.getCurrentInput();
      isHeadset = HEADSET_INPUTS.has(input.type);
    } catch {
      isHeadset = false;
    }
    lastHeadset = isHeadset;
    setHeadset(isHeadset);
    return isHeadset;
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
   * same audio. `silent` means the line is not played under the take: the
   * take then stops itself after the line's length plus the tail and lag,
   * and is saved without cleanup or a score. `'auto'` probes the input route
   * right after the recorder starts: a headset resolves to `silent = false`,
   * anything else to `silent = true`. Resolves to `{ silent }` describing
   * what was actually used, or `null` if the take never started.
   */
  async function startTake(
    lineSeconds: number | undefined,
    speed: number,
    mode: TakeMode,
    lagMs = 0,
    span: AudioSpan | null = null,
    silent: boolean | 'auto' = false,
  ): Promise<{ silent: boolean } | null> {
    if (!islandId) return null;
    setError('');
    let perm = await getRecordingPermissionsAsync();
    if (!perm.granted) perm = await requestRecordingPermissionsAsync();
    if (!perm.granted) {
      setError('Microphone access is off. Turn it on in Settings and try again.');
      return null;
    }
    takeSeq.current += 1;
    try {
      await applyRecordingMode();
      await recorder.prepareToRecordAsync();
      recorder.record();
      const recordStartedAt = Date.now();
      const isSilent = silent === 'auto' ? !(await probeHeadset()) : silent;
      target.current = { key: lineKey, islandId, idx, mode, speed, lagMs, span, recordStartedAt, lineStartMs: null, silent: isSilent };
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
      // No line end will call scheduleStop, so the take ends at the length
      // it would have had with the line playing.
      if (isSilent) {
        tail.current = setTimeout(() => {
          tail.current = null;
          void finish();
        }, lineMs + TAIL_MS + lagMs);
      }
      setRecording(true);
      return { silent: isSilent };
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not start recording.');
      try {
        await applyPlaybackMode();
      } catch {
        // Best effort: the mode is already broken, nothing more to try here.
      }
      return null;
    }
  }

  /**
   * Records where line time 0 sits in the take, for a take with no echo to
   * anchor the score on (earphones): `currentTimeSec` is the player's
   * position when this first fires after the line starts, so `Date.now()`
   * minus how long the recorder has been running minus that position is
   * when the line itself began. Only the first call for a take counts; a
   * take with no target, or one that already has a mark, is a no-op.
   */
  function markLineStart(currentTimeSec: number) {
    const t = target.current;
    if (!t || t.lineStartMs !== null) return;
    const elapsedMs = Date.now() - t.recordStartedAt;
    const lineStartMs = elapsedMs - currentTimeSec * 1000;
    // A `currentTime` still carrying the pre-seek position reads too large
    // here and would go negative: skip it and let a later, fresher status
    // update set the mark instead of clamping to a wrong 0.
    if (lineStartMs < 0) return;
    t.lineStartMs = lineStartMs;
  }

  function scheduleStop() {
    if (!recording || tail.current) return;
    tail.current = setTimeout(finish, TAIL_MS + (target.current?.lagMs ?? 0));
  }

  async function cancel() {
    clearTimers();
    // A target means a recording is open even when this closure is from a
    // render before startTake resolved, where `recording` still reads false.
    if (!recording && !target.current) return;
    try {
      await recorder.stop();
    } catch {
      // Nothing to keep either way.
    }
    target.current = null;
    setRecording(false);
    try {
      await applyPlaybackMode();
      scheduleAudioSessionRelease();
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
    putTake(lineKey, null);
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
    headset,
    level,
    take,
    takePlaying: takeStatus.playing,
    // The status keeps the previous item's values until the new take (or its
    // cleaned file) reports, so it counts only once readyUri is this take.
    takeLoaded: takeReady && takeStatus.isLoaded,
    takeDuration: takeReady ? takeStatus.duration : 0,
    error,
    clean,
    startTake,
    scheduleStop,
    markLineStart,
    cancel,
    finishNow,
    playTake,
    stopTake,
    discardTake,
  };
}
