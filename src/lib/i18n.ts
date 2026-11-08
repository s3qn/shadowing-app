/**
 * The app's own tiny translation layer: no library (see the app-language
 * plan, decision 2). A flat, typed key to string catalogue per language,
 * `t()` for a one-off read and `useT()`/`useDir()` for a component that
 * needs to re-render when the language changes.
 *
 * Soft RTL (decision 1): the native layout stays left to right; `useDir()`
 * only mirrors the handful of rows and text alignments that read as a
 * sequence. No `I18nManager.forceRTL`, no restart.
 */

import { useMemo, useSyncExternalStore } from 'react';
import { Platform, type TextStyle } from 'react-native';

import { type Key, en } from '@/locales/en';
import { ar } from '@/locales/ar';
import { de } from '@/locales/de';
import { es } from '@/locales/es';
import { fr } from '@/locales/fr';
import { he } from '@/locales/he';
import { ja } from '@/locales/ja';
import { ko } from '@/locales/ko';
import { pt } from '@/locales/pt';
import { zh } from '@/locales/zh';
import { isCompleteLang } from '@/lib/app-languages';
import { isolate } from '@/lib/bidi';
import { getSettingsSync, subscribeSettings, type Settings } from '@/lib/settings';

export type Lang = 'en' | 'he' | 'fr' | 'pt' | 'de' | 'es' | 'zh' | 'ko' | 'ja' | 'ar';

export const LOCALES: Record<Lang, { tag: string; rtl: boolean; native: string }> = {
  en: { tag: 'en-US', rtl: false, native: 'English' },
  he: { tag: 'he-IL', rtl: true, native: 'עברית' },
  fr: { tag: 'fr-FR', rtl: false, native: 'Français' },
  pt: { tag: 'pt-BR', rtl: false, native: 'Português' },
  de: { tag: 'de-DE', rtl: false, native: 'Deutsch' },
  es: { tag: 'es-ES', rtl: false, native: 'Español' },
  zh: { tag: 'zh-CN', rtl: false, native: '中文' },
  ko: { tag: 'ko-KR', rtl: false, native: '한국어' },
  ja: { tag: 'ja-JP', rtl: false, native: '日本語' },
  // Latin digits and the Gregorian calendar: `ar-SA` would print Arabic-Indic
  // digits and Hijri dates through toLocaleString.
  ar: { tag: 'ar-u-nu-latn-ca-gregory', rtl: true, native: 'العربية' },
};

const CATALOGUES: Record<Lang, Partial<Record<string, string>>> = { en, he, fr, pt, de, es, zh, ko, ja, ar };

/** A language that has a catalogue and is listed in `COMPLETE_LANGS`. */
export function isLang(v: string): v is Lang {
  return v in LOCALES && isCompleteLang(v);
}

/** The interface language a settings snapshot resolves to: the explicit
 * pick, else the understood language if it has a catalogue, else English. */
export function resolveAppLanguage(s: Settings): Lang {
  const base: Lang =
    s.appLanguage !== 'auto' && isLang(s.appLanguage) ? s.appLanguage : isLang(s.understoodLanguage) ? s.understoodLanguage : 'en';
  return previewLang ?? base;
}

// Onboarding-only override: previews the language the learner is about to
// pick as "understood" before `finish()` writes it to settings. Never set
// outside `src/app/onboarding/index.tsx`.
let previewLang: Lang | null = null;
const previewListeners = new Set<() => void>();

export function previewAppLanguage(lang: Lang | null): void {
  previewLang = lang;
  for (const listener of previewListeners) listener();
}

function subscribeLang(listener: () => void): () => void {
  const unsubscribe = subscribeSettings(listener);
  previewListeners.add(listener);
  return () => {
    unsubscribe();
    previewListeners.delete(listener);
  };
}

type Vars = Record<string, string | number>;

/** Plural category from the platform's CLDR rules when `Intl.PluralRules`
 * exists (Hermes may not ship it), else null and the hand rules below apply.
 * Only `one`, `two`, `few` and `many` have catalogue variants; any other
 * category (and a missing variant) reads as `other`. */
type PluralCat = 'one' | 'two' | 'few' | 'many' | 'other';
const pluralRules = new Map<Lang, Intl.PluralRules | null>();
function intlPluralSuffix(lang: Lang, count: number): PluralCat | null {
  let rules = pluralRules.get(lang);
  if (rules === undefined) {
    try {
      rules = typeof Intl !== 'undefined' && typeof Intl.PluralRules === 'function' ? new Intl.PluralRules(LOCALES[lang].tag) : null;
    } catch {
      rules = null;
    }
    pluralRules.set(lang, rules);
  }
  if (!rules) return null;
  const cat = rules.select(count);
  return cat === 'one' || cat === 'two' || cat === 'few' || cat === 'many' ? cat : 'other';
}

