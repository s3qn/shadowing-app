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

import { type Key, en } from '@/locales/en';
import { he } from '@/locales/he';
import { isolate } from '@/lib/bidi';
import { getSettingsSync, subscribeSettings, type Settings } from '@/lib/settings';

export type Lang = 'en' | 'he';

export const LOCALES: Record<Lang, { tag: string; rtl: boolean; native: string }> = {
  en: { tag: 'en-US', rtl: false, native: 'English' },
  he: { tag: 'he-IL', rtl: true, native: 'עברית' },
};

const CATALOGUES: Record<Lang, Record<string, string>> = { en, he };

function isLang(v: string): v is Lang {
  return v === 'en' || v === 'he';
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

function pluralSuffix(lang: Lang, count: number): 'one' | 'two' | 'other' {
  if (lang === 'he') {
    if (count === 1) return 'one';
    if (count === 2) return 'two';
    return 'other';
  }
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

/** Reads the current settings synchronously, so it works outside a
 * component (an Alert body, a thrown error message) as well as inside one. */
export function t(key: Key, vars?: Vars): string {
  const lang = resolveAppLanguage(getSettingsSync());
  let resolvedKey: string = key;
  if (vars && typeof vars.count === 'number') {
    const suffixed = `${key}_${pluralSuffix(lang, vars.count)}`;
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

/** For a component: re-renders when the app language changes (a settings
 * write, or an onboarding preview), without a Context provider. */
export function useT(): { t: typeof t; lang: Lang; rtl: boolean; locale: string } {
  const lang = useSyncExternalStore(subscribeLang, () => resolveAppLanguage(getSettingsSync()));
  return { t, lang, rtl: LOCALES[lang].rtl, locale: LOCALES[lang].tag };
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
  /** The "go forward" chevron glyph, mirrored for a reversed reading order. */
  chevron: '›' | '‹';
};

/** Mirrors the handful of rows and text alignments that read as a sequence
 * (decision 1: soft RTL). Media controls, centred and symmetric layouts are
 * left alone, see the plan's Direction pass. Memoised so `style={[a, dir.row]}`
 * does not get a new object every render while `rtl` stays the same. */
export function useDir(): Dir {
  const { rtl } = useT();
  return useMemo(
    () => ({
      rtl,
      row: rtl ? ({ flexDirection: 'row-reverse' } as const) : undefined,
      text: rtl ? ({ textAlign: 'right', writingDirection: 'rtl' } as const) : undefined,
      writing: rtl ? ({ writingDirection: 'rtl' } as const) : undefined,
      chevron: rtl ? ('‹' as const) : ('›' as const),
    }),
    [rtl],
  );
}
