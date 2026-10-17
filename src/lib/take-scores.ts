import { useSyncExternalStore } from 'react';

export type SessionScore = { islandId: string; idx: number; recordedAt: number | string; total: number };

// Scores of this app run's takes, in order. A session ends when
// `resetSessionScores` is called.
let scores: SessionScore[] = [];
let snapshot: { average: number | null; count: number } = { average: null, count: 0 };
const listeners = new Set<() => void>();

function emit() {
  const count = scores.length;
  snapshot = { average: count ? Math.round(scores.reduce((a, s) => a + s.total, 0) / count) : null, count };
  listeners.forEach((l) => l());
}
function subscribe(l: () => void) {
  listeners.add(l);
  return () => {
    listeners.delete(l);
  };
}

/** Records a take's total. Unscorable takes (null) and repeats of the same take are ignored. */
export function noteTakeScore(s: Omit<SessionScore, 'total'> & { total: number | null }) {
  if (s.total === null) return;
  if (scores.some((x) => x.recordedAt === s.recordedAt)) return;
  scores = [...scores, { ...s, total: s.total }];
  emit();
}

export function resetSessionScores() {
  if (!scores.length) return;
  scores = [];
  emit();
}

/** The latest scored total for a line in this app run, or null. */
export function latestTakeScore(islandId: string, idx: number): number | null {
  for (let i = scores.length - 1; i >= 0; i--) if (scores[i].islandId === islandId && scores[i].idx === idx) return scores[i].total;
  return null;
}

/** The same average `useSessionScore` shows, read outside React. */
export function sessionScoreAverage(): number | null {
  return snapshot.average;
}

/** Average total of this session's scored takes, rounded, and how many there were. */
export function useSessionScore() {
  return useSyncExternalStore(subscribe, () => snapshot);
}
