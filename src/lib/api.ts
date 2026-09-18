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

import { fetch as expoFetch } from 'expo/fetch';
import { Directory, File, Paths } from 'expo-file-system';

import { deviceIdSync } from '@/lib/device';
import { t } from '@/lib/i18n';
import { en, type Key } from '@/locales/en';

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
};

export type SpeakerStyle = { id: number; name: string; icon: string };
export type Speaker = { uuid: string; name: string; policy: string; styles: SpeakerStyle[] };

/** The language the learner already understands, `native` on the island. */
export type NativeLanguage = 'he' | 'en';

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
};

/** Why an island failed, in the reader's language. Falls back to the English
 * sentence the backend also sends, so an unknown code still says something. */
export function islandErrorText(island: { error?: string; error_code?: string }): string {
  const key = island.error_code ? codeKey('islandError', island.error_code) : undefined;
  if (key) return t(key);
  return island.error || t('islandError.unknown');
}

function headers(): Record<string, string> {
  return { Authorization: `Bearer ${TOKEN}`, 'X-Shadow-Device': deviceIdSync() };
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
      throw new Error(typeof detail === 'string' && detail ? detail : t('api.daily_limit_any'));
    }
    if (typeof detail === 'string' && detail) throw new Error(detail);
    const looksLikeHtml = body.trimStart().startsWith('<');
    throw new Error(looksLikeHtml ? `Request failed (${res.status})` : `${res.status} ${body.slice(0, 160)}`);
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
): Promise<{ id: string }> {
  const form = new FormData();
  form.append('audio', new File(uri), 'recording.m4a');
  form.append('complexity', complexity);
  if (register) form.append('register', register);
  form.append('speaker', String(speaker));
  form.append('count', String(count));
  form.append('language', language);
  form.append('native', native);

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
  return `${ORIGIN}${path}?token=${encodeURIComponent(TOKEN)}&device=${encodeURIComponent(deviceIdSync())}`;
}

/** The fixed preview sentence rendered in one voice. */
export function voicePreviewUrl(styleId: number): string {
  return `${BASE}/voices/${styleId}/preview?token=${encodeURIComponent(TOKEN)}&device=${encodeURIComponent(deviceIdSync())}`;
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

export async function postPracticeEvent(islandId: string, seconds: number): Promise<void> {
  const form = new FormData();
  form.append('island_id', islandId);
  form.append('seconds', String(seconds));
  const res = await expoFetch(`${BASE}/schedule/practice`, { method: 'POST', headers: headers(), body: form });
  await json<unknown>(res);
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

/** Posts a feature idea from the Settings feedback screen. */
export async function suggestFeature(text: string): Promise<void> {
  await json(
    await fetch(`${BASE}/suggestions`, {
      method: 'POST',
      headers: { ...headers(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ text }),
    }),
  );
}

/** One word rendered on its own in the given voice. */
export function wordAudioUrl(text: string, speaker: number): string {
  return `${BASE}/word-audio?text=${encodeURIComponent(text)}&speaker=${speaker}&token=${encodeURIComponent(TOKEN)}&device=${encodeURIComponent(deviceIdSync())}`;
}

/**
 * Audio URL for one line. The token rides as a query parameter because the
 * audio player fetches this itself and cannot attach the auth header.
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
 * calibration upload.
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

  return json<TakeClean>(
    await expoFetch(`${BASE}/islands/${islandId}/lines/${idx}/take`, {
      method: 'POST',
      headers: headers(),
      body: form,
    }),
  );
}

/**
 * URL for the cleaned version of a take. The token rides as a query
 * parameter for the same reason it does on lineAudioUrl, and `version` (the
 * take's recordedAt) keeps the player from ever loading a stale cached file.
 */
export function cleanTakeUrl(islandId: string, idx: number, version: number): string {
  return `${BASE}/islands/${islandId}/lines/${idx}/take/clean?token=${encodeURIComponent(TOKEN)}&device=${encodeURIComponent(deviceIdSync())}&v=${version}`;
}
