import { useSyncExternalStore } from 'react';

export type PendingLevelUp = { level: number; prevLevel: number; coins: number };

// A level-up is detected where progress is fetched, but shown only once the
// practice session is over, so it waits here in between.
let pending: PendingLevelUp | null = null;
const listeners = new Set<() => void>();

function emit() {
  listeners.forEach((l) => l());
}
function subscribe(l: () => void) {
  listeners.add(l);
  return () => {
    listeners.delete(l);
  };
}

/** Queues a level-up. If one is pending, the two merge into the highest level. */
export function pushLevelUp(next: PendingLevelUp) {
  if (pending && pending.level >= next.level) return;
  pending = pending
    ? { level: next.level, prevLevel: pending.prevLevel, coins: pending.coins + next.coins }
    : next;
  emit();
}

export function clearLevelUp() {
  if (!pending) return;
  pending = null;
  emit();
}

export function usePendingLevelUp(): PendingLevelUp | null {
  return useSyncExternalStore(subscribe, () => pending);
}
