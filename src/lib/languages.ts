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
};

export const LANGUAGES: LanguageEntry[] = [
  { id: 'ja', flag: '🇯🇵', native: '日本語', english: 'Japanese', letter: 'あ', region: 'Asia', learnable: true, understandable: false, rtl: false },
  { id: 'es', flag: '🇪🇸', native: 'Español', english: 'Spanish', letter: 'Ñ', region: 'Europe', learnable: true, understandable: false, rtl: false },
  { id: 'en', flag: '🇬🇧', native: 'English', english: 'English', letter: 'A', region: 'Europe', learnable: true, understandable: true, rtl: false },
  { id: 'he', flag: '🇮🇱', native: 'עברית', english: 'Hebrew', letter: 'א', region: 'Middle East', learnable: false, understandable: true, rtl: true },
  { id: 'fr', flag: '🇫🇷', native: 'Français', english: 'French', letter: 'É', region: 'Europe', learnable: false, understandable: false, rtl: false },
  { id: 'de', flag: '🇩🇪', native: 'Deutsch', english: 'German', letter: 'ß', region: 'Europe', learnable: false, understandable: false, rtl: false },
  { id: 'pt', flag: '🇵🇹', native: 'Português', english: 'Portuguese', letter: 'Ã', region: 'Europe', learnable: false, understandable: false, rtl: false },
  { id: 'it', flag: '🇮🇹', native: 'Italiano', english: 'Italian', letter: 'I', region: 'Europe', learnable: false, understandable: false, rtl: false },
  { id: 'ru', flag: '🇷🇺', native: 'Русский', english: 'Russian', letter: 'Я', region: 'Europe', learnable: false, understandable: false, rtl: false },
  { id: 'ko', flag: '🇰🇷', native: '한국어', english: 'Korean', letter: '한', region: 'Asia', learnable: false, understandable: false, rtl: false },
  { id: 'zh', flag: '🇨🇳', native: '中文', english: 'Chinese', letter: '中', region: 'Asia', learnable: false, understandable: false, rtl: false },
  { id: 'hi', flag: '🇮🇳', native: 'हिन्दी', english: 'Hindi', letter: 'अ', region: 'Asia', learnable: false, understandable: false, rtl: false },
  { id: 'ar', flag: '🇸🇦', native: 'العربية', english: 'Arabic', letter: 'ع', region: 'Middle East', learnable: false, understandable: false, rtl: true },
];

/** Looks up a catalogue entry by id, or `undefined` for an id the catalogue
 * has never had (should not happen for anything read back out of settings,
 * since `read()` validates against this same list). */
export function getLanguage(id: LanguageId): LanguageEntry | undefined {
  return LANGUAGES.find((l) => l.id === id);
}
