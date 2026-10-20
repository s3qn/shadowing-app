/**
 * Client for the shadowing backend.
 *
 * The service lives on the dev box behind a cloudflared route and is guarded by
 * a bearer token, so both the base URL and the token come from EXPO_PUBLIC_ env
 * vars that Expo inlines at bundle time. Set them in .env at the project root.
 *
 * Uploads go through expo/fetch with an expo-file-system File. React Native
 * 0.86 dropped the old {uri, name, type} object hack for FormData parts, and
 * throws "Unsupported FormDataPart implementation" if you try it.
 */

import { Platform } from 'react-native';
import { fetch as expoFetchRaw } from 'expo/fetch';
import { Directory, File, Paths } from 'expo-file-system';

import type { ArtSpec, Slot } from '@/constants/cosmetics';
import { accessTokenSync } from '@/lib/auth';
import { deviceIdSync } from '@/lib/device';
import { t } from '@/lib/i18n';
import type { StarterLevel } from '@/lib/settings';
import { en, type Key } from '@/locales/en';

/** A request that never reached the server (offline, DNS, TLS) rejects with
 * the platform's English "Network request failed", and screens show
 * `e.message`. Say it in the reader's language instead. An abort passes
 * through untouched for the caller that asked for it. */
function unreachable(e: unknown): never {
  if (e instanceof Error && e.name === 'AbortError') throw e;
  throw new Error(t('api.unreachable'));
}
const fetch: typeof globalThis.fetch = (input, init) => globalThis.fetch(input, init).catch(unreachable);
const expoFetch: typeof expoFetchRaw = (input, init) => expoFetchRaw(input, init).catch(unreachable);

const BASE = process.env.EXPO_PUBLIC_SHADOW_API_URL ?? '';
const TOKEN = process.env.EXPO_PUBLIC_SHADOW_TOKEN ?? '';
// Icon paths from the backend are absolute (/shadow/...), so they hang off the
// origin rather than off BASE.
const ORIGIN = BASE.replace(/\/shadow\/?$/, '');

export type Complexity = 'simple' | 'complex';

/** Speech register for generated Japanese: です/ます polite, or plain casual
 * form. Keep in sync with `Register` in `src/lib/settings.ts`. */
export type Register = 'polite' | 'casual';

/** The learning language an island was built in. */
export type Language = 'ja' | 'es' | 'en';

/** One syllable of the synthesized line, with the timing VOICEVOX reported. */
export type Mora = {
  text: string;
  kana: string;
  start: number;
  end: number;
  phrase: number;
  /** Pitch, true on a high mora; missing on islands built before accent marks existed, null when the backend could not recover it. */
  high?: boolean | null;
};

/** One run of a word's text with the reading shown above it; rt is empty for kana, digits and punctuation. */
export type RubySegment = { text: string; rt: string };

/** Coarse part of speech group used to colour a word's underline. Keep the
 * five names in sync with `_POS_GROUP`/`_pos_group` in `backend/segment.py`. */
export type PosGroup = 'noun' | 'verb' | 'adjective' | 'particle' | 'other';

/** One word of a line with the span of audio it is spoken in. `ruby` is
 * missing only on lines served by a backend older than furigana. `pos` is
 * missing on lines from a backend older than the pos underline. */
export type Word = { text: string; start: number; end: number; ruby?: RubySegment[]; pos?: PosGroup };

/** A stretch of a line's rendered audio, in milliseconds at the requested speed. */
export type AudioSpan = { startMs: number; endMs: number };

export type Line = {
  idx: number;
  ja: string;
  kana: string;
  romaji: string;
  en: string;
  duration: number;
  timeline: Mora[];
  words: Word[];
  /** Where this line starts in the source audio, in seconds. */ // youtube-shadowing
  offset?: number;
  /** Tatoeba sentence id when the line came from the corpus (voice topics). */
  tatoeba_id?: number | null;
  /** Grammar islands: the exact piece of `ja` that realises the point, '' when none. */
  span?: string;
};

export type SpeakerStyle = { id: number; name: string; icon: string };
export type Speaker = { uuid: string; name: string; policy: string; styles: SpeakerStyle[] };

/** The language the learner already understands, `native` on the island. */
export type NativeLanguage = 'he' | 'en';

/** How an island was made. */ // youtube-shadowing
export type IslandSource = 'voice' | 'phrases' | 'import' | 'podcast' | 'youtube' | 'grammar' | 'starter';

export type IslandSummary = {
  id: string;
  title: string;
  status: 'pending' | 'working' | 'ready' | 'failed';
  stage: string;
  complexity: Complexity;
  language: Language;
  native: NativeLanguage;
  created_at: string;
  line_count: number;
  source?: IslandSource; // youtube-shadowing
  /** False when line 0 has no audio file (a captions-only island). Absent from an older backend: treat as true. */
  has_audio?: boolean;
};

/** A code the backend sends (`daily_limit`, `no_lines`, `transcribing`) is only
 * a catalogue key if the catalogue actually holds it. An older client meeting a
 * newer backend must fall back, not show the person "islandError.some_new_code". */
