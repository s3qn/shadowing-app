// Api domain: review. Dev review tour, known lines, feedback, review sessions, the review deck.
import { Platform } from 'react-native';
import { File } from 'expo-file-system';

import { BASE, expoFetch, fetch } from '@/lib/api-http';
import { headers, json } from '@/lib/api-core';
import type { IslandSource, Language, NativeLanguage, Word } from '@/lib/api-types';
import type { Progress } from '@/lib/api-progress';
import { listIslands } from '@/lib/api-islands';

export type ReviewVerdict = 'accept' | 'fix' | 'remove';
export type ReviewStep = {
  id: string;
  title: string;
  route: string;
  params?: Record<string, string>;
  /** Dev only: a key of SIMULATIONS (dev-simulate.ts) run before "Take me there". */
  simulate?: string;
  /** 'transcripts' shows the dev transcript list in the step's sheet (transcript-review). */
  kind?: 'transcripts';
  checks: string[];
  chips?: string[];
  verdict: ReviewVerdict | null;
  vchips: string[];
};
export type ReviewTour = { wave: string; steps: ReviewStep[] };

/** Dev review tour: null on 404 or any error (prod, or no tour file). */
export async function getReview(): Promise<ReviewTour | null> {
  try {
    const res = await fetch(`${BASE}/dev/review`, { headers: headers() });
    return res.ok ? ((await res.json()) as ReviewTour) : null;
  } catch {
    return null;
  }
}

