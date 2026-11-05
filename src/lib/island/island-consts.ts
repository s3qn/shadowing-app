import { Platform } from 'react-native';

// Expo Go on Android does not ship the AudioControlsService, and activating
// the lock screen there logs a service binding error; a dev build has it
// through the expo-audio config plugin. With the app's `duckOthers` mode iOS
// never hands Now Playing to a mixable session, so on iOS this shows nothing
// until the mode is `doNotMix`; the calls below stay in place because that
// switch is then a one-line change in audio-mode.ts.
export const lockScreen = Platform.OS === 'ios';

// How long Auto Echo holds on a finished line before moving on, so its score
// and the XP it paid have time to be seen.
export const ECHO_RESULT_HOLD_MS = 1400;
// bl58-easy-for-me: Auto Echo's hold while the 90+ offer is up, and the Easy glide (E4: the line sinks into the water).
export const EASY_OFFER_HOLD_MS = 4000;
export const EASY_GLIDE_MS = 450;
// How many lines of dim context the ladder stage shows on each side of the current one.
export const CONTEXT_LINES = 2;
// auto-practice: how long the next island's title shows before the chain moves on.
export const AUTO_NEXT_HOLD_MS = 1400;
// auto-practice: the longest the loader stands in for a session's player before its stage is up.
export const OPEN_HOLD_MAX_MS = 6000;

// The exported file keeps its own breath between plays, whatever the player's
// Pause is set to.
export const EXPORT_GAP_MS = 2000;

// A take's tail grows by the pause, but never more than the old Lag's 1s: a
// long pause is time between plays, not a slower take.
export const TAKE_LAG_MAX_MS = 1000;

// Two finish events this close together are one ending reported twice (a
// phrase's native loop can do that at the wrap). Shorter than any line.
export const FINISH_GUARD_MS = 250;
// How long the ring button keeps showing Stop for a play that was asked for
// but never started (a source that fails to load).
export const PENDING_PLAY_MS = 8000;
// How long after a source swap a status still carrying the old source's
// duration is read as the old source's, delivered late.
export const SWAP_STALE_MS = 2000;
// After the open morph's cover is gone, how long the transcript stays narrow.
export const TRANSCRIPT_WIDEN_MS = 150;
// After the open morph's cover is gone, how long the first take read waits.
export const TAKE_READ_AFTER_COVER_MS = 500;
// After the open morph's cover is gone, how long the cached open's network
// refresh waits, so its download and parse land after the reveal.
export const REFRESH_AFTER_COVER_MS = 600;
// offline-islands: how often the player retries the server while offline.
export const OFFLINE_RETRY_MS = 15000;
// How long a Play tap waits for the seek to the top before it plays anyway.
export const SEEK_WAIT_MS = 200;
// The native rates a mid-play speed pick may run the rendered file at (the
// player clamps to 2, and pitch-kept speech blurs well below half).
export const RATE_MIN = 0.5;
export const RATE_MAX = 2;
// After a speed lands under a take about to start, how long it waits for the
// file at that speed to load before recording anyway.
export const SPEED_LOAD_WAIT_MS = 1500;

// Stands in for a real onLayout on the plain (non-reveal) path, where no
// chunk needs to measure itself into a box.
export const noopLayout = () => {};

export const noop = () => {};

/** bl57-intro-round2: how long the guide waits for a line's audio to load before it unlocks the screen. */
export const GUIDE_AUDIO_MS = 15000;
