import { cancelAnimation, Easing, makeMutable, runOnUI, withDelay, withTiming } from 'react-native-reanimated';

/** Each piece of the player's content comes in this long, rising this far. */
export const PIECE_MS = 220;
export const PIECE_RISE = 8;
/** Start offsets of the sentence card, transcript rows, toolbar and bottom row. */
const DELAY_CARD = 0;
const DELAY_ROWS = 60;
const DELAY_TOOLBAR = 120;
const DELAY_DOCK = 180;
/** Off the morph path (reduced motion, a route opened from elsewhere) the
 * content fades in together, this long, without rising. */
export const PLAIN_MS = 180;
const EASE_OUT = Easing.out(Easing.cubic);

// The player's reveal lives here, not in the screen, so the card morph's
// landing worklet can start it on the UI thread the frame the cover starts
// fading, with no JS round trip. One player screen shows at a time.
export const revealCard = makeMutable(1);
export const revealRows = makeMutable(1);
export const revealToolbar = makeMutable(1);
export const revealDock = makeMutable(1);
/** 1 while pieces rise as they fade in, 0 for a fade without movement. */
export const revealRise = makeMutable(0);
/** 1 from an open morph's start until its landing begins: the reveal waits. */
const revealHeld = makeMutable(0);
/** 1 once the player's lines are on screen to reveal. */
export const revealLinesReady = makeMutable(0);
/** 1 once this open's reveal has started, so it starts exactly once. */
const revealStarted = makeMutable(0);

function setPieces(v: number) {
  'worklet';
  cancelAnimation(revealCard);
  cancelAnimation(revealRows);
  cancelAnimation(revealToolbar);
  cancelAnimation(revealDock);
  revealCard.value = v;
  revealRows.value = v;
  revealToolbar.value = v;
  revealDock.value = v;
}

/** Starts the reveal if the lines are in, nothing holds it, and it has not
 * started yet. Staged: the pieces rise in one after another. */
function startReveal(staged: boolean) {
  'worklet';
  if (revealStarted.value === 1 || revealHeld.value === 1 || revealLinesReady.value !== 1) return;
  revealStarted.value = 1;
  if (staged) {
    revealRise.value = 1;
    setPieces(0);
    revealCard.value = withDelay(DELAY_CARD, withTiming(1, { duration: PIECE_MS, easing: EASE_OUT }));
    revealRows.value = withDelay(DELAY_ROWS, withTiming(1, { duration: PIECE_MS, easing: EASE_OUT }));
    revealToolbar.value = withDelay(DELAY_TOOLBAR, withTiming(1, { duration: PIECE_MS, easing: EASE_OUT }));
    revealDock.value = withDelay(DELAY_DOCK, withTiming(1, { duration: PIECE_MS, easing: EASE_OUT }));
    return;
  }
  revealRise.value = 0;
  revealCard.value = withTiming(1, { duration: PLAIN_MS });
  revealRows.value = withTiming(1, { duration: PLAIN_MS });
  revealToolbar.value = withTiming(1, { duration: PLAIN_MS });
  revealDock.value = withTiming(1, { duration: PLAIN_MS });
}

function armWorklet() {
  'worklet';
  revealHeld.value = 1;
  revealLinesReady.value = 0;
  revealStarted.value = 0;
  revealRise.value = 1;
  setPieces(0);
}

function resetWorklet() {
  'worklet';
  revealHeld.value = 0;
  revealLinesReady.value = 0;
  revealStarted.value = 0;
  revealRise.value = 0;
  setPieces(0);
}

/** JS: an open morph starts. Hides the pieces and holds the reveal until
 * `releaseReveal` runs at the landing. */
export function armRevealForMorph() {
  runOnUI(armWorklet)();
}

/** JS: a player screen mounts without a morph over it. */
export function resetReveal() {
  runOnUI(resetWorklet)();
}

/** UI thread: the open morph's landing. Lets the staged reveal go, and starts
 * it at once when the lines are already in. */
export function releaseReveal() {
  'worklet';
  revealHeld.value = 0;
  startReveal(true);
}

function linesWorklet(ready: boolean, staged: boolean) {
  'worklet';
  if (!ready) {
    revealLinesReady.value = 0;
    revealStarted.value = 0;
    setPieces(0);
    return;
  }
  revealLinesReady.value = 1;
  startReveal(staged);
}

/** JS: the player's lines arrived (or went). Starts the reveal unless a
 * covering morph still holds it; its landing starts it then. */
export function setRevealLines(ready: boolean, staged: boolean) {
  runOnUI(linesWorklet)(ready, staged);
}
