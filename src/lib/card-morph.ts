import { useSyncExternalStore, type RefObject } from 'react';
import { Platform, type View } from 'react-native';
import { makeMutable, runOnUI } from 'react-native-reanimated';

import { armRevealForMorph, releaseReveal } from '@/lib/content-reveal';
import { loaderCoverSkip, requestLoader } from '@/lib/loading-overlay';

/** 1 when the open morph's player said, in its ready signal, that it still
 * waits for its lines: the landing worklet then asks for the loader. */
export const readyWaitingUI = makeMutable(0);

/** The on-screen rect of an island card, from `measureInWindow`. */
export type CardRect = { x: number; y: number; width: number; height: number };

export type MorphPhase = 'open' | 'back';

/** 'fly': the overlay title is on screen and the real title under it is
 * hidden. 'landed': the overlay title is gone, the real one (the player's
 * header on open, the Home card on back) shows, and the overlay fades out. */
export type MorphStage = 'fly' | 'landed';

/** What the player's header showed when back was tapped, so the overlay can
 * draw the same chrome over the shrinking card once the player is gone. */
export type HeaderChrome = {
  title: string;
  lineIndex: number;
  lineCount: number;
  /** The line row shows its count stand-in (the island is still loading). */
  placeholder: boolean;
  menu: boolean;
};

export type MorphState = {
  /** Counts morphs, so the overlay can remount its animated values fresh. */
  serial: number;
  phase: MorphPhase;
  stage: MorphStage;
  id: string;
  title: string;
  rect: CardRect;
  /** Set on a back morph only. */
  chrome?: HeaderChrome;
  /** The line the player will open on and the island's line count, as far as
   * Home knows them (count 0: not known yet). Set on an open morph. */
  line?: OpenedLine;
};

export type OpenedLine = { lineIndex: number; lineCount: number };

/** The player header's row height under the top inset. The overlay lays its
 * stand-in back and menu buttons out on the same grid. */
export const PLAYER_HEADER_ROW_H = Platform.select({ ios: 44, default: 56 }) ?? 44;
export const PLAYER_HEADER_BUTTON = 44;

type Listener = (state: MorphState | null) => void;

// Module singleton: Home registers its card refs here so the reverse morph
// can re-measure them at back time, and the overlay subscribes to the single
// in-flight morph. No React context, this outlives any one screen.
const registry = new Map<string, RefObject<View | null>>();
const titles = new Map<string, string>();
const openedLines = new Map<string, OpenedLine>();
const listeners = new Set<Listener>();
let current: MorphState | null = null;
let serial = 0;
// Runs once the overlay covers the screen: the push on open, the pop on back.
let onCovered: (() => void) | null = null;
// Set once the open morph covered the screen; the player's ready signal lands
// the morph only after that, and a timer lands it anyway if it never comes.
let openCovered = false;
// Set once the player reports its first content on screen; a cover that
// finishes after that lands at once instead of waiting on the timer.
let openReady = false;
// The player's ready signal said it still waits for its lines (a cache miss),
// so the loader stays on past the morph's end.
let openWaiting = false;
// The open morph's player unmounted mid-flight (a hardware back): the morph
// lands at once and its end clears the loader, whatever ready said.
let openGone = false;
let readyTimer: ReturnType<typeof setTimeout> | null = null;
// The running overlay's landing: starts the cover fade (and, on open, the
// content reveal) on the UI thread. Called from `land`, so the fade never
// waits for the overlay's own render.
let landHandler: ((nextFrame: boolean) => void) | null = null;
// Run once an open morph's cover is gone (see `afterCoverGone`).
const coverGoneListeners = new Set<{ id: string; run: () => void }>();
let headerTitle: CardRect | null = null;
let headerBox: CardRect | null = null;
const goneListeners = new Set<(id: string) => void>();
// Off under reduced motion: no overlay, so a tap pushes or pops at once and
// the route's own fade is the whole effect.
let enabled = true;

// How long the overlay keeps covering the screen, waiting for the player to
// render its island, before it reveals whatever is there. A safety net only:
// the loading overlay covers a real wait, so this rarely fires.
const READY_TIMEOUT_MS = 2000;

// A measure can report undefined or NaN (a card mid-unmount, say). Those
// would reach the overlay's animated left, top, width and height on the UI
// thread, so every number is forced finite, or 0, here.
function finiteRect(rect: CardRect): CardRect {
  const f = (n: number) => (Number.isFinite(n) ? n : 0);
  return { x: f(rect.x), y: f(rect.y), width: f(rect.width), height: f(rect.height) };
}

function publish(next: MorphState | null) {
  current = next;
  listeners.forEach((listener) => listener(current));
}

function clearReadyTimer() {
  if (readyTimer !== null) clearTimeout(readyTimer);
  readyTimer = null;
}

/** Home rows call this on mount (and unregister on cleanup) so `startBack`
 * can find the card to shrink into. */
export function registerCard(id: string, ref: RefObject<View | null>) {
  registry.set(id, ref);
}

