import { type Key } from '@/locales/en';

type T = (key: Key) => string;

const LANGUAGE_KEY: Record<string, Key> = {
  English: 'language.en',
  Spanish: 'language.es',
};

/** The backend names Kokoro voices in English ("Spanish", "Dora (female)").
 *  Localise the language name and the gender word; the voice's own name stays. */
export function localizeVoicePart(t: T, text: string): string {
  const lang = LANGUAGE_KEY[text];
  if (lang) return t(lang);
  return text
    .replace(/\bfemale\b/, t('settings.voice.female'))
    .replace(/\bmale\b/, t('settings.voice.male'));
}

/** "Spanish Dora (female)" as one row value, in the interface language. */
export function voiceRowLabel(t: T, speakerName: string, styleName: string): string {
  return `${localizeVoicePart(t, speakerName)} ${localizeVoicePart(t, styleName)}`;
}
