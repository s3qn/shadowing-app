import { type AudioPlayer, setAudioModeAsync, setIsAudioActiveAsync } from 'expo-audio';
import { useEffect } from 'react';
import { AppState, Platform } from 'react-native';

// Native `AudioMode` records default every missing key (Swift
// `AudioRecords.swift`: `shouldPlayInBackground = false`), so a partial call
// to setAudioModeAsync anywhere would silently turn background playback off
// again. The two helpers below are the only callers of setAudioModeAsync in
// the app; every screen goes through one of them instead of calling it
// directly.

const BASE = {
  playsInSilentMode: true,
  shouldPlayInBackground: true,
  // Other apps' audio dips under a line and comes back; it is never stopped.
  interruptionMode: 'duckOthers',
} as const;

/** Playback only: lines, words, takes, previews. Keeps playing when the app is backgrounded. */
export function applyPlaybackMode(): Promise<void> {
  recordingOpen = false;
  return setAudioModeAsync({ ...BASE, allowsRecording: false });
}

/** Microphone open: a take, a calibration, a new island. Recording never runs in the background
 * (allowsBackgroundRecording stays false, so the OS pauses the recorder on its own). */
export function applyRecordingMode(): Promise<void> {
  cancelAudioSessionRelease();
  recordingOpen = true;
  return setAudioModeAsync({ ...BASE, allowsRecording: true });
}

// Deactivating the session pauses every player natively, and a release is
// often requested a moment before a new play() (a cancel that awaits the
// recorder first, an effect racing a Compare). So the release is guarded by
// what JS knows: `live` holds every mounted player, `starting` the ones asked
// to play that have not reported `playing` yet (native `playing` stays false
// while a stream buffers, so it alone cannot tell). The release is skipped if
// any live player is playing or starting, checked right before the native
// call. The native call itself runs on a queue, so a play() requested while it
// is in flight waits for it to settle and then reactivates the session.
const live = new Set<AudioPlayer>();
const starting = new Set<AudioPlayer>();
let inflight: Promise<void> | null = null;
// Set between applyRecordingMode and applyPlaybackMode: a deferred release
// never fires into an open microphone.
let recordingOpen = false;

function isPlaying(player: AudioPlayer): boolean {
  try {
    return player.playing;
  } catch {
    // Already released by its hook: it cannot be playing.
    return false;
  }
}

/** Registers a player with the release guard for as long as it is mounted. Every useAudioPlayer in the app calls this. */
export function useSessionPlayer(player: AudioPlayer): void {
  useEffect(() => {
    live.add(player);
    const sub = player.addListener('playbackStatusUpdate', (s) => {
      if (s.playing || s.didJustFinish || s.error) starting.delete(player);
    });
    return () => {
      sub.remove();
      live.delete(player);
      starting.delete(player);
    };
  }, [player]);
}

/** Use instead of player.play(), so a release in flight cannot pause it. */
export function startPlayback(player: AudioPlayer): void {
  cancelAudioSessionRelease();
  starting.add(player);
  const play = () => {
    // Stopped, or its hook released it, while waiting for the release.
    if (!starting.has(player)) return;
    try {
      player.play();
    } catch {
      // Released while waiting: its screen or source is gone.
      starting.delete(player);
    }
  };
  if (inflight) void inflight.then(play);
  else play();
}

/** Use instead of player.pause(). Never throws on a player its hook already released. */
export function stopPlayback(player: AudioPlayer): void {
  starting.delete(player);
  try {
    player.pause();
  } catch {
    // Already released: nothing is playing.
  }
}

/**
 * Hands the volume back to other apps once nothing of ours should be playing.
 * Android releases audio focus by itself when the last player stops. iOS keeps
 * the session (and the duck) until it is deactivated, and keepAudioSessionActive
 * stops expo-audio doing that on pause, so it is done here. Deactivating also
 * pauses every player, so it is skipped while any player is playing or
 * starting (see above). The next play() or prepareToRecordAsync() reactivates
 * the session on its own.
 */
export function releaseAudioSession(): Promise<void> {
  if (Platform.OS !== 'ios') return Promise.resolve();
  if (inflight) return inflight;
  if (starting.size > 0) return Promise.resolve();
  for (const p of live) if (isPlaying(p)) return Promise.resolve();
  cancelAudioSessionRelease();
  inflight = setIsAudioActiveAsync(false)
    .catch(() => {})
    .finally(() => {
      inflight = null;
    });
  return inflight;
}

// Deactivating the session right after a pause blocks the iOS main thread for
// about 600ms while the player is still stopping, which lands on the tap that
// stopped it. So a stop asks for a release a few seconds later instead: other
// apps' audio comes back within that time, and a play or a recording started
// meanwhile cancels it. Leaving a screen still releases at once, and going to
// the background shortens a pending release to a moment.
const RELEASE_DELAY_MS = 6000;
const BACKGROUND_RELEASE_DELAY_MS = 500;
let releaseTimer: ReturnType<typeof setTimeout> | null = null;

/** Releases the session after `delayMs`, resetting any release already scheduled.
 * The release stays guarded exactly like releaseAudioSession(). */
export function scheduleAudioSessionRelease(delayMs = RELEASE_DELAY_MS): void {
  if (Platform.OS !== 'ios') return;
  cancelAudioSessionRelease();
  // In the background the app is suspended soon, and a timer may never fire.
  const ms = AppState.currentState === 'background' ? Math.min(delayMs, BACKGROUND_RELEASE_DELAY_MS) : delayMs;
  releaseTimer = setTimeout(() => {
    releaseTimer = null;
    if (recordingOpen) return;
    void releaseAudioSession();
  }, ms);
}

/** Drops a release scheduled by scheduleAudioSessionRelease(), if any. */
export function cancelAudioSessionRelease(): void {
  if (releaseTimer === null) return;
  clearTimeout(releaseTimer);
  releaseTimer = null;
}

AppState.addEventListener('change', (state) => {
  if (state === 'background' && releaseTimer !== null) scheduleAudioSessionRelease(BACKGROUND_RELEASE_DELAY_MS);
});
