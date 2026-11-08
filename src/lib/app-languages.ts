/**
 * The interface languages that are finished and offered. A language with a
 * catalogue folder but no entry here is hidden from the picker and ignored
 * by `resolveAppLanguage` and a stored pick. Append a code only once
 * `tools/rules/locale-parity.test.js` passes for it. Kept apart from
 * `i18n.ts` so `settings.ts` can read it without an import cycle.
 */
export const COMPLETE_LANGS = ['en', 'he', 'fr', 'pt', 'de', 'es', 'zh', 'ko', 'ja', 'ar'] as const;

/** Where each interface language is spoken, shown as information-only chips
 * on the App language cards. Labels stay in each country's own script. */
export const APP_LANGUAGE_REGIONS: Record<(typeof COMPLETE_LANGS)[number], { flag: string; label: string }[]> = {
  en: [
    { flag: '🇬🇧', label: 'UK' },
    { flag: '🇺🇸', label: 'US' },
    { flag: '🇦🇺', label: 'Australia' },
    { flag: '🇮🇳', label: 'India' },
  ],
  he: [{ flag: '🇮🇱', label: 'ישראל' }],
  fr: [
    { flag: '🇫🇷', label: 'France' },
    { flag: '🇨🇦', label: 'Canada' },
    { flag: '🇸🇳', label: 'Sénégal' },
  ],
  pt: [{ flag: '🇧🇷', label: 'Brasil' }],
  de: [
    { flag: '🇩🇪', label: 'Deutschland' },
    { flag: '🇦🇹', label: 'Österreich' },
    { flag: '🇨🇭', label: 'Schweiz' },
  ],
  es: [
    { flag: '🇪🇸', label: 'España' },
    { flag: '🇲🇽', label: 'México' },
    { flag: '🇦🇷', label: 'Argentina' },
  ],
  zh: [
    { flag: '🇨🇳', label: '简体' },
    { flag: '🇹🇼', label: '繁體' },
  ],
  ko: [{ flag: '🇰🇷', label: '대한민국' }],
  ja: [{ flag: '🇯🇵', label: '日本' }],
  ar: [
    { flag: '🇸🇦', label: 'السعودية' },
    { flag: '🇪🇬', label: 'مصر' },
    { flag: '🇲🇦', label: 'المغرب' },
  ],
};

export function isCompleteLang(v: string): boolean {
  return (COMPLETE_LANGS as readonly string[]).includes(v);
}
