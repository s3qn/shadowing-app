// Shared API types and the two helpers that turn backend codes into text.
// Moved out of api.ts as a pure move; api.ts re-exports everything here.

import type { ArtSpec, Slot } from '@/constants/cosmetics';
import { t } from '@/lib/i18n';
import type { LanguageCode } from '@/lib/languages';
import { en, type Key } from '@/locales/en';

export type Complexity = 'simple' | 'complex';

/** Speech register for generated Japanese: です/ます polite, or plain casual
 * form. Keep in sync with `Register` in `src/lib/settings.ts`. */
export type Register = 'polite' | 'casual';

/** The learning language an island was built in: one of the ten codes in
 * `src/lib/languages.ts`'s `LANGUAGE_IDS` (the backend's `languages.py` table). */
export type Language = LanguageCode;

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
  /** Video islands: 1 once the repair pass verified the text, 0 when it is
   * unsure (catch-the-word skips it), null or absent before the pass. */ // youtube-asr-context-repair
  sure?: 0 | 1 | null;
};

export type SpeakerStyle = { id: number; name: string; icon: string };
export type Speaker = {
  uuid: string;
  name: string;
  policy: string;
  styles: SpeakerStyle[];
  /** tts-providers: a hosted AI voice is capped per day (`limit` lines),
   * then the language's free local voice fills in server-side. */
  kind?: 'local' | 'hosted';
  limit?: number;
};

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
  /** Seconds of media and seconds left of the build. Absent from an older backend. */
  media_s?: number;
  eta_s?: number | null;
};

/** A code the backend sends (`daily_limit`, `no_lines`, `transcribing`) is only
 * a catalogue key if the catalogue actually holds it. An older client meeting a
 * newer backend must fall back, not show the person "islandError.some_new_code". */
export function codeKey(prefix: 'api' | 'islandError' | 'stage', code: string): Key | undefined {
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

export type { ArtSpec, Slot };