function codeKey(prefix: 'api' | 'islandError' | 'stage', code: string): Key | undefined {
  const key = `${prefix}.${code}`;
  return key in en ? (key as Key) : undefined;
}

/** What each backend build stage means to the person waiting for it. */
export function stageLabel(stage: string): string {
  return t(codeKey('stage', stage) ?? 'stage.working');
}

export type Island = IslandSummary & {
  error: string;
  /** Machine-readable twin of `error`. Empty for an island that failed before
   * the backend started sending codes, and for the catch-all failure paths. */
  error_code: string;
  speaker: number;
  transcript: string;
  lines: Line[];
  /** How the island was made. Only a recorded ('voice') island can be
   * re-voiced or regenerated. Absent in a local copy saved before the client
   * read it. */
  source?: IslandSource;
  /** The grammar point id on a grammar island. */
  source_name?: string;
  /** bl58-easy-for-me: line idxs marked Easy for me. Absent in a copy cached before this build. */
  known?: number[];
};

/** Why an island failed, in the reader's language. Falls back to the English
 * sentence the backend also sends, so an unknown code still says something. */
export function islandErrorText(island: { error?: string; error_code?: string }): string {
  const key = island.error_code ? codeKey('islandError', island.error_code) : undefined;
  if (key) return t(key);
  return island.error || t('islandError.unknown');
}

/** The signed-in access token for URLs that cannot carry headers (the player,
 * Image), the same split the device id uses. Empty when signed out. */
function userParam(): string {
  const user = accessTokenSync();
  return user ? `&user=${encodeURIComponent(user)}` : '';
}

/** Adds the current access token to a URL built by lineAudioUrl, at the
 * moment it is handed to the player or a download. The logical URL stays
 * token-free, so a token refresh does not look like a new source. */
export function withUser(url: string): string {
  return `${url}${userParam()}`;
}

function headers(): Record<string, string> {
  const h: Record<string, string> = { Authorization: `Bearer ${TOKEN}`, 'X-Shadow-Device': deviceIdSync() };
  const user = accessTokenSync();
  if (user) h['X-Shadow-User'] = user;
  return h;
}

/** Turns any failed response into a short, readable message. Gateway errors
 * (the tunnel could not reach the server) come back as full HTML pages, which
 * are useless on a phone screen. */
async function json<T>(res: Response): Promise<T> {
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    // FastAPI sends `detail` as a plain string for developer errors, and as an
    // object carrying a code plus its values for anything a person reads. A
    // gateway error is neither: it arrives as a full HTML page.
    const detail = parseDetail(body);
    if (detail && typeof detail === 'object') {
      const key = codeKey('api', detail.code);
      if (key) throw new Error(t(key, scalarsOf(detail)));
    }
    if (res.status === 502 || res.status === 503 || res.status === 504) {
      throw new Error(t('api.unreachable'));
    }
    if (res.status === 429) {
      throw new Error(t('api.daily_limit_any'));
    }
    // A plain-string detail is English developer text: never shown, only the status.
    throw new Error(t('api.requestFailed', { status: res.status }));
  }
  return (await res.json()) as T;
}

/** The values a message can interpolate: `{limit}` and its like, never a
 * nested object. */
function scalarsOf(detail: Record<string, unknown>): Record<string, string | number> {
  const out: Record<string, string | number> = {};
  for (const [name, value] of Object.entries(detail)) {
    if (typeof value === 'string' || typeof value === 'number') out[name] = value;
  }
  return out;
}

/** The `detail` of a FastAPI error, when the body is JSON at all. */
function parseDetail(body: string): string | ({ code: string } & Record<string, unknown>) | null {
  try {
    const parsed = JSON.parse(body) as { detail?: unknown };
    const detail = parsed.detail;
    if (typeof detail === 'string') return detail;
    if (detail && typeof detail === 'object' && typeof (detail as { code?: unknown }).code === 'string') {
      return detail as { code: string } & Record<string, unknown>;
    }
  } catch {
    // Not JSON: an HTML gateway page, or an empty body.
  }
  return null;
}

export function configured(): boolean {
  return BASE.length > 0 && TOKEN.length > 0;
}

export async function health(): Promise<boolean> {
  try {
    const res = await fetch(`${BASE}/health`, { headers: headers() });
    return res.ok;
  } catch {
    return false;
  }
}