/** A language name from `language.*` lowercased for the middle of a sentence
 * in the languages that do not capitalise language names. */
export function midSentence(lang: Lang, name: string): string {
  return lang === 'fr' || lang === 'es' || lang === 'pt' ? name.toLocaleLowerCase(lang) : name;
}

function pluralSuffix(lang: Lang, count: number): PluralCat {
  const viaIntl = intlPluralSuffix(lang, count);
  if (viaIntl) return viaIntl;
  if (lang === 'he') {
    if (count === 1) return 'one';
    if (count === 2) return 'two';
    return 'other';
  }
  if (lang === 'ar') {
    // CLDR Arabic: 3-10 few, 11-99 many, 0 and 100+ other (by the last two digits).
    if (count === 1) return 'one';
    if (count === 2) return 'two';
    const mod100 = Math.abs(Math.trunc(count)) % 100;
    if (Number.isInteger(count) && mod100 >= 3 && mod100 <= 10) return 'few';
    if (Number.isInteger(count) && mod100 >= 11 && mod100 <= 99) return 'many';
    return 'other';
  }
  if (lang === 'zh' || lang === 'ko' || lang === 'ja') return 'other';
  // French and Portuguese count 0 and 1 as singular.
  if (lang === 'fr' || lang === 'pt') return count === 0 || count === 1 ? 'one' : 'other';
  return count === 1 ? 'one' : 'other';
}

function lookup(lang: Lang, key: string): string | undefined {
  return CATALOGUES[lang][key];
}

// Every substituted value is isolated (see `lib/bidi`): a language name, a
// voice name, an island title or a search term can run the other way from the
// sentence around it, and a Latin value at the head of a Hebrew string would
// otherwise lay the whole line out left to right.
function interpolate(template: string, vars?: Vars): string {
  if (!vars) return template;
  return template.replace(/\{(\w+)\}/g, (whole, name: string) => (name in vars ? isolate(String(vars[name])) : whole));
}

function translate(lang: Lang, key: Key, vars?: Vars): string {
  let resolvedKey: string = key;
  // The plural count is `count`, else `n` (most counted templates name it so);
  // only a key that has `_one`/`_two` variants is affected.
  const count = vars ? (typeof vars.count === 'number' ? vars.count : typeof vars.n === 'number' ? vars.n : undefined) : undefined;
  if (count !== undefined) {
    const suffixed = `${key}_${pluralSuffix(lang, count)}`;
    const fallbackOther = `${key}_other`;
    if (lookup(lang, suffixed) !== undefined) resolvedKey = suffixed;
    else if (lookup(lang, fallbackOther) !== undefined) resolvedKey = fallbackOther;
  }
  // A key missing from the resolved language (should not happen once
  // `satisfies` passes, but plural suffixes are not literally in `Key`)
  // falls back to English, then to the raw key.
  const template = lookup(lang, resolvedKey) ?? lookup('en', resolvedKey) ?? key;
  return interpolate(template, vars);
}

export type TFn = (key: Key, vars?: Vars) => string;

/** Reads the current settings synchronously, so it works outside a
 * component (an Alert body, a thrown error message) as well as inside one.
 * Inside a component use `useT()` instead: this one's identity never
 * changes, see the note there. */
export const t: TFn = (key, vars) => translate(resolveAppLanguage(getSettingsSync()), key, vars);

// One `t` per language, built once and kept. The identity is the point: the
// React Compiler (`experiments.reactCompiler` in app.json) caches a `t(...)`
// result, and the whole JSX node around it, on `$[n] !== t`. With a single
// module-level `t` that test never flips, so a screen keeps the text it
// first rendered for its whole life. A `t` that is a different function per
// language invalidates every cache chain that reads it the moment the
// language changes.
const translators = new Map<Lang, TFn>();

function translatorFor(lang: Lang): TFn {
  const cached = translators.get(lang);
  if (cached) return cached;
  const fn: TFn = (key, vars) => translate(lang, key, vars);
  translators.set(lang, fn);
  return fn;
}

/** For a component: re-renders when the app language changes (a settings
 * write, or an onboarding preview), without a Context provider. */
