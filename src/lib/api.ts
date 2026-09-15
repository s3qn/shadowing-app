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

const BASE = process.env.EXPO_PUBLIC_SHADOW_API_URL ?? '';
const TOKEN = process.env.EXPO_PUBLIC_SHADOW_TOKEN ?? '';
// Icon paths from the backend are absolute (/shadow/...), so they hang off the
// origin rather than off BASE.
const ORIGIN = BASE.replace(/\/shadow\/?$/, '');

export type Complexity = 'simple' | 'complex';

/** Speech register for generated Japanese: です/ます polite, or plain casual
 * form. Keep in sync with `Register` in `src/lib/settings.ts`. */
export type Register = 'polite' | 'casual';

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

export type IslandSummary = {
  id: string;
  title: string;
  status: 'pending' | 'working' | 'ready' | 'failed';
  stage: string;
  complexity: Complexity;
  created_at: string;
  line_count: number;
};

/** What each backend build stage means to the person waiting for it. */
export const STAGE_LABEL: Record<string, string> = {
  queued: 'Queued…',
  transcribing: 'Transcribing…',
  writing: 'Writing Japanese…',
  speaking: 'Recording the voice…',
};

export type Island = IslandSummary & {
  error: string;
  speaker: number;
  transcript: string;
  lines: Line[];
};

function headers(): Record<string, string> {
  return { Authorization: `Bearer ${TOKEN}` };
}

/** Turns any failed response into a short, readable message. Gateway errors
 * (the tunnel could not reach the server) come back as full HTML pages, which
 * are useless on a phone screen. */
async function json<T>(res: Response): Promise<T> {
  if (!res.ok) {
    if (res.status === 502 || res.status === 503 || res.status === 504) {
      throw new Error('The server is not reachable right now. Try again in a moment.');
    }
    const body = await res.text().catch(() => '');
    const looksLikeHtml = body.trimStart().startsWith('<');
    throw new Error(looksLikeHtml ? `Request failed (${res.status})` : `${res.status} ${body.slice(0, 160)}`);
  }
  return (await res.json()) as T;
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
  return json<Island>(await fetch(`${BASE}/islands/${id}`, { headers: headers() }));
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
  register: Register = 'polite',
  count = 8,
): Promise<{ id: string }> {
  const form = new FormData();
  form.append('audio', new File(uri), 'recording.m4a');
  form.append('complexity', complexity);
  form.append('register', register);
  form.append('speaker', String(speaker));
  form.append('count', String(count));

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

export async function listSpeakers(): Promise<Speaker[]> {
  return json<Speaker[]>(await fetch(`${BASE}/speakers`, { headers: headers() }));
}

/** Absolute URL for a style icon path returned by listSpeakers. */
export function iconUrl(path: string): string {
  return `${ORIGIN}${path}?token=${encodeURIComponent(TOKEN)}`;
}

/** The fixed preview sentence rendered in one voice. */
export function voicePreviewUrl(styleId: number): string {
  return `${BASE}/voices/${styleId}/preview?token=${encodeURIComponent(TOKEN)}`;
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
export async function explainWord(word: string, sentenceJa: string, sentenceEn: string): Promise<string> {
  const q = `word=${encodeURIComponent(word)}&sentence_ja=${encodeURIComponent(sentenceJa)}&sentence_en=${encodeURIComponent(sentenceEn)}`;
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
      }),
    }),
  );
}

/** One word rendered on its own in the given voice. */
export function wordAudioUrl(text: string, speaker: number): string {
  return `${BASE}/word-audio?text=${encodeURIComponent(text)}&speaker=${speaker}&token=${encodeURIComponent(TOKEN)}`;
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
  return `${BASE}/islands/${islandId}/lines/${idx}/audio?token=${encodeURIComponent(TOKEN)}&v=${version}&speed=${s}${pad}${range}`;
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

/** Result of an echo cancellation pass on an uploaded take, or a calibration recording. */
export type TakeClean = {
  cleaned: boolean;
  erleDb: number | null;
  delayMs: number | null;
  driftSamples: number | null;
  note: string;
  /** Missing on a calibration upload. */
  score?: TakeScore;
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
  return `${BASE}/islands/${islandId}/lines/${idx}/take/clean?token=${encodeURIComponent(TOKEN)}&v=${version}`;
}