export async function postVerdict(body: { wave: string; id: string; verdict: ReviewVerdict; chips: string[] }): Promise<void> {
  await fetch(`${BASE}/dev/review/verdict`, {
    method: 'POST',
    headers: { ...headers(), 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }).catch(() => undefined);
}

async function postReviewFile(kind: 'voice' | 'shot', wave: string, id: string, uri: string, name: string): Promise<boolean> {
  try {
    const form = new FormData();
    form.append('wave', wave);
    form.append('id', id);
    form.append('file', new File(uri), name);
    const res = await expoFetch(`${BASE}/dev/review/${kind}`, { method: 'POST', headers: headers(), body: form });
    return res.ok;
  } catch {
    return false;
  }
}

/** Tells the dev machine the tour is finished. True when the server logged it. */
export async function postReviewDone(wave: string): Promise<boolean> {
  try {
    const res = await fetch(`${BASE}/dev/review/done`, {
      method: 'POST',
      headers: { ...headers(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ wave }),
    });
    return res.ok;
  } catch {
    return false;
  }
}

export const postVoiceNote = (wave: string, id: string, uri: string) => postReviewFile('voice', wave, id, uri, 'note.m4a');
export const postShot = (wave: string, id: string, uri: string) => postReviewFile('shot', wave, id, uri, 'shot.jpg');

/** The island's known idxs after a mark, the device's total, and the XP paid (null when the line was never taken whole, or the mark was not new). */
export type KnownReply = { known: number[]; total: number; award?: { xp: number } | null };

export async function markKnown(islandId: string, idx: number): Promise<KnownReply> {
  const res = await expoFetch(`${BASE}/islands/${islandId}/lines/${idx}/known`, { method: 'POST', headers: headers() });
  return json<KnownReply>(res);
}

export async function unmarkKnown(islandId: string, idx: number): Promise<KnownReply> {
  const res = await expoFetch(`${BASE}/islands/${islandId}/lines/${idx}/known`, { method: 'DELETE', headers: headers() });
  return json<KnownReply>(res);
}

export type DueIsland = { island_id: string; level: number; due_on: string; last_practiced_on: string };

export async function getDueToday(): Promise<DueIsland[]> {
  return json<DueIsland[]>(await fetch(`${BASE}/schedule/due-today`, { headers: headers() }));
}

export type FeedbackPayload = { kind: 'bug' | 'suggestion'; text: string; meta: string; voice?: string; images: string[] };

/**
 * Posts one tester report. Resolves with the HTTP status, or 0 when the
 * request never reached the server (the caller queues it). Web has no `File`,
 * so it fetches each local uri as a blob.
 */
export async function sendFeedback(p: FeedbackPayload): Promise<number> {
  try {
    const form = new FormData();
    form.append('kind', p.kind);
    form.append('text', p.text);
    form.append('meta', p.meta);
    const web = Platform.OS === 'web';
    const attach = async (field: string, uri: string, name: string) => {
      if (web) form.append(field, await (await globalThis.fetch(uri)).blob(), name);
      else form.append(field, new File(uri), name);
    };
    if (p.voice) await attach('voice', p.voice, web ? 'voice.webm' : 'voice.m4a');
    for (let i = 0; i < p.images.length; i++) await attach('images', p.images[i], `img-${i + 1}`);
    const res = web
      ? await fetch(`${BASE}/feedback`, { method: 'POST', headers: headers(), body: form })
      : await expoFetch(`${BASE}/feedback`, { method: 'POST', headers: headers(), body: form });
    return res.status;
  } catch {
    return 0;
  }
}

export type SessionKind = 'island' | 'video' | 'podcast';
export type SessionProject = { island_id: string; title: string; source: string; kind: SessionKind; total: number; picked: number[] };
export type SessionPlan = {
  session_id: string | null;
  size: number;
  count: number;
  minutes: number;
  seconds_per_sentence: number;
  projects: SessionProject[];
  first: { island_id: string; idx: number; ja: string; kana: string; en: string; words: Word[] } | null;
};

/** A project the learner can put in a session, with how many lines it has. */
export type SessionCatalogueItem = { island_id: string; title: string; source: string; kind: SessionKind; total: number };
/** The learner's own plan: these projects in this order, each with up to `count` lines. */
export type SessionPick = { island_id: string; count: number };
/** `order` (island ids) plays those projects first; `projects` replaces the size and order with an edited plan. */
/** `language` keeps only projects in that learning language; absent mixes every language. */
export type SessionShape = { order?: string[]; projects?: SessionPick[]; language?: string };

/** The planned practice session for a size (5, 10, 20 or 30). Writes nothing. */
export async function getSessionPlan(size: number, shape: SessionShape = {}): Promise<SessionPlan> {
  const order = shape.order?.length ? `&order=${encodeURIComponent(shape.order.join(','))}` : '';
  const picks = shape.projects?.length ? `&projects=${encodeURIComponent(shape.projects.map((p) => `${p.island_id}:${p.count}`).join(','))}` : '';
  const lang = shape.language ? `&language=${encodeURIComponent(shape.language)}` : '';
  return json<SessionPlan>(await fetch(`${BASE}/review/session/plan?size=${size}${order}${picks}${lang}`, { headers: headers() }));
}

/** Every project with saved lines, for adding one to a session. */
export async function getSessionCatalogue(language?: string): Promise<SessionCatalogueItem[]> {
  const lang = language ? `?language=${encodeURIComponent(language)}` : '';
  return (await json<{ projects: SessionCatalogueItem[] }>(await fetch(`${BASE}/review/session/projects${lang}`, { headers: headers() }))).projects;
}

/** Starts a session: the same plan with a session id, and the row written. */
export async function startSession(size: number, shape: SessionShape = {}): Promise<SessionPlan> {
  return json<SessionPlan>(
    await fetch(`${BASE}/review/session/start`, {
      method: 'POST',
      headers: { ...headers(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ size, order: shape.order ?? [], projects: shape.projects ?? [], language: shape.language ?? '' }),
    }),
  );
}

export type ReviewFinished = { xp: number; coins: number; level: number; leveled_up: boolean; streak: number; first_of_day: boolean;
  /** The XP split for the summary rows; all 0 when nothing was paid. */
  breakdown?: { sentences: number; score: number; first: number; streak: number };
  progress: Progress;
};

/** Reports a finished daily review; the server pays XP and returns the new progress. */
export async function finishReviewSession(body: {
  session_id: string;
  sentences: number;
  seconds: number;
  avg_score?: number;
  lines?: { island_id: string; idx: number; seconds: number; score: number | null }[];
  completed?: boolean;
}): Promise<ReviewFinished> {
  const d = new Date();
  const local_day = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  return json<ReviewFinished>(
    await fetch(`${BASE}/review/session-finished`, {
      method: 'POST',
      headers: { ...headers(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...body, local_day }),
    }),
  );
}

// --- review-deck ---

/** A saved sentence in the review deck. `clip` plays a stored wav, `embed`
 * seeks the YouTube player to `start_s` and stops at `end_s`. */
export type ReviewCard = {
  id: string;
  island_id: string;
  idx: number;
  island_title: string;
  source: IslandSource;
  language: Language;
  native: NativeLanguage;
  ja: string;
  kana: string;
  romaji: string;
  en: string;
  words: Word[];
  duration: number;
  kind: 'clip' | 'embed';
  video_id: string;
  start_s: number;
  end_s: number;
  level: number;
  due_on: string;
  last_reviewed_on: string;
  reviews: number;
  lapses: number;
  created_at: string;
  /** BL-63: the grammar point an AI pick practises; empty on a starred line. */
  tag?: string;
};

export async function saveReviewCard(islandId: string, idx: number): Promise<ReviewCard> {
  const form = new FormData();
  form.append('island_id', islandId);
  form.append('idx', String(idx));
  return json<ReviewCard>(await expoFetch(`${BASE}/review/cards`, { method: 'POST', headers: headers(), body: form }));
}

/** BL-63: the AI picks 5 to 10 easy lines of a podcast episode and saves them as its practice set. */
export async function aiPickSentences(islandId: string): Promise<ReviewCard[]> {
  const r = await json<{ cards: ReviewCard[]; picked: number }>(
    await expoFetch(`${BASE}/islands/${encodeURIComponent(islandId)}/ai-picks`, { method: 'POST', headers: headers() }),
  );
  return r.cards;
}

export async function removeReviewCard(id: string): Promise<void> {
  await json<unknown>(await expoFetch(`${BASE}/review/cards/${id}`, { method: 'DELETE', headers: headers() }));
}

export async function listReviewCards(islandId?: string): Promise<ReviewCard[]> {
  const q = islandId ? `?island_id=${encodeURIComponent(islandId)}` : '';
  const r = await json<{ cards: ReviewCard[] }>(await expoFetch(`${BASE}/review/cards${q}`, { headers: headers() }));
  return r.cards;
}

/** All saved cards whose island still exists. The backend keeps a deleted
 * island's cards, so they are dropped here. When the island list cannot load,
 * the cards are returned as they are. */
export async function listLiveReviewCards(): Promise<ReviewCard[]> {
  const [cards, islands] = await Promise.all([listReviewCards(), listIslands().catch(() => null)]);
  if (!islands) return cards;
  const ids = new Set(islands.map((i) => i.id));
  return cards.filter((c) => ids.has(c.island_id));
}

export async function gradeReviewCard(id: string, result: 'again' | 'got'): Promise<ReviewCard> {
  const form = new FormData();
  form.append('result', result);
  return json<ReviewCard>(await expoFetch(`${BASE}/review/cards/${id}/grade`, { method: 'POST', headers: headers(), body: form }));
}

export type ReviewProject = { islandId: string; title: string; source: IslandSource; saved: number; due: number; latest: string };

/** Saved cards grouped by island: most due first, then most recently saved. */
export function reviewProjects(cards: ReviewCard[]): ReviewProject[] {
  const today = new Date().toISOString().slice(0, 10);
  const by = new Map<string, ReviewProject>();
  for (const c of cards) {
    const p = by.get(c.island_id) ?? { islandId: c.island_id, title: c.island_title, source: c.source, saved: 0, due: 0, latest: '' };
    p.saved += 1;
    if (c.due_on <= today) p.due += 1;
    if (c.created_at > p.latest) p.latest = c.created_at;
    by.set(c.island_id, p);
  }
  return [...by.values()].sort((a, b) => b.due - a.due || (a.latest < b.latest ? 1 : -1));
}