export function useT(): { t: TFn; lang: Lang; rtl: boolean; locale: string } {
  const lang = useSyncExternalStore(subscribeLang, () => resolveAppLanguage(getSettingsSync()));
  return { t: translatorFor(lang), lang, rtl: LOCALES[lang].rtl, locale: LOCALES[lang].tag };
}

export type Dir = {
  rtl: boolean;
  /** Reverses a row's reading order. Spread after a base row style. */
  row?: { flexDirection: 'row-reverse' };
  /** Right-aligns and (iOS) sets the writing direction of a leading `Text`. */
  text?: { textAlign: 'right'; writingDirection: 'rtl' };
  /** The writing direction alone, for a `Text` that stays centred: without
   * it a line opening with Latin ("Echo Tail מקשיב לך") takes its base
   * direction from that first word and reads in the wrong order. */
  writing?: { writingDirection: 'rtl' };
  /** For a `Text` that shows content rather than interface: an island title,
   * a transcript line, a podcast description. Content can be in any language
   * and must be ordered by its own characters, so the writing direction is
   * `'auto'` (resolved per string from its first strong one) whatever the
   * interface is. Only the alignment follows the interface, so a list of
   * titles still sits on the reading edge. Set even in a left to right
   * interface: the title of an island being learned in Hebrew or Arabic
   * needs it there too. */
  content: { textAlign: 'right'; writingDirection: 'auto' } | { writingDirection: 'auto' };
  /** Korean only: breaks lines between words, never inside one ("핸즈프|리").
   * Spread on a `Text` that holds interface copy. `props` is the iOS prop,
   * `style` the web style; Android already breaks Hangul at spaces. */
  words: { props?: { lineBreakStrategyIOS: 'hangul-word' }; style?: TextStyle };
  /** The "go forward" chevron glyph, mirrored for a reversed reading order. */
  chevron: '›' | '‹';
  /** Header options that hand the title's free space to the left side, so a left-aligned title (the web and Android default) sits at the right, next to a mirrored header button. The iOS header centres its title, so it keeps the default there. */
  headerSides:
    | { headerLeftContainerStyle: { flexGrow: 1; flexBasis: 0 }; headerRightContainerStyle: { flexGrow: 0; flexBasis: 'auto' } }
    | undefined;
};

/** Mirrors the handful of rows and text alignments that read as a sequence
 * (decision 1: soft RTL). Media controls, centred and symmetric layouts are
 * left alone, see the plan's Direction pass. Memoised so `style={[a, dir.row]}`
 * does not get a new object every render while `rtl` stays the same. */
const RTL_START = /^[^\p{L}]*[\u0590-\u08FF\uFB1D-\uFDFF\uFE70-\uFEFF]/u;
const RTL_STYLE = { textAlign: 'right', writingDirection: 'rtl' } as const;

/** Extra style for a `Text` of content that opens in a right to left script
 * (Hebrew, Arabic) inside a left to right interface (Korean, Japanese,
 * English): iOS "auto" direction follows the interface there, so the title
 * sat on the left with its period on the wrong side. Undefined for every
 * other string, so those keep the look `dir.content` gives them. Spread it
 * after `dir.content`. */
export function scriptStyle(text: string | undefined | null): typeof RTL_STYLE | undefined {
  return text && RTL_START.test(text) ? RTL_STYLE : undefined;
}

export function useDir(): Dir {
  const { rtl, lang } = useT();
  return useMemo(
    () => ({
      rtl,
      words:
        lang === 'ko'
          ? Platform.select<Dir['words']>({
              ios: { props: { lineBreakStrategyIOS: 'hangul-word' } },
              web: { style: { wordBreak: 'keep-all' } as unknown as TextStyle },
              default: {},
            })
          : NO_WORDS,
      row: rtl ? ({ flexDirection: 'row-reverse' } as const) : undefined,
      text: rtl ? ({ textAlign: 'right', writingDirection: 'rtl' } as const) : undefined,
      writing: rtl ? ({ writingDirection: 'rtl' } as const) : undefined,
      content: rtl ? ({ textAlign: 'right', writingDirection: 'auto' } as const) : ({ writingDirection: 'auto' } as const),
      chevron: rtl ? ('‹' as const) : ('›' as const),
      headerSides:
        rtl && Platform.OS !== 'ios'
          ? ({ headerLeftContainerStyle: { flexGrow: 1, flexBasis: 0 }, headerRightContainerStyle: { flexGrow: 0, flexBasis: 'auto' } } as const)
          : undefined,
    }),
    [rtl, lang],
  );
}

const NO_WORDS: Dir['words'] = {};