export function unregisterCard(id: string) {
  registry.delete(id);
}

/** The title Home opened this island's card with, if it did: the player's
 * header shows it before the island itself has loaded. */
export function openedTitle(id: string): string | undefined {
  return titles.get(id);
}

/** The line row Home opened this island's card with, if it did. */
export function openedLine(id: string): OpenedLine | undefined {
  return openedLines.get(id);
}

/** The overlay turns the morph off under reduced motion. */
export function setMorphEnabled(on: boolean) {
  enabled = on;
}

/** True while a morph is running, start to finish. */
export function isActive(): boolean {
  return current !== null;
}

/** Starts the card-to-player morph. `onCover` pushes the player: the overlay
 * runs it through `openPush` at the tap, so the player renders under the
 * growing card, and the morph lands once both the cover and the player's
 * ready signal are in. Returns false (and does nothing) while a morph is
 * already running, so a double tap opens the player once. */
export function startOpen(
  id: string,
  title: string,
  rect: CardRect,
  onCover: () => void,
  line?: OpenedLine,
): boolean {
  if (isActive()) return false;
  titles.set(id, title);
  const f = (n: number | undefined) => (typeof n === 'number' && Number.isFinite(n) ? Math.max(0, Math.floor(n)) : 0);
  const safeLine = { lineIndex: f(line?.lineIndex), lineCount: f(line?.lineCount) };
  openedLines.set(id, safeLine);
  if (!enabled) {
    onCover();
    return true;
  }
  onCovered = onCover;
  openCovered = false;
  openReady = false;
  openWaiting = false;
  openGone = false;
  loaderCoverSkip.value = 0;
  readyWaitingUI.value = 0;
  armRevealForMorph();
  serial += 1;
  publish({ serial, phase: 'open', stage: 'fly', id, title, rect: finiteRect(rect), line: safeLine });
  return true;
}

/** Starts the player-to-card morph. Re-measures the registered card; returns
 * false if none is registered (deep link, no card to shrink into) or if
 * `startOpen` never ran for this id (opened straight from Record: the card
 * may still be registered from Home mounting underneath, but there is no
 * real title to morph into, only a blank one that would flash a bare
 * outline). Either way, the caller falls back to a plain `router.back()`.
 * On true, `onCover` runs (it should pop the player) once the overlay fills
 * the screen. */
export function startBack(id: string, onCover: () => void, chrome?: HeaderChrome): boolean {
  // A second tap while this back is still measuring its card.
  if (onCovered !== null && !isActive()) return true;
  if (!canStartBack(id)) return false;
  const node = registry.get(id)?.current;
  const title = titles.get(id);
  if (!node || title === undefined) return false;
  onCovered = onCover;
  node.measureInWindow((x, y, width, height) => {
    serial += 1;
    publish({ serial, phase: 'back', stage: 'fly', id, title, rect: finiteRect({ x, y, width, height }), chrome });
  });
  return true;
}

/** Whether `startBack` would run a morph for this id right now, so the
 * player can fade its content out first and only then start it. */
export function canStartBack(id: string): boolean {
  if (!enabled || isActive() || onCovered !== null) return false;
  return !!registry.get(id)?.current && titles.has(id);
}

/** The player calls this as it unmounts. A back morph waits for it before
 * shrinking, so the player's native teardown never lands mid-shrink. An open
 * morph for the same id (a hardware back mid-flight) lands at once, keeps
 * its cover worklet from asking for the loader, and clears the loader when
 * it ends. */
export function playerGone(id: string) {
  if (current?.phase === 'open' && current.id === id) {
    openGone = true;
    readyWaitingUI.value = 0;
    loaderCoverSkip.value = 1;
    land();
  }
  goneListeners.forEach((listener) => listener(id));
}

export function subscribePlayerGone(listener: (id: string) => void): () => void {
  goneListeners.add(listener);
  return () => goneListeners.delete(listener);
}

/** Runs the open morph's push (and clears it, so `finish` and `covered` never
 * run it again) as soon as it is due. Separate from `covered` because the
 * push now happens at tap, before the overlay has finished covering the
 * screen. */
export function openPush() {
  if (current?.phase !== 'open') return;
  const run = onCovered;
  onCovered = null;
  run?.();
}

/** The overlay calls this once it fills the screen. */
export function covered() {
  const run = onCovered;
  onCovered = null;
  if (current?.phase === 'open') {
    openCovered = true;
    if (openReady) {
      land();
    } else {
      clearReadyTimer();
      readyTimer = setTimeout(land, READY_TIMEOUT_MS);
    }
  }
  run?.();
}

/** The player calls this once its first content is on screen (the island, or
 * the news that it has to wait for the network, `waiting`). Lands an open
 * morph for that id once the overlay has covered the screen too, whichever
 * comes last. A ready that arrives before the cover keeps the cover worklet
 * from asking for the loader at all. */
