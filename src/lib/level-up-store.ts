import { useSyncExternalStore } from 'react';

/** `hoursItem`: a listening-hours cosmetic just granted (level unchanged). */
export type PendingLevelUp = { level: number; prevLevel: number; coins: number; hoursItem?: string };

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
  if (pending && pending.level >= next.level) {
    if (next.hoursItem && !pending.hoursItem) {
      pending = { ...pending, hoursItem: next.hoursItem };
      emit();
    }
    return;
  }
  pending = pending
    ? { level: next.level, prevLevel: pending.prevLevel, coins: pending.coins + next.coins, hoursItem: pending.hoursItem ?? next.hoursItem }
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

// BL-51: the session summary and XP moment, and the small "+N XP" pop for XP
// earned anywhere else. Same store so the root host shows one at a time.
export type RecapLine = { islandId: string; title: string; kind: 'island' | 'video' | 'podcast'; score: number | null; words: number; text: string; en: string };
export type XpBreakdown = { sentences: number; score: number; first: number; streak: number };
export type Celebration = {
  xp: number;
  coins: number;
  streak: number;
  sentences: number;
  avgScore: number | null;
  breakdown: XpBreakdown | null;
  /** Level and bar before the XP, and after. */
  before: { level: number; into: number; toNext: number };
  after: { level: number; into: number; toNext: number };
  /** The session's lines, or null for a review run with no per-line detail. */
  recap: { lines: RecapLine[]; seconds: number } | null;
  /** The finish request failed: show the local summary only, XP syncs later. */
  offline?: boolean;
};

let celebration: Celebration | null = null;
let toastXp = 0;
let toastId = 0;
let sessionActive = false;

export function pushCelebration(c: Celebration) {
  celebration = c;
  emit();
}
export function clearCelebration() {
  if (!celebration) return;
  celebration = null;
  emit();
}
export function useCelebration(): Celebration | null {
  return useSyncExternalStore(subscribe, () => celebration);
}
/** A session summary is on screen: Home's streak reminder offer waits for the next focus. */
export function isCelebrationOpen(): boolean {
  return celebration !== null;
}

/** auto-practice marks the running session: its summary and level-up frame wait for the end, the toast does not. */
export function setSessionActive(on: boolean) {
  sessionActive = on;
}
export function isSessionActive(): boolean {
  return sessionActive;
}

/**
 * XP earned anywhere, in a session too: pops a toast, adding to one still
 * showing. `cap` with n 0 is the once-a-day "daily cap reached" note.
 */
export function pushXpToast(n: number, cap = false) {
  if (celebration || !(n > 0 || cap)) return;
  if (n > 0) toastXp += n;
  // The fast-band note stays on the toast until it clears, slow XP and all.
  toastCap = cap || toastCap;
  toastId += 1;
  emit();
}
export function clearXpToast() {
  toastXp = 0;
  toastCap = false;
  emit();
}
let toastCap = false;
let toastSnap = { n: 0, id: 0, cap: false };
export function useXpToast(): { n: number; id: number; cap: boolean } {
  return useSyncExternalStore(subscribe, () => {
    if (toastSnap.n !== toastXp || toastSnap.id !== toastId || toastSnap.cap !== toastCap) {
      toastSnap = { n: toastXp, id: toastId, cap: toastCap };
    }
    return toastSnap;
  });
}

// The ladder's stage view shows XP itself, next to the take's score: while
// one is mounted an award pops there instead of in the toast.
let inlineHosts = 0;
let inline = { n: 0, id: 0, cap: false };
/** Called by a mounted stage view; returns its release. */
export function holdInlineXp(): () => void {
  inlineHosts += 1;
  return () => {
    inlineHosts = Math.max(0, inlineHosts - 1);
  };
}
export function hasInlineXp(): boolean {
  return inlineHosts > 0;
}
/** Pops "+N XP" (or the cap note with n 0) on the mounted stage view. */
export function pushInlineXp(n: number, cap = false) {
  if (!(n > 0 || cap)) return;
  inline = { n, id: inline.id + 1, cap };
  emit();
}
export function useInlineXp(): { n: number; id: number; cap: boolean } {
  return useSyncExternalStore(subscribe, () => inline);
}

// BL-80: the streak-up moment (the day just started counting) and the
// streak-broken moment (Home found a lost streak). Memory only, like the
// level-up: the host shows it once the user is off every practice route.
// One per streak rung (STREAK_RUNGS in progression.py): the server pays the
// achievement and its item on the rung's first award.
export const MILESTONE_DAYS = [7, 14, 30, 60, 100, 180, 365, 500, 1000] as const;
export type StreakMilestone = (typeof MILESTONE_DAYS)[number];
export type StreakMoment = { kind: 'up'; streak: number; milestone: StreakMilestone | null } | { kind: 'broken'; lost: number };

export function milestoneOf(n: number): StreakMilestone | null {
  return (MILESTONE_DAYS as readonly number[]).includes(n) ? (n as StreakMilestone) : null;
}

let streakMoment: StreakMoment | null = null;

/** A newer moment replaces an older one; an up moment always replaces a broken one. */
export function pushStreakMoment(m: StreakMoment) {
  if (streakMoment?.kind === 'up' && m.kind === 'broken') return;
  streakMoment = m;
  emit();
}
export function clearStreakMoment() {
  if (!streakMoment) return;
  streakMoment = null;
  emit();
}
export function useStreakMoment(): StreakMoment | null {
  return useSyncExternalStore(subscribe, () => streakMoment);
}
/** The milestone of a queued or showing up moment, else null: its tile celebrates the rung's item, so the item screen waits for it. */
export function pendingStreakMilestone(): number | null {
  return streakMoment?.kind === 'up' ? streakMoment.milestone : null;
}
/** A streak moment is pending or on screen: Home's streak reminder offer waits for the next focus. */
export function isStreakMomentOpen(): boolean {
  return streakMoment !== null;
}
