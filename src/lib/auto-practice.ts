/**
 * The practice session: one queue of projects (islands, videos, podcasts)
 * that the players walk through one after another, each on the lines the plan
 * picked. Pure module state, like card-morph.ts: the start screen starts it,
 * each player mount reads its own place and reports its outcome.
 * A player counts as part of a session only when its route carries
 * `auto: '1'` or `session: '1'` and `autoPlaceOf(id)` is non-null, so a stale
 * session (app relaunch, deep link) is ignored.
 */

import AsyncStorage from '@react-native-async-storage/async-storage';
import type { Href } from 'expo-router';
import { AppState } from 'react-native';

import * as api from '@/lib/api';
import { setSessionActive, type RecapLine } from '@/lib/level-up-store';
import { celebrateOffline, celebrateReview } from '@/lib/progression';
import { latestTakeScore, resetSessionScores, sessionScoreAverage } from '@/lib/take-scores';

export type AutoOutcome = 'shadowed' | 'skipped';

/** What the island player renders. */
export type AutoChain = {
  /** 0-based position in the queue. */
  at: number;
  total: number;
  /** The next project's title during the hold between islands, else null. */
  next: string | null;
};

type ChainEntry = { id: string; title: string; kind: api.SessionKind; idx: number[] };

type Session = {
  queue: ChainEntry[];
  at: number;
  /** auto-practice: set once the last project has been recorded, so a second report is ignored. */
  finished: boolean;
  sessionId: string | null;
  startedAt: number;
  lines: { island_id: string; idx: number; seconds: number }[];
  /** What the summary shows per line: its words and text. */
  recap: { words: number; text: string; en: string }[];
};

let session: Session | null = null;

// Time the app spent backgrounded during the session. Counting it would
// inflate the pace the server learns, so it is taken off the session seconds.
let hiddenSince: number | null = null;
let hiddenMs = 0;
AppState.addEventListener('change', (state) => {
  if (state === 'active') {
    if (hiddenSince !== null) hiddenMs += Date.now() - hiddenSince;
    hiddenSince = null;
  } else if (hiddenSince === null) {
    hiddenSince = Date.now();
  }
});

/** Session seconds with background time removed; never negative or NaN. */
function activeSeconds(startedAt: number): number {
  const away = hiddenMs + (hiddenSince !== null ? Date.now() - hiddenSince : 0);
  const sec = (Date.now() - startedAt - away) / 1000;
  return Number.isFinite(sec) ? Math.max(0, sec) : 0;
}

/** Begins a session from a started plan. A plan with no projects does nothing. */
export function startSession(plan: api.SessionPlan): void {
  const queue = plan.projects
    .filter((p) => p.picked.length > 0)
    .map((p) => ({ id: p.island_id, title: p.title, kind: p.kind, idx: [...p.picked].sort((a, b) => a - b) }));
  if (queue.length === 0) return;
  resetSessionScores();
  hiddenMs = 0;
  hiddenSince = AppState.currentState === 'active' ? null : Date.now();
  session = { queue, at: 0, finished: false, sessionId: plan.session_id, startedAt: Date.now(), lines: [], recap: [] };
  setSessionActive(true);
}

/** The place of project `id`, or null unless the session is running, not finished, and `id` is the current project. */
export function autoPlaceOf(id: string): { at: number; total: number; idx: number[] } | null {
  if (!session || session.finished || session.queue[session.at]?.id !== id) return null;
  return { at: session.at, total: session.queue.length, idx: session.queue[session.at].idx };
}

/**
 * Records how project `id` ended and moves on. Returns the next project, or
 * null when `id` is not the current one (a double tap) or was the last one.
 * After the last project the position stays put and the session is marked
 * finished, so a second report counts nothing.
 */
export function finishAutoIsland(id: string, outcome: AutoOutcome): { nextId: string; nextTitle: string; nextKind: api.SessionKind } | null {
  void outcome;
  if (!session || session.finished || session.queue[session.at]?.id !== id) return null;
  const next = session.queue[session.at + 1];
  if (!next) {
    session.finished = true; // auto-practice
    return null;
  }
  session.at += 1;
  return { nextId: next.id, nextTitle: next.title, nextKind: next.kind };
}