export type ReviewVerdict = 'accept' | 'fix' | 'remove';
export type ReviewStep = {
  id: string;
  title: string;
  route: string;
  params?: Record<string, string>;
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

export async function listIslands(): Promise<IslandSummary[]> {
  return json<IslandSummary[]>(await fetch(`${BASE}/islands`, { headers: headers() }));
}

export async function getIsland(id: string): Promise<Island> {
  return (await getIslandWithText(id)).island;
}

/** The island and the raw body it was parsed from, which the local copy in
 * island-cache.ts stores and compares against. */
export async function getIslandWithText(id: string): Promise<{ island: Island; text: string }> {
  const text = await getIslandText(id);
  const island = JSON.parse(text) as Island;
  return { island, text };
}

/** The island's raw JSON body, unparsed, so a caller holding a local copy
 * can compare the two and skip the parse when nothing changed. Throws like
 * the other calls on a failed response. */
export async function getIslandText(id: string): Promise<string> {
  const res = await fetch(`${BASE}/islands/${id}`, { headers: headers() });
  if (!res.ok) await json<Island>(res); // throws on a failed response
  return res.text();
}

/** Remove an island, its lines and its audio. There is no undo. */
export async function deleteIsland(id: string): Promise<void> {
  await json<unknown>(await fetch(`${BASE}/islands/${id}`, { method: 'DELETE', headers: headers() }));
}

/**
 * Upload a recording and start the pipeline. Returns as soon as the file is
 * accepted; the island builds in the background, so poll getIsland after this.
 */
export async function createIsland(
  uri: string,
  complexity: Complexity,
  speaker: number,
  // Register only applies to Japanese: undefined for any other learning
  // language, so the form omits it and the backend falls back to its own
  // default rather than being sent a value nothing on screen offered.
  register: Register | undefined = 'polite',
  count = 8,
  language: Language = 'ja',
  native: NativeLanguage = 'en',
  // A spoken topic: the backend builds a phrase island from corpus sentences.
  topic = false,
): Promise<{ id: string }> {
  const form = new FormData();
  form.append('audio', new File(uri), 'recording.m4a');
  form.append('complexity', complexity);
  if (register) form.append('register', register);
  form.append('speaker', String(speaker));
  form.append('count', String(count));
  form.append('language', language);
  form.append('native', native);
  if (topic) form.append('topic', '1');

  return json<{ id: string }>(
    await expoFetch(`${BASE}/islands`, { method: 'POST', headers: headers(), body: form }),
  );
}

/** Rewrite and re-voice an island at the given complexity from its stored recording. Poll getIsland until ready. */
export async function regenerate(id: string, complexity: Complexity): Promise<void> {
  const form = new FormData();
  form.append('complexity', complexity);
  const res = await expoFetch(`${BASE}/islands/${id}/regenerate`, {
    method: 'POST',
    headers: headers(),
    body: form,
  });
  await json<unknown>(res);
}

export async function renameIsland(id: string, title: string): Promise<void> {
  const form = new FormData();
  form.append('title', title);
  const res = await expoFetch(`${BASE}/islands/${id}/title`, {
    method: 'PATCH',
    headers: headers(),
    body: form,
  });
  await json<unknown>(res);
}

export async function listSpeakers(language: Language = 'ja'): Promise<Speaker[]> {
  return json<Speaker[]>(
    await fetch(`${BASE}/speakers?language=${encodeURIComponent(language)}`, { headers: headers() }),
  );
}

/** One item in a podcast feed, matching `podcast.py`'s `parse_feed()`. */
export type PodcastEpisode = {
  title: string;
  published: string | null;
  duration_s: number | null;
  audio_url: string;
  bytes: number | null;
};

/** Fetch and parse a podcast RSS feed so an episode can be picked to import. */
export async function podcastEpisodes(url: string): Promise<{ title: string; episodes: PodcastEpisode[] }> {
  return json<{ title: string; episodes: PodcastEpisode[] }>(
    await fetch(`${BASE}/podcasts/episodes?url=${encodeURIComponent(url)}`, { headers: headers() }),
  );
}

/** One show in the hand-picked podcast catalog, or one search result normalised to the same shape. */
export type PodcastShow = {
  collectionId: number | null;
  title: string;
  feedUrl: string;
  artworkUrl: string | null;
  level: 'beginner' | 'intermediate' | 'advanced' | null;
  tagline: string | null;
};

export type PodcastSection = { id: string; title: string; subtitle: string; shows: PodcastShow[] };
export type PodcastCatalog = { sections: PodcastSection[] };

/** The hand-picked catalog of browsable shows for a learning language. Its
 * section copy and show taglines are editorial text that lives on the
 * server, so the interface language travels with the request as `ui` and the
 * server writes them in it: someone learning Japanese while reading Hebrew
 * gets Hebrew section copy over Japanese shows. */
export async function podcastCatalog(language: Language, ui: string): Promise<PodcastCatalog> {
  return json<PodcastCatalog>(
    await fetch(`${BASE}/podcasts/catalog?language=${encodeURIComponent(language)}&ui=${encodeURIComponent(ui)}`, {
      headers: headers(),
    }),
  );
}

/** Resolve a typed query, an Apple Podcasts link, or a raw feed URL to a list of shows. */
export async function podcastSearch(q: string, language: Language): Promise<PodcastShow[]> {
  const out = await json<{ results: PodcastShow[] }>(
    await fetch(`${BASE}/podcasts/search?q=${encodeURIComponent(q)}&language=${encodeURIComponent(language)}`, {
      headers: headers(),
    }),
  );
  return out.results;
}

/** Download a podcast episode by URL and build an island from it. Poll getIsland until ready. */
export async function importPodcastEpisode(
  audioUrl: string,
  title: string,
  speaker: number,
  language: Language = 'ja',
  native: NativeLanguage = 'en',
  startMin = 0,
): Promise<{ id: string }> {
  const form = new FormData();
  form.append('audio_url', audioUrl);
  form.append('title', title);
  form.append('speaker', String(speaker));
  form.append('language', language);
  form.append('native', native);
  form.append('start_min', String(startMin));

  return json<{ id: string }>(
    await expoFetch(`${BASE}/podcasts/import`, { method: 'POST', headers: headers(), body: form }),
  );
}

/** Absolute URL for a style icon path returned by listSpeakers. */
export function iconUrl(path: string): string {
  return `${ORIGIN}${path}?token=${encodeURIComponent(TOKEN)}&device=${encodeURIComponent(deviceIdSync())}${userParam()}`;
}

/** The fixed preview sentence rendered in one voice. */
export function voicePreviewUrl(styleId: number): string {
  return `${BASE}/voices/${styleId}/preview?token=${encodeURIComponent(TOKEN)}&device=${encodeURIComponent(deviceIdSync())}${userParam()}`;
}

/** Re-render an island's lines in another voice. Poll getIsland until ready. */
export async function revoice(id: string, speaker: number): Promise<void> {
  const form = new FormData();
  form.append('speaker', String(speaker));
  const res = await expoFetch(`${BASE}/islands/${id}/revoice`, {
    method: 'POST',
    headers: headers(),
    body: form,
  });
  await json<unknown>(res);
}

export async function postPracticeEvent(islandId: string, seconds: number): Promise<{ award?: { xp: number } }> {
  const form = new FormData();
  form.append('island_id', islandId);
  form.append('seconds', String(seconds));
  const res = await expoFetch(`${BASE}/schedule/practice`, { method: 'POST', headers: headers(), body: form });
  return json<{ award?: { xp: number } }>(res);
}

// --- bl58-easy-for-me ---
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

export type GlossSense = { pos: string[]; glosses: string[] };
export type GlossEntry = { kanji: string[]; kana: string[]; senses: GlossSense[] };
export type Gloss = { word: string; base: string; reading: string; entries: GlossEntry[]; found: boolean };

const glossCache = new Map<string, Gloss>();

export async function gloss(word: string): Promise<Gloss> {
  const hit = glossCache.get(word);
  if (hit) return hit;
  const out = await json<Gloss>(
    await fetch(`${BASE}/gloss?word=${encodeURIComponent(word)}`, { headers: headers() }),
  );
  glossCache.set(word, out);
  return out;
}

/** Every word's meanings for one island in a single request, for the offline
 * download. Returns {} on any failure (an older backend has no such route), so
 * a download still completes without meanings. */
export async function offlineGlosses(id: string): Promise<Record<string, Gloss>> {
  try {
    const res = await fetch(`${BASE}/islands/${id}/glosses`, { headers: headers() });
    if (!res.ok) return {};
    return (await res.json()) as Record<string, Gloss>;
  } catch {
    return {};
  }
}

/** How a word functions in the particular sentence it was tapped in. Cached
 * server side, keyed on (word, sentence). Empty string means the backend
 * tried and had nothing to say, not a failure the caller needs to surface. */
export async function explainWord(
  word: string,
  sentenceJa: string,
  sentenceEn: string,
  language: Language = 'ja',
  native: NativeLanguage = 'en',
): Promise<string> {
  const q = `word=${encodeURIComponent(word)}&sentence_ja=${encodeURIComponent(sentenceJa)}&sentence_en=${encodeURIComponent(sentenceEn)}&language=${encodeURIComponent(language)}&native=${encodeURIComponent(native)}`;
  const out = await json<{ context: string }>(await fetch(`${BASE}/explain-word?${q}`, { headers: headers() }));
  return out.context;
}

/** One turn of the Explain chat thread. */
export type ChatTurn = { role: 'user' | 'assistant'; text: string };

/** One vocabulary item in a structured Explain answer. `pos` uses the same
 * groups as the part-of-speech underline (see `PosGroup`), so a vocab row's
 * colour bar can match the word's underline in the sentence above it. */
export type ExplainVocabItem = { word: string; reading: string; meaning: string; pos: PosGroup };

/** One grammar point in a structured Explain answer. `span`, when present, is
 * the exact substring of the sentence being explained where the pattern
 * appears, validated server side to actually be a substring: safe to search
 * for verbatim to highlight it in place. */
export type ExplainGrammarItem = { pattern: string; explanation: string; span?: string };

/** A structured Explain answer. Any of the three sections may be missing:
 * the backend omits a section entirely rather than send it empty. */
export type ExplainAnswer = {
  vocab?: ExplainVocabItem[];
  grammar?: ExplainGrammarItem[];
  summary?: string;
};

/** Ask one question about a sentence, optionally about `marked` words within
 * it, with the thread so far for context. The thread itself lives in client
 * state; nothing here is persisted server side. */
export async function explainChat(body: {
  sentenceJa: string;
  sentenceEn: string;
  marked: string[];
  question: string;
  history: ChatTurn[];
  language?: Language;
  native?: NativeLanguage;
}): Promise<ExplainAnswer> {
  return json<ExplainAnswer>(
    await fetch(`${BASE}/explain-chat`, {
      method: 'POST',
      headers: { ...headers(), 'Content-Type': 'application/json' },
      body: JSON.stringify({
        sentence_ja: body.sentenceJa,
        sentence_en: body.sentenceEn,
        marked: body.marked,
        question: body.question,
        history: body.history,
        language: body.language ?? 'ja',
        native: body.native ?? 'en',
      }),
    }),
  );
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

/** One word rendered on its own in the given voice. */
export function wordAudioUrl(text: string, speaker: number): string {
  return `${BASE}/word-audio?text=${encodeURIComponent(text)}&speaker=${speaker}&token=${encodeURIComponent(TOKEN)}&device=${encodeURIComponent(deviceIdSync())}${userParam()}`;
}

/**
 * Audio URL for one line. The token rides as a query parameter because the
 * audio player fetches this itself and cannot attach the auth header. It
 * carries no access token: pass it through withUser where it leaves the app.
 */
export function lineAudioUrl(
  islandId: string,
  idx: number,
  version: number | string = 0,
  speed = 1,
  padMs = 0,
  span: AudioSpan | null = null,
): string {
  // `v` changes with the voice and with every regeneration so a replaced line is never served from cache.
  // `speed` asks the backend for a natively slower or faster render.
  // `padMs`, when positive, is silence the backend appends so the player can loop natively with a breath.
  const s = speed.toFixed(2);
  const pad = padMs > 0 ? `&pad=${Math.round(padMs)}` : '';
  // `start`/`end` ask for only that stretch of the render, cut on the backend, so a phrase loops natively like a line.
  const range = span ? `&start=${Math.round(span.startMs)}&end=${Math.round(span.endMs)}` : '';
  return `${BASE}/islands/${islandId}/lines/${idx}/audio?token=${encodeURIComponent(TOKEN)}&device=${encodeURIComponent(deviceIdSync())}&v=${version}&speed=${s}${pad}${range}`;
}

/**
 * Download the island as one m4a into the app's cache folder and return the
 * file. Blocking on the server while it renders any missing speed and runs
 * ffmpeg, so the first call at a new speed takes a few seconds.
 */
export async function exportIsland(
  islandId: string,
  speed: number,
  gapMs: number,
  repeats: number,
  fileName: string,
): Promise<File> {
  const dir = new Directory(Paths.cache, 'exports');
  if (!dir.exists) dir.create({ intermediates: true, idempotent: true });
  const url = `${BASE}/islands/${islandId}/export?speed=${speed.toFixed(2)}&repeats=${repeats}&gap=${Math.round(gapMs)}`;
  return File.downloadFileAsync(url, new File(dir, fileName), { headers: headers(), idempotent: true });
}

/** How one word of a scored take lines up against the reference: on time,
 * early, late, dropped out, or not scored (outside a phrase span, or the
 * take could not be scored at all). */
export type WordMark = 'ok' | 'early' | 'late' | 'dropped' | 'none';

/** Timing score for a take, index-aligned with the line's words. `behindMs`
 * is the take's median offset against the reference minus the Lag setting,
 * null when nothing could be scored; `note` explains why when it is empty
 * for none of the words. */
export type TakeScore = {
  words: WordMark[];
  offsetsMs: (number | null)[];
  behindMs: number | null;
  anchor: 'echo' | 'clock' | null;
  note: string;
  /** 0..100 blend of content, timing and pitch; null when unscorable. Absent in score files saved before it existed. */
  total?: number | null;
  parts?: { content: number | null; timing: number | null; pitch: number | null };
  /** What the speech recogniser heard in the take. */
  heard?: string;
  totalNote?: string;
};

/** What makes a mora take longer to say than a plain short one, when known. */
export type MoraKind = 'long' | 'geminate' | 'n' | null;

/** How a mora's length compared to the line: `'ok'`, cut short (`'clipped'`),
 * not said at all (`'none'`), or not judged (`null`). */
export type LengthMark = 'ok' | 'clipped' | 'none' | null;

/** Whether a phrase's pitch fall landed on this mora: `'hit'`, `'miss'`, not
 * said (`'none'`), or not the phrase's nucleus (`null`). */
export type NucleusMark = 'hit' | 'miss' | 'none' | null;

/** One mora of a take's analysis, indexed into the line's `timeline` by `i`.
 * `lineSt`/`takeSt` are mean semitones per mora, centred on that voice's own
 * median, null where unvoiced. */
export type AnalysedMora = {
  i: number;
  text: string | null;
  kind: MoraKind;
  lineMs: number;
  takeMs: number | null;
  length: LengthMark;
  high: boolean | null;
  lineSt: number | null;
  takeSt: number | null;
  nucleus: NucleusMark;
};

/** Length and pitch feedback for a take, per mora inside the take's span. A
 * non-empty `note` ("Take too noisy to analyse", "No voice heard in the
 * take", "Could not follow the take") means every mark is `'none'`. `curve`
 * is deliberately left off this type: the row draws per mora and the stored
 * copy must not carry two 10 ms point lists. */
export type TakeAnalysis = {
  note: string;
  aligned: 'dtw' | 'offset' | null;
  coverage: number;
  moras: AnalysedMora[];
};

/** Result of an echo cancellation pass on an uploaded take, or a calibration recording. */
export type TakeClean = {
  cleaned: boolean;
  erleDb: number | null;
  delayMs: number | null;
  driftSamples: number | null;
  note: string;
  /** Missing on a calibration upload. */
  score?: TakeScore;
  /** Missing on a calibration upload. */
  analysis?: TakeAnalysis;
  /** The XP this take earned; missing on a calibration upload or a failed award. */
  award?: { xp: number };
};

/**
 * Upload a take (or a calibration recording, when `calibrate` is true) and run
 * the echo canceller against the line's reference audio. For a calibration
 * upload this replaces the stored speaker profile instead of cleaning a take.
 * `cleaned` is false when no echo was found (earphones) or no profile exists
 * yet; then there is nothing to fetch from cleanTakeUrl. `span`, when set, is
 * the phrase that was playing while the take was recorded, so the cleaner's
 * reference matches it. `lagMs` is the phone's Lag setting and `lineStartMs`
 * is when the line's first audio played, measured from the start of the
 * recording; both feed the take's timing score and are ignored for a
 * calibration upload. `guide` marks the first-run guide's shadow take.
 */
export async function uploadTake(
  islandId: string,
  idx: number,
  uri: string,
  speed: number,
  calibrate = false,
  span: AudioSpan | null = null,
  lagMs = 0,
  lineStartMs: number | null = null,
  guide = false,
): Promise<TakeClean> {
  const form = new FormData();
  form.append('take', new File(uri), 'take.wav');
  form.append('speed', speed.toFixed(2));
  form.append('calibrate', calibrate ? '1' : '0');
  if (span) {
    form.append('start', String(Math.round(span.startMs)));
    form.append('end', String(Math.round(span.endMs)));
  }
  form.append('lag', String(Math.round(lagMs)));
  if (lineStartMs !== null) {
    form.append('line_start', String(Math.round(lineStartMs)));
  }
  if (guide) form.append('guide', '1');

  return json<TakeClean>(
    await expoFetch(`${BASE}/islands/${islandId}/lines/${idx}/take`, {
      method: 'POST',
      headers: headers(),
      body: form,
    }),
  );
}

/**
 * URL of the whole podcast episode as one m4a, built like lineAudioUrl: the
 * token and device ride as query parameters, no access token (pass it
 * through withUser where it leaves the app).
 */
export function episodeAudioUrl(islandId: string): string {
  return `${BASE}/islands/${islandId}/episode?token=${encodeURIComponent(TOKEN)}&device=${encodeURIComponent(deviceIdSync())}`;
}

/**
 * URL for the cleaned version of a take. The token rides as a query
 * parameter for the same reason it does on lineAudioUrl, and `version` (the
 * take's recordedAt) keeps the player from ever loading a stale cached file.
 */
export function cleanTakeUrl(islandId: string, idx: number, version: number): string {
  return `${BASE}/islands/${islandId}/lines/${idx}/take/clean?token=${encodeURIComponent(TOKEN)}&device=${encodeURIComponent(deviceIdSync())}${userParam()}&v=${version}`;
}

/** Deletes the signed-in account and its server data. */
export async function deleteAccount(): Promise<void> {
  await json<unknown>(await fetch(`${BASE}/account`, { method: 'DELETE', headers: headers() }));
}

// --- phrase-islands ---
export type PhraseTopic = {
  id: string;
  title: string;
  count: number;
  sample: string;
  category?: string | null;
  titleHe?: string;
  samples?: string[];
  added?: boolean;
  matchedPhrase?: string | null;
};
export type PhraseCategory = { id: string; title: string; titleHe?: string; count: number };
export type PhraseCatalog = { topics: PhraseTopic[]; categories?: PhraseCategory[] };

/** The ready-made phrase topics for a learning language, titled in `ui`. */
export async function phraseCatalog(language: Language, ui: string): Promise<PhraseCatalog> {
  return json<PhraseCatalog>(
    await fetch(`${BASE}/phrases/catalog?language=${encodeURIComponent(language)}&ui=${encodeURIComponent(ui)}`, {
      headers: headers(),
    }),
  );
}

/** Add a phrase topic as an island. A repeat pick returns the existing island. Poll getIsland until ready. */
export async function importPhrases(
  topic: string,
  speaker: number,
  language: Language = 'ja',
  native: NativeLanguage = 'en',
): Promise<{ id: string; status?: string }> {
  const form = new FormData();
  form.append('topic', topic);
  form.append('speaker', String(speaker));
  form.append('language', language);
  form.append('native', native);

  return json<{ id: string; status?: string }>(
    await expoFetch(`${BASE}/phrases/import`, { method: 'POST', headers: headers(), body: form }),
  );
}

/** The first-run guide's pre-baked 3-line island. A repeat call returns the same one. */
export async function startStarter(
  language: Language,
  native: NativeLanguage,
  level: StarterLevel = 'new',
): Promise<{ id: string; status?: string }> {
  const form = new FormData();
  form.append('language', language);
  form.append('native', native);
  form.append('level', level);
  return json<{ id: string; status?: string }>(
    await expoFetch(`${BASE}/starter`, { method: 'POST', headers: headers(), body: form }),
  );
}

// --- grammar-islands ---
export type GrammarPoint = {
  id: string;
  pattern: string;
  reading: string;
  level: string;
  level_guess: number;
  meaning_short: string;
  added?: boolean;
};

/** Levels the backend has grammar for. Empty (or a failure) when it has no grammar.db. */
export async function grammarLevels(): Promise<{ level: string; count: number }[]> {
  const res = await json<{ levels: { level: string; count: number }[] }>(
    await fetch(`${BASE}/grammar/levels`, { headers: headers() }),
  );
  return res.levels;
}

export async function grammarPoints(level: string, q = ''): Promise<GrammarPoint[]> {
  const res = await json<{ points: GrammarPoint[] }>(
    await fetch(`${BASE}/grammar/points?level=${encodeURIComponent(level)}&q=${encodeURIComponent(q)}`, {
      headers: headers(),
    }),
  );
  return res.points;
}

/** One grammar point by id, or null when the backend has no such point. */
export async function grammarPoint(id: string): Promise<GrammarPoint | null> {
  const res = await json<{ points: GrammarPoint[] }>(
    await fetch(`${BASE}/grammar/points?point=${encodeURIComponent(id)}`, { headers: headers() }),
  );
  return res.points[0] ?? null;
}

/** Add a grammar point as a build-up island. A repeat pick returns the existing island. Poll getIsland until ready. */
export async function importGrammar(
  point: string,
  speaker: number,
  native: NativeLanguage = 'en',
  register: Register = 'polite',
): Promise<{ id: string }> {
  const form = new FormData();
  form.append('point', point);
  form.append('speaker', String(speaker));
  form.append('register', register);
  form.append('native', native);
  return json<{ id: string }>(
    await expoFetch(`${BASE}/grammar/import`, { method: 'POST', headers: headers(), body: form }),
  );
}

/** Build a phrase island from a recorded topic ("phrases for the gym"). Poll getIsland after this. */
export async function createTopicIsland(
  uri: string,
  speaker: number,
  language: Language,
  native: NativeLanguage,
  complexity: Complexity = 'simple',
  register?: Register,
  count = 10,
): Promise<{ id: string }> {
  return createIsland(uri, complexity, speaker, register, count, language, native, true);
}

// --- import-file ---
/**
 * Import an audio file (and an optional .srt) as an island that plays the
 * original audio, sliced per line. Returns as soon as the file is accepted;
 * poll getIsland after this, same as createIsland. An empty title makes the
 * backend use the file name.
 */
export async function importIsland(
  audioUri: string,
  srtUri: string | null,
  title: string,
  speaker: number,
  language: Language = 'ja',
  native: NativeLanguage = 'en',
  startMin = 0,
): Promise<{ id: string }> {
  const form = new FormData();
  form.append('audio', new File(audioUri), audioUri.split('/').pop() || 'audio');
  if (srtUri) form.append('subtitles', new File(srtUri), srtUri.split('/').pop() || 'subtitles.srt');
  form.append('title', title);
  form.append('speaker', String(speaker));
  form.append('language', language);
  form.append('native', native);
  form.append('start_min', String(startMin));

  return json<{ id: string }>(
    await expoFetch(`${BASE}/islands/import`, { method: 'POST', headers: headers(), body: form }),
  );
}

// --- youtube-shadowing ---

export type YouTubeInfo = { video_id: string; url: string; title: string; author: string; thumbnail: string };
export type IslandVideo = { island_id: string; video_id: string; start_s: number; duration: number; title: string; author: string; /** True when the island has no audio, only captions. */ captions_only?: boolean; /** Forced-alignment job: '' | queued | running | done | failed | closed (no attempts left). */ align?: string; align_error?: string };
export type VideoListItem = {
  island_id: string;
  video_id: string;
  title: string;
  status: IslandSummary['status'];
  stage: string;
  error_code: string;
  line_count: number;
  created_at: string;
};

/** Title, channel and thumbnail for a pasted YouTube link. */
export async function youtubeInfo(url: string): Promise<YouTubeInfo> {
  return json<YouTubeInfo>(await fetch(`${BASE}/youtube/info?url=${encodeURIComponent(url)}`, { headers: headers() }));
}

/** Send the caption events the phone fetched and build an island from them. Poll getIsland until ready. */
export async function importYouTubeCaptions(
  url: string,
  title: string,
  speaker: number,
  language: Language,
  native: NativeLanguage,
  events: unknown[],
): Promise<{ id: string }> {
  return json<{ id: string }>(
    await fetch(`${BASE}/youtube/captions`, {
      method: 'POST',
      headers: { ...headers(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ url, title, speaker, language, native, events }),
    }),
  );
}

/** The YouTube link behind a video island. */
export async function getIslandVideo(id: string): Promise<IslandVideo> {
  return json<IslandVideo>(await fetch(`${BASE}/islands/${id}/video`, { headers: headers() }));
}

// --- bl36-align ---
/** Raw audio stream of a video island, for server-side forced alignment. */
export async function uploadVideoAudio(islandId: string, uri: string): Promise<{ align: string }> {
  const form = new FormData();
  form.append('audio', new File(uri), 'audio');
  return json<{ align: string }>(
    await expoFetch(`${BASE}/islands/${islandId}/video-audio`, { method: 'POST', headers: headers(), body: form }),
  );
}
// --- /bl36-align ---

/** Every video island on this device, newest first. */
export async function listVideos(): Promise<VideoListItem[]> {
  return json<VideoListItem[]>(await fetch(`${BASE}/videos`, { headers: headers() }));
}

// ---- Progression and cosmetics ----

export type { ArtSpec, Slot };
export type Progress = {
  xp: number;
  /** Capped XP earned today (UTC day), 0..xp_today_cap. */
  xp_today: number;
  xp_today_cap: number;
  /** Consecutive practice days; not shown yet. */
  streak_days: number;
  /** Consecutive local days with a paid daily review. */
  review_streak_days: number;
  level: number;
  coins: number;
  xp_into_level: number;
  /** 0 at the top level. */
  xp_to_next: number;
  owned: string[];
  equipped: Record<Slot, string | null>;
  catalog_version: number;
  /** bl58-easy-for-me: lines marked Easy for me across every island. */
  known_lines?: number;
};

export type CosmeticItem = {
  id: string;
  slot: Slot;
  name: string;
  level_req: number;
  price: number;
  art: ArtSpec;
  /** Granted by the server only (beta hat). Never for sale. */
  grant_only?: boolean;
};

export type CosmeticsCatalog = { version: number; slots: Slot[]; shapes: Record<string, string[]>; items: CosmeticItem[] };

export async function getProgress(): Promise<Progress> {
  return json<Progress>(await fetch(`${BASE}/progress`, { headers: headers() }));
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

export async function getCosmeticsCatalog(ui: 'en' | 'he'): Promise<CosmeticsCatalog> {
  return json<CosmeticsCatalog>(await fetch(`${BASE}/cosmetics/catalog?ui=${ui}`, { headers: headers() }));
}

/** Grants the starter gift (face.blush_pink) and returns the fresh progress. */
export async function finishStarter(): Promise<{ progress: Progress; item: string }> {
  return json<{ progress: Progress; item: string }>(
    await fetch(`${BASE}/starter/finish`, { method: 'POST', headers: headers() }),
  );
}

export async function buyCosmetic(itemId: string): Promise<Progress> {
  const form = new FormData();
  form.append('item_id', itemId);
  return json<Progress>(await expoFetch(`${BASE}/cosmetics/buy`, { method: 'POST', headers: headers(), body: form }));
}

/** An empty `itemId` (null) unequips the slot. */
export async function equipCosmetic(slot: Slot, itemId: string | null): Promise<Progress> {
  const form = new FormData();
  form.append('slot', slot);
  form.append('item_id', itemId ?? '');
  return json<Progress>(await expoFetch(`${BASE}/cosmetics/equip`, { method: 'POST', headers: headers(), body: form }));
}

// --- username ---

export type UsernameCheck = { valid: boolean; available: boolean; reason: null | 'invalid' | 'taken' };

/** The signed-in account's handle, or null when none is set. Throws when the
 * request fails: a failed fetch is not "no username". */
export async function getUsername(): Promise<string | null> {
  const r = await json<{ username: string | null }>(await expoFetch(`${BASE}/username`, { headers: headers() }));
  return r.username;
}

export async function checkUsername(name: string): Promise<UsernameCheck> {
  return json<UsernameCheck>(await expoFetch(`${BASE}/username/check?name=${encodeURIComponent(name)}`, { headers: headers() }));
}

export async function setUsername(name: string): Promise<string> {
  const form = new FormData();
  form.append('username', name);
  const r = await json<{ username: string }>(await expoFetch(`${BASE}/username`, { method: 'POST', headers: headers(), body: form }));
  return r.username;
}

export type LeaderboardEntry = { username: string; level: number; equipped: Record<Slot, string | null> };
export type Leaderboard = { entries: LeaderboardEntry[]; me: { rank: number | null; level: number; username: string | null } };

export async function getLeaderboard(): Promise<Leaderboard> {
  return json<Leaderboard>(await expoFetch(`${BASE}/leaderboard`, { headers: headers() }));
}

export type Profile = {
  username: string;
  serial: number;
  member_since: string;
  level: number;
  xp: number;
  rank: number | null;
  equipped: Record<Slot, string | null>;
  streak_days: number;
  longest_streak: number;
  days_active: number;
  best_xp_day: number;
  cap_days: number;
  immersion_seconds: number;
  video_seconds: number;
  podcast_seconds: number;
  shadow_seconds: number;
  islands_started: number;
  islands_mastered: number;
  lines_practiced: number;
  lines_mastered: number;
  average_accuracy: number | null;
  milestones: string[];
  milestones_total: number;
  cosmetics_owned: number;
  cosmetics_total: number;
};

export async function getProfile(username: string): Promise<Profile> {
  return json<Profile>(await expoFetch(`${BASE}/profile/${encodeURIComponent(username)}`, { headers: headers() }));
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
};

export async function saveReviewCard(islandId: string, idx: number): Promise<ReviewCard> {
  const form = new FormData();
  form.append('island_id', islandId);
  form.append('idx', String(idx));
  return json<ReviewCard>(await expoFetch(`${BASE}/review/cards`, { method: 'POST', headers: headers(), body: form }));
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
