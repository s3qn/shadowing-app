// Api domain: catch. Beta routes, catch-the-word, dev transcript review.
import { BASE, expoFetch, fetch } from '@/lib/api-http';
import { adminKeyId, adminPublicKey, deviceLabel, loadAdminKey } from '@/lib/admin-device';
import { adminHeaders, headers, json, parseDetail } from '@/lib/api-core';
import type { RubySegment } from '@/lib/api-types';

// --- launch-basics: beta routes ---
/** lang-core: `languages` lists the learning languages this device may pick,
 * each with the speaker `backend/voices.py` defaults to. An older prod has no
 * such field, which the client reads as ja/es/en. */
export type BetaAnswer = {
  admin: boolean;
  beta: boolean;
  youtube: boolean;
  podcast: boolean;
  import: boolean;
  languages?: { id: string; speaker: number }[];
};
export type BetaPerson = { owner: string; handle: string | null; kind: 'user' | 'device'; enabled: boolean; me: boolean };

/** Which hidden features this principal may see. */
export async function getBeta(): Promise<BetaAnswer> {
  return json<BetaAnswer>(await fetch(`${BASE}/beta`, { headers: headers() }));
}

/** admin-device-bound: a 403 carries the server's code (`not_admin`, or
 * `admin_device` when the account is listed but this phone is not approved). */
export type AdminRefused = Error & { status: 403; code: string };

async function refused(res: Response): Promise<AdminRefused> {
  const detail = parseDetail(await res.text().catch(() => ''));
  const code = detail && typeof detail === 'object' ? detail.code : 'not_admin';
  return Object.assign(new Error(code), { status: 403 as const, code });
}

/** The admin list, and `device: 'approved'` when the server checked this
 * phone's proof (null for a dev device principal that needs none). */
export type AdminBetaList = { people: BetaPerson[]; device: 'approved' | null };

/** Admin only: everyone who can be switched on. A 403 throws an `AdminRefused`. */
export async function adminListBeta(): Promise<AdminBetaList> {
  const res = await fetch(`${BASE}/admin/beta`, { headers: await adminHeaders('GET', '/admin/beta') });
  if (res.status === 403) throw await refused(res);
  const out = await json<{ people: BetaPerson[]; device?: string | null }>(res);
  return { people: out.people, device: out.device === 'approved' ? 'approved' : null };
}

/** Admin only: switch the beta features on or off for one owner. A 403 throws an `AdminRefused`. */
export async function adminSetBeta(owner: string, enabled: boolean): Promise<void> {
  // The proof signs these exact bytes, so the string is built once.
  const body = JSON.stringify({ owner, enabled });
  const res = await fetch(`${BASE}/admin/beta`, {
    method: 'PUT',
    headers: { ...(await adminHeaders('PUT', '/admin/beta', body)), 'Content-Type': 'application/json' },
    body,
  });
  if (res.status === 403) throw await refused(res);
  await json<unknown>(res);
}

/** admin-device-bound: registers this phone's public key under the signed-in
 * account and returns its status (`pending`, `approved` or `revoked`).
 * Approval happens on the server box, or until launch through
 * adminApproveDevice with the passcode. Throws on any error,
 * including 429 `admin_pending_cap` (too many pending keys on the account),
 * which the Admin screen shows as its failed note. */
export async function adminEnrolDevice(): Promise<AdminDeviceStatus> {
  await loadAdminKey();
  const res = await fetch(`${BASE}/admin/device`, {
    method: 'POST',
    headers: { ...headers(), 'Content-Type': 'application/json' },
    body: JSON.stringify({ key_id: adminKeyId(), public_key: adminPublicKey(), name: deviceLabel() }),
  });
  return (await json<{ status: AdminDeviceStatus }>(res)).status;
}
export type AdminDeviceStatus = 'pending' | 'approved' | 'revoked';

/** Until launch: approves this phone's own pending key with the server's
 * passcode. `wrong` is 403 bad_passcode, `later` is 429 (too many wrong
 * codes on the account), `failed` is anything else, the route switched off
 * (404) included. Never throws. */
export type AdminApproveResult = 'approved' | 'wrong' | 'later' | 'failed';
export async function adminApproveDevice(passcode: string): Promise<AdminApproveResult> {
  try {
    await loadAdminKey();
    const res = await fetch(`${BASE}/admin/device/approve`, {
      method: 'POST',
      headers: { ...headers(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ key_id: adminKeyId(), passcode }),
    });
    if (res.ok) return 'approved';
    if (res.status === 429) return 'later';
    if (res.status === 403) {
      const detail = parseDetail(await res.text().catch(() => ''));
      if (detail && typeof detail === 'object' && detail.code === 'bad_passcode') return 'wrong';
    }
    return 'failed';
  } catch {
    return 'failed';
  }
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
