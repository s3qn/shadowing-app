/**
 * The onboarding Echo Loop's sample word: "thank you" in each language the
 * app lists in `languages.ts`. `reading` is set only for non-Latin scripts.
 * The gloss under it is the interface-language key `intro.sample.gloss`.
 */
export type SampleWord = { word: string; reading?: string; rtl?: boolean };

const SAMPLE_WORDS: Record<string, SampleWord> = {
  ja: { word: 'ありがとう', reading: 'arigatou' },
  es: { word: 'gracias' },
  en: { word: 'thank you' },
  fr: { word: 'merci' },
  de: { word: 'danke' },
  pt: { word: 'obrigado' },
  it: { word: 'grazie' },
  ru: { word: 'спасибо', reading: 'spasibo' },
  ko: { word: '감사합니다', reading: 'gamsahamnida' },
  zh: { word: '谢谢', reading: 'xièxie' },
  hi: { word: 'धन्यवाद', reading: 'dhanyavaad' },
  ar: { word: 'شكرًا', reading: 'shukran', rtl: true },
  he: { word: 'תודה', reading: 'todah', rtl: true },
};

export function sampleWordFor(languageId: string | undefined): SampleWord {
  return (languageId ? SAMPLE_WORDS[languageId] : undefined) ?? SAMPLE_WORDS.ja;
}

const WIDE = /[ᄀ-ᇿ぀-ヿ㐀-鿿가-힯]/;

/** Largest font size (up to `max`) at which `word` stays on one line in `width`. */
export function fitFontSize(word: string, width: number, max = 30): number {
  let em = 0;
  for (const ch of word) em += WIDE.test(ch) ? 1.05 : 0.62;
  return Math.max(16, Math.min(max, Math.floor((width - 6) / Math.max(em, 1))));
}
