import type { AudioStatus } from 'expo-audio';

import type { PhraseSpan } from '@/hooks/use-phrase';

// A vertical swipe drags the active card at 0.35 of the finger's travel,
// with rubber-band damping past 40pt so it never tracks the raw drag once
// the swipe has clearly read as a gesture rather than a nudge.
const DRAG_RATE = 0.35;
export const DRAG_LIMIT = 40;
export function rubberBandDragY(translationY: number): number {
  const scaled = translationY * DRAG_RATE;
  const abs = Math.abs(scaled);
  if (abs <= DRAG_LIMIT) return scaled;
  const sign = Math.sign(scaled);
  const over = abs - DRAG_LIMIT;
  return sign * (DRAG_LIMIT + (over * DRAG_LIMIT) / (over + DRAG_LIMIT));
}

// The end of the spoken line inside the player's audio. `duration` includes
// the pad; at or below the pause length the item is not loaded yet.
export function lineEndOf(duration: number, breathSec: number): number {
  return duration > breathSec ? duration - breathSec : 0;
}

// Whether the pad's silence is playing, and the whole seconds left in it.
// A take and a line played from Explain stop the line where the pad begins,
// so they never count as a breath (see `stopsAtLineEnd`).
export function breathOf(s: AudioStatus, breathMs: number, stopsAtLineEnd: boolean) {
  const end = lineEndOf(s.duration, breathMs / 1000);
  const inBreath = breathMs > 0 && s.playing && end > 0 && s.currentTime >= end && !stopsAtLineEnd;
  const countdown = inBreath ? Math.max(1, Math.ceil(s.duration - s.currentTime)) : null;
  return { inBreath, countdown };
}

// A setDragSpan updater that hands back the previous span when nothing moved,
// so React skips the render. Module level: the pan gesture is built once and
// must not close over a render-scoped function.
export const spanUpdate = (from: number, to: number) => (prev: PhraseSpan | null) =>
  prev && prev.from === from && prev.to === to ? prev : { from, to };
