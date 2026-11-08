/**
 * The full catalogue of languages the app can show a picker for: three the
 * backend can already generate islands in, one it can already explain in,
 * and a spread of "coming soon" languages so picking one tells us what to
 * build next. Adding a language later is one entry here.
 *
 * This stays the single source of truth for language ids: `LanguageId` is
 * just `string`, not a TypeScript union, so a new catalogue entry never
 * needs a type change anywhere else.
 */

export type Region = 'Europe' | 'Asia' | 'Middle East' | 'Africa' | 'Americas';

export type LanguageId = string;

/** lang-core: the ten codes the backend's `languages.py` table knows, in its
 * order. Which of them a device may pick comes from `/shadow/beta` (see
 * `setEnabledLanguages` below and `src/lib/beta.ts`); the rest sit under
 * "Coming soon". */
export const LANGUAGE_IDS = ['ja', 'es', 'en', 'fr', 'pt', 'zh', 'ko', 'de', 'he', 'ar'] as const;
export type LanguageCode = (typeof LANGUAGE_IDS)[number];

export function isLanguageCode(id: string): id is LanguageCode {
  return (LANGUAGE_IDS as readonly string[]).includes(id);
}

/** What is written with a line, mirroring the backend table: kana ruby for
 * Japanese, pinyin ruby for Mandarin, a Revised Romanization line for Korean,
 * a model-written transliteration line for Hebrew and Arabic. */
export type Reading = 'kana' | 'pinyin' | 'rr' | 'translit';

export type EnabledLanguage = { id: LanguageCode; speaker: number };

/** The set every device gets when the server's answer carries no
 * `languages` (an older prod), with the speaker `backend/voices.py`'s
 * `default_speaker` picks for each. */
export const LAUNCH_LANGUAGES: readonly EnabledLanguage[] = [
  { id: 'ja', speaker: 3 },
  { id: 'es', speaker: 10011 },
  { id: 'en', speaker: 10001 },
];

// The languages this device may pick today, written by `src/lib/beta.ts`
// from the cached or fresh `/shadow/beta` answer. Kept here, with no imports,
// so `settings.ts` can read it without a module cycle through the api layer.
let enabled: readonly EnabledLanguage[] = LAUNCH_LANGUAGES;

export function setEnabledLanguages(list: readonly EnabledLanguage[]): void {
  enabled = list.length ? list : LAUNCH_LANGUAGES;
}

export function enabledLanguages(): LanguageCode[] {
  return enabled.map((l) => l.id);
}

export function isEnabledLanguage(id: string): id is LanguageCode {
  return enabled.some((l) => l.id === id);
}

/** The speaker the server defaults to for an enabled language, else undefined. */
export function defaultSpeaker(id: string): number | undefined {
  return enabled.find((l) => l.id === id)?.speaker;
}

export type LanguageEntry = {
  id: LanguageId;
  /** Name in the language's own script, shown as the row's main label. */
  native: string;
  /** English name, shown as the row's subtitle. */
  english: string;
  /** The flag shown in the row's round avatar: a country, not the language
   * itself, so a language spoken in many places takes the flag people look
   * for first (Spanish → Spain, English → the United Kingdom). Left out for
   * a language no single flag fits, and the row falls back to `letter`. */
  flag?: string;
  /** One letter from this language's own script, the avatar's fallback when
   * there is no flag. */
  letter: string;
  region: Region;
  /** The backend can generate islands in this language today. */
  learnable: boolean;
  /** The app can show explanations and translations in this language today. */
  understandable: boolean;
  /** Written right to left. */
  rtl: boolean;
  /** Chinese or Japanese script: no spaces, one em per character, kinsoku row breaks. */
  cjk: boolean;
  /** The reading the player can show for a line; left out for a language with none. */
  reading?: Reading;
  /** Grammar points exist for this language (backend `grammar.db` is Japanese only). */
  grammar?: boolean;
};

// `learnable` marks the ten codes the backend table knows. Which of them this
// device may pick today is `enabledLanguages()` above.
export const LANGUAGES: LanguageEntry[] = [
  { id: 'ja', flag: '🇯🇵', native: '日本語', english: 'Japanese', letter: 'あ', region: 'Asia', learnable: true, understandable: false, rtl: false, cjk: true, reading: 'kana', grammar: true },
  { id: 'es', flag: '🇪🇸', native: 'Español', english: 'Spanish', letter: 'Ñ', region: 'Europe', learnable: true, understandable: false, rtl: false, cjk: false },
  { id: 'en', flag: '🇬🇧', native: 'English', english: 'English', letter: 'A', region: 'Europe', learnable: true, understandable: true, rtl: false, cjk: false },
  { id: 'he', flag: '🇮🇱', native: 'עברית', english: 'Hebrew', letter: 'א', region: 'Middle East', learnable: true, understandable: true, rtl: true, cjk: false, reading: 'translit' },
  { id: 'fr', flag: '🇫🇷', native: 'Français', english: 'French', letter: 'É', region: 'Europe', learnable: true, understandable: false, rtl: false, cjk: false },
  { id: 'de', flag: '🇩🇪', native: 'Deutsch', english: 'German', letter: 'ß', region: 'Europe', learnable: true, understandable: false, rtl: false, cjk: false },
  // Brazilian Portuguese: the voices and the transcriber lean Brazilian.
  { id: 'pt', flag: '🇧🇷', native: 'Português', english: 'Portuguese', letter: 'Ã', region: 'Americas', learnable: true, understandable: false, rtl: false, cjk: false },
  { id: 'it', flag: '🇮🇹', native: 'Italiano', english: 'Italian', letter: 'I', region: 'Europe', learnable: false, understandable: false, rtl: false, cjk: false },
  { id: 'ru', flag: '🇷🇺', native: 'Русский', english: 'Russian', letter: 'Я', region: 'Europe', learnable: false, understandable: false, rtl: false, cjk: false },
  { id: 'ko', flag: '🇰🇷', native: '한국어', english: 'Korean', letter: '한', region: 'Asia', learnable: true, understandable: false, rtl: false, cjk: false, reading: 'rr' },
  { id: 'zh', flag: '🇨🇳', native: '中文', english: 'Chinese', letter: '中', region: 'Asia', learnable: true, understandable: false, rtl: false, cjk: true, reading: 'pinyin' },
  { id: 'hi', flag: '🇮🇳', native: 'हिन्दी', english: 'Hindi', letter: 'अ', region: 'Asia', learnable: false, understandable: false, rtl: false, cjk: false },
  { id: 'ar', flag: '🇸🇦', native: 'العربية', english: 'Arabic', letter: 'ع', region: 'Middle East', learnable: true, understandable: false, rtl: true, cjk: false, reading: 'translit' },
];

/** Looks up a catalogue entry by id, or `undefined` for an id the catalogue
 * has never had (should not happen for anything read back out of settings,
 * since `read()` validates against this same list). */
export function getLanguage(id: LanguageId): LanguageEntry | undefined {
  return LANGUAGES.find((l) => l.id === id);
}

/** Whether the Phrases grammar view, its search and its import apply to this language. */
export function hasGrammar(id: LanguageId): boolean {
  return getLanguage(id)?.grammar === true;
}
