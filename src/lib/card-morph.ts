import type { RefObject } from 'react';
import type { View } from 'react-native';

/** The on-screen rect of an island card, from `measureInWindow`. */
export type CardRect = { x: number; y: number; width: number; height: number };

export type MorphPhase = 'open' | 'back';

export type MorphState = {
  phase: MorphPhase;
  id: string;
  title: string;
  rect: CardRect;
};

type Listener = (state: MorphState | null) => void;

// Module singleton: Home registers its card refs here so the reverse morph
// can re-measure them at back time, and the overlay subscribes to the single
// in-flight morph. No React context, this outlives any one screen.
const registry = new Map<string, RefObject<View | null>>();
const titles = new Map<string, string>();
const listeners = new Set<Listener>();
let current: MorphState | null = null;

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

/** Home rows call this on mount (and unregister on cleanup) so `startBack`
 * can find the card to shrink into. */
export function registerCard(id: string, ref: RefObject<View | null>) {
  registry.set(id, ref);
}

export function unregisterCard(id: string) {
  registry.delete(id);
}

/** True while a morph is running, start to finish. */
export function isActive(): boolean {
  return current !== null;
}

/** Starts the card-to-player morph. Returns false (and does nothing) while a
 * morph is already running, so a double tap opens the player once. */
export function startOpen(id: string, title: string, rect: CardRect): boolean {
  if (isActive()) return false;
  titles.set(id, title);
  publish({ phase: 'open', id, title, rect: finiteRect(rect) });
  return true;
}

/** Starts the player-to-card morph. Re-measures the registered card; returns
 * false if none is registered (deep link, no card to shrink into) or if
 * `startOpen` never ran for this id (opened straight from Record: the card
 * may still be registered from Home mounting underneath, but there is no
 * real title to morph into, only a blank one that would flash a bare
 * outline). Either way, the caller falls back to a plain `router.back()`. */
export function startBack(id: string): boolean {
  const ref = registry.get(id);
  const node = ref?.current;
  const title = titles.get(id);
  if (!node || title === undefined) return false;
  node.measureInWindow((x, y, width, height) => {
    publish({ phase: 'back', id, title, rect: finiteRect({ x, y, width, height }) });
  });
  return true;
}

/** Clears the in-flight morph once the overlay's sequence finishes. */
export function finish() {
  publish(null);
}

export function subscribe(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