export function playerReady(id: string, opts?: { waiting?: boolean }) {
  if (!current || current.id !== id || current.phase !== 'open') return;
  openReady = true;
  openWaiting = opts?.waiting === true;
  readyWaitingUI.value = openWaiting ? 1 : 0;
  loaderCoverSkip.value = 1;
  // Sent from the player's layout effect, before native draws that commit:
  // the landing waits one frame so the cover never fades over bare content.
  if (openCovered) land({ nextFrame: true });
}

/** Hands the title from the overlay to the real one in a single render.
 * `nextFrame` delays the cover fade and the reveal by one frame. */
export function land(opts?: { nextFrame?: boolean }) {
  clearReadyTimer();
  if (!current || current.stage === 'landed') return;
  landHandler?.(opts?.nextFrame === true);
  publish({ ...current, stage: 'landed' });
}

/** The overlay registers its landing here while a morph runs. */
export function setLandHandler(handler: ((nextFrame: boolean) => void) | null) {
  landHandler = handler;
}

/** Clears the in-flight morph once the overlay's sequence finishes. */
export function finish() {
  clearReadyTimer();
  // A cover that never ran (reduced motion, or the overlay went away
  // mid-morph) still pushes or pops, or the tap would do nothing.
  const run = onCovered;
  onCovered = null;
  const wasOpen = current?.phase === 'open' ? current.id : null;
  // Only a player still waiting for the network keeps the loader. One that
  // never reported ready (the morph ended before its content landed), or
  // that already unmounted, must not leave it on screen over Home.
  if (!openReady || openGone || !openWaiting) requestLoader(false);
  openCovered = false;
  openReady = false;
  openWaiting = false;
  openGone = false;
  // A morph that ended without its landing worklet (reduced motion turned on
  // mid-flight) must not leave the content held hidden.
  if (wasOpen !== null) runOnUI(releaseReveal)();
  publish(null);
  run?.();
  if (wasOpen !== null) {
    coverGoneListeners.forEach((entry) => {
      if (entry.id !== wasOpen) return;
      coverGoneListeners.delete(entry);
      entry.run();
    });
  }
}

/** True while an open morph for this island runs, from its start until its
 * cover is gone. A plain read: it never renders anything. */
export function openCoverUp(id: string): boolean {
  return !!current && current.phase === 'open' && current.id === id;
}

/** Runs `run` once the open morph for `id` no longer covers the screen, then
 * `delayMs` later. With no such morph running it counts from now (at once
 * for 0). Returns a cancel, for an effect's cleanup. */
export function afterCoverGone(id: string, run: () => void, delayMs = 0): () => void {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let cancelled = false;
  const go = () => {
    if (cancelled) return;
    if (delayMs <= 0) {
      run();
      return;
    }
    timer = setTimeout(() => {
      timer = null;
      if (!cancelled) run();
    }, delayMs);
  };
  const entry = { id, run: go };
  if (openCoverUp(id)) coverGoneListeners.add(entry);
  else go();
  return () => {
    cancelled = true;
    coverGoneListeners.delete(entry);
    if (timer !== null) clearTimeout(timer);
  };
}

export function subscribe(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** The player's header reports where its title text sits on screen, so the
 * overlay title flies to exactly that spot. */
export function setHeaderTitleRect(rect: CardRect) {
  const r = finiteRect(rect);
  if (r.width <= 0 || r.height <= 0) return;
  headerTitle = r;
  headerListeners.forEach((listener) => listener(r));
}

export function headerTitleRect(): CardRect | null {
  return headerTitle;
}

/** The player's whole header bar reports its window rect; the overlay derives
 * its stand-in chrome positions from it. */
export function setHeaderBoxRect(rect: CardRect) {
  const r = finiteRect(rect);
  if (r.width <= 0 || r.height <= 0) return;
  const old = headerBox;
  if (old && old.x === r.x && old.y === r.y && old.width === r.width && old.height === r.height) return;
  headerBox = r;
  headerBoxListeners.forEach((listener) => listener(r));
}

export function headerBoxRect(): CardRect | null {
  return headerBox;
}

const headerBoxListeners = new Set<(rect: CardRect) => void>();

export function subscribeHeaderBox(listener: (rect: CardRect) => void): () => void {
  headerBoxListeners.add(listener);
  return () => headerBoxListeners.delete(listener);
}

const headerListeners = new Set<(rect: CardRect) => void>();

export function subscribeHeaderTitle(listener: (rect: CardRect) => void): () => void {
  headerListeners.add(listener);
  return () => headerListeners.delete(listener);
}

function subscribeStore(onChange: () => void) {
  return subscribe(onChange);
}

/** True while a morph for this island keeps the real chrome at `where`
 * hidden. The player header (title and buttons) hides while the overlay draws
 * it: through the open flight until the landing handoff, and for a whole
 * back. The Home card's title hides for an open only; on back it shows under
 * the shrinking card. */
export function useMorphHidesTitle(id: string, where: 'header' | 'card'): boolean {
  return useSyncExternalStore(subscribeStore, () => {
    const m = current;
    if (!m || m.id !== id) return false;
    if (where === 'card') return m.phase === 'open';
    return m.stage === 'fly' || m.phase === 'back';
  });
}