/** Where a project's player lives: islands run the chain, video and podcast run review on the picked lines. */
export function routeFor(id: string, kind: api.SessionKind): Href {
  if (kind === 'video') return { pathname: '/video/[id]', params: { id, review: '1', session: '1' } };
  if (kind === 'podcast') return { pathname: '/podcast/[id]', params: { id, review: '1', session: '1' } };
  return { pathname: '/island/[id]', params: { id, auto: '1' } };
}

/** The island with only the place's picked lines (line order), else unchanged. */
export function sessionLines<T extends { lines: api.Line[] }>(id: string, island: T): T {
  const place = autoPlaceOf(id);
  if (!place) return island;
  const keep = new Set(place.idx);
  return { ...island, lines: island.lines.filter((l) => keep.has(l.idx)) };
}

/** One finished line of the running session. */
export function noteSessionLine(islandId: string, idx: number, seconds: number, line?: { ja: string; en: string; words: unknown[] }): void {
  if (!session || session.finished) return;
  session.lines.push({ island_id: islandId, idx, seconds: Math.max(0, Math.round(seconds * 10) / 10) });
  session.recap.push({ words: line?.words.length ?? 0, text: line?.ja ?? '', en: line?.en ?? '' });
}

/** Reports the session once (the lines done so far), shows its summary and XP moment, then clears it. */
export function finishSession(completed: boolean): void {
  const s = session;
  if (!s) return;
  session = null;
  setSessionActive(false);
  if (s.lines.length === 0 || !s.sessionId) return;
  const avg = sessionScoreAverage();
  const seconds = activeSeconds(s.startedAt);
  const lines = s.lines.map((l) => ({ ...l, score: latestTakeScore(l.island_id, l.idx) }));
  const recap: RecapLine[] = lines.map((l, i) => {
    const p = s.queue.find((q) => q.id === l.island_id);
    return { islandId: l.island_id, title: p?.title ?? '', kind: p?.kind ?? 'island', score: l.score, ...s.recap[i] };
  });
  api
    .finishReviewSession({ session_id: s.sessionId, sentences: s.lines.length, seconds, ...(avg === null ? {} : { avg_score: avg }), lines, completed })
    .then((res) => celebrateReview(res, s.lines.length, avg, { lines: recap, seconds }))
    .catch(() => celebrateOffline(s.lines.length, avg, { lines: recap, seconds }));
}

/** Ends the session. With an id, ends only when that project is the current one (the unmount guard). Lines done are reported as an unfinished session. */
export function endAutoPractice(id?: string): void {
  if (!session) return;
  if (id !== undefined && session.queue[session.at]?.id !== id) return;
  finishSession(false);
}

const PREFS_KEY = 'shadow.sessionPrefs';
type SessionPrefs = { order: string[]; edited: boolean };
let prefs: SessionPrefs | null = null;

/** The start screen's memory: the project order last dragged (island ids, [] until one) and whether the learner has edited a plan yet. */
export async function getSessionPrefs(): Promise<SessionPrefs> {
  if (prefs) return prefs;
  try {
    const raw = await AsyncStorage.getItem(PREFS_KEY);
    const parsed = (raw ? JSON.parse(raw) : {}) as Partial<SessionPrefs>;
    prefs = {
      order: Array.isArray(parsed.order) ? parsed.order.filter((x): x is string => typeof x === 'string') : [],
      edited: parsed.edited === true,
    };
  } catch {
    prefs = { order: [], edited: false };
  }
  return prefs;
}

/** Keeps a change to the start screen's memory for the next visit. */
export function setSessionPrefs(change: Partial<SessionPrefs>): void {
  prefs = { order: [], edited: false, ...prefs, ...change };
  void AsyncStorage.setItem(PREFS_KEY, JSON.stringify(prefs)).catch(() => {});
}
