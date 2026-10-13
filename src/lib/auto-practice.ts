/**
 * The auto practice session: one queue of due islands that the player walks
 * through one after another. Pure module state, like card-morph.ts: Home
 * starts it, each player mount reads its own place and reports its outcome.
 * The player counts as part of a chain only when its route carries
 * `auto: '1'` and `autoPlaceOf(id)` is non-null, so a stale session (app
 * relaunch, deep link) is ignored.
 */

export type AutoOutcome = 'shadowed' | 'skipped';

/** What the practice sheet renders. */
export type AutoChain = {
  /** 0-based position in the queue. */
  at: number;
  total: number;
  /** The next island's title during the hold between islands, else null. */
  next: string | null;
  end: { shadowed: number; skipped: number; minutes: number } | null;
};

type Session = {
  queue: { id: string; title: string }[];
  at: number;
  shadowed: number;
  skipped: number;
  /** auto-practice: set once the last island has been recorded, so a second report is ignored. */
  finished: boolean;
};

let session: Session | null = null;

/** Begins a session. An empty list does nothing. */
export function startAutoPractice(islands: { id: string; title: string }[]): void {
  if (islands.length === 0) return;
  session = { queue: islands.map((i) => ({ id: i.id, title: i.title })), at: 0, shadowed: 0, skipped: 0, finished: false };
}

/** The place of island `id`, or null unless the session is running, not finished, and `id` is the current island. */
export function autoPlaceOf(id: string): { at: number; total: number } | null {
  if (!session || session.finished || session.queue[session.at]?.id !== id) return null;
  return { at: session.at, total: session.queue.length };
}

/**
 * Records how island `id` ended and moves on. Returns the next island, or
 * null when `id` is not the current island (a double tap) or was the last
 * one. After the last island the position stays put and the session is
 * marked finished, so a second report counts nothing, `autoSummary` can still
 * be read and `endAutoPractice` clears the session.
 */
export function finishAutoIsland(id: string, outcome: AutoOutcome): { nextId: string; nextTitle: string } | null {
  if (!session || session.finished || session.queue[session.at]?.id !== id) return null;
  if (outcome === 'shadowed') session.shadowed += 1;
  else session.skipped += 1;
  const next = session.queue[session.at + 1];
  if (!next) {
    session.finished = true; // auto-practice
    return null;
  }
  session.at += 1;
  return { nextId: next.id, nextTitle: next.title };
}

export function autoSummary(): { shadowed: number; skipped: number; total: number } {
  if (!session) return { shadowed: 0, skipped: 0, total: 0 };
  return { shadowed: session.shadowed, skipped: session.skipped, total: session.queue.length };
}

/** Ends the session. With an id, clears only when that island is the current one (the unmount guard). */
export function endAutoPractice(id?: string): void {
  if (!session) return;
  if (id !== undefined && session.queue[session.at]?.id !== id) return;
  session = null;
}
