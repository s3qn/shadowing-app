// Api domain: catch. Beta routes, catch-the-word, dev transcript review.
import { BASE, expoFetch, fetch } from '@/lib/api-http';
import { headers, json } from '@/lib/api-core';
import type { RubySegment } from '@/lib/api-types';

// --- launch-basics: beta routes ---
export type BetaAnswer = { admin: boolean; beta: boolean; youtube: boolean; podcast: boolean; import: boolean };
export type BetaPerson = { owner: string; handle: string | null; kind: 'user' | 'device'; enabled: boolean; me: boolean };

/** Which hidden features this principal may see. */
export async function getBeta(): Promise<BetaAnswer> {
  return json<BetaAnswer>(await fetch(`${BASE}/beta`, { headers: headers() }));
}

/** Admin only: everyone who can be switched on. A 403 throws an error with `status` 403. */
export async function adminListBeta(): Promise<BetaPerson[]> {
  const res = await fetch(`${BASE}/admin/beta`, { headers: headers() });
  if (res.status === 403) throw Object.assign(new Error('not_admin'), { status: 403 });
  return (await json<{ people: BetaPerson[] }>(res)).people;
}

/** Admin only: switch the beta features on or off for one owner. */
export async function adminSetBeta(owner: string, enabled: boolean): Promise<void> {
  const res = await fetch(`${BASE}/admin/beta`, {
    method: 'PUT',
    headers: { ...headers(), 'Content-Type': 'application/json' },
    body: JSON.stringify({ owner, enabled }),
  });
  if (res.status === 403) throw Object.assign(new Error('not_admin'), { status: 403 });
  await json<unknown>(res);
}
// --- end launch-basics ---

// --- catch-the-word ---

/** One word to listen for in a video: its first fitting occurrence, timed
 * like `lines[].words[]` (seconds from the line's start). `ruby` is null for
 * Spanish. `state` is `due` for a word with a card whose review is due. */
export type CatchTarget = {
  id: string;
  text: string;
  ruby: RubySegment[] | null;
  line_idx: number;
  word_index: number;
  start: number;
  end: number;
  count: number;
  meaning: string;
  sentence: string;
  sentence_translation: string;
  state: 'new' | 'due';
};

export type CatchWords = { language: string; native: string; targets: CatchTarget[] };

/** The video's own words heard twice or more, ranked by count, one per line,
 * at most 60. 409 `no_words` when nothing fits. */
export class WordsPendingError extends Error {
  constructor() {
    super('words_pending');
  }
}

export async function catchWords(islandId: string): Promise<CatchWords> {
  const res = await fetch(`${BASE}/catch/islands/${islandId}/words`, { headers: headers() });
  // 409 words_pending: captions.json is not written yet, the caller retries.
  if (res.status === 409 && (await res.clone().text().catch(() => '')).includes('words_pending')) {
    throw new WordsPendingError();
  }
  return json<CatchWords>(res);
}

/** One word's meaning, made on the server if it is not cached yet. Empty when it could not be. */
export async function catchMeaning(islandId: string, word: string): Promise<string> {
  const res = await json<{ word: string; meaning: string }>(
    await fetch(`${BASE}/catch/islands/${islandId}/meaning?word=${encodeURIComponent(word)}`, { headers: headers() }),
  );
  return res.meaning ?? '';
}

// --- bl72-known-words ---
export type CatchCollectionWord = {
  word: string;
  meaning: string;
  sentence: string;
  island_id: string;
  state: 'known' | 'learning';
  caught: number;
  missed: number;
  reviews: number;
  due: string;
};

export type CatchCollection = { language: string; total: number; learning: number; known: number; words: CatchCollectionWord[] };

/** Every word this device has caught in the language, newest first. Read only. */
export async function catchCollection(language: string): Promise<CatchCollection> {
  return json<CatchCollection>(await fetch(`${BASE}/catch/words?language=${encodeURIComponent(language)}`, { headers: headers() }));
}
// --- end bl72-known-words ---

export type CatchReview = { word: string; due: string; state: string; reviews: number };

/** One graded catch: the server schedules the word's next review. */
export async function catchReview(islandId: string, word: string, caught: boolean, knew: boolean): Promise<CatchReview> {
  const form = new FormData();
  form.append('island_id', islandId);
  form.append('word', word);
  form.append('caught', caught ? '1' : '0');
  form.append('knew', knew ? '1' : '0');
  return json<CatchReview>(await expoFetch(`${BASE}/catch/review`, { method: 'POST', headers: headers(), body: form }));
}

// --- transcript-review --- dev only: judging ASR candidates on the gold videos.
export type TranscriptVideo = { id: string; channel: string; title: string; n_candidates: number; has_words: boolean[] };
export type TranscriptWord = { text: string; start: number; end: number };
export type TranscriptLine = { start: number; end: number; text: string; words: TranscriptWord[] | null };
export type TranscriptCandidate = { label: string; has_words: boolean; lines: TranscriptLine[] };
export type TranscriptTagBody = { session: string; video: string; label: string; tag: string; playerTime: number; lineIndex: number; lineText: string };

const trUrl = (path: string) => `${BASE}/dev/transcripts${path}`;
const trPost = (path: string, body: unknown) =>
  fetch(trUrl(path), { method: 'POST', headers: { ...headers(), 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

/** The gold videos with candidates; null on 404 or any error (prod, or no dev router). */
export async function listTranscripts(): Promise<TranscriptVideo[] | null> {
  if (!__DEV__) return null;
  try {
    const res = await fetch(trUrl(''), { headers: headers() });
    if (!res.ok) return null;
    const body = (await res.json()) as { videos?: TranscriptVideo[] } | TranscriptVideo[];
    return Array.isArray(body) ? body : (body.videos ?? []);
  } catch {
    return null;
  }
}

/** Every candidate of one video under blind labels. */
export async function getTranscriptVideo(video: string, session: string): Promise<TranscriptCandidate[]> {
  const res = await fetch(trUrl(`/${encodeURIComponent(video)}?session=${encodeURIComponent(session)}`), { headers: headers() });
  const body = await json<{ candidates: TranscriptCandidate[] }>(res);
  return body.candidates ?? [];
}

/** True when the server wrote the record. */
export async function postTranscriptTag(body: TranscriptTagBody): Promise<boolean> {
  try {
    return (await trPost('/tag', body)).ok;
  } catch {
    return false;
  }
}

export async function postTranscriptUndo(session: string): Promise<boolean> {
  try {
    return (await trPost('/undo', { session })).ok;
  } catch {
    return false;
  }
}

export async function postTranscriptScore(body: { session: string; video: string; label: string; score: number }): Promise<boolean> {
  try {
    return (await trPost('/score', body)).ok;
  } catch {
    return false;
  }
}
