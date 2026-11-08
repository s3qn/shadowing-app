import type { en as enPlayer } from '../en/player';

export const he = {
  'player.island': 'אי',
  'player.phrase': 'קטע',
  'player.phraseWith': 'קטע: {label}',
  'player.wholeLine': 'כל השורה',
  'player.microphoneLevel': 'עוצמת המיקרופון',
  'player.repeatSelection': 'חזרה על הקטע',
  'player.explainSelection': 'הסבר על הקטע',
  'player.copied': 'הועתק',
  'player.copySelection': 'העתקת הקטע',
  'player.stop': 'עצירה',
  'player.play': 'הפעלה',
  'player.sharingUnavailable': 'השיתוף לא זמין במכשיר הזה',
  'player.exportFailed': 'לא הצלחנו לייצא את האי. נסו שוב.',
  'player.exportNotReady': 'האי עדיין בבנייה, או שלשורה עוד אין קול.',
  'player.exportVoiceUnavailable': 'מנוע הקול לא זמין כרגע.',
  'player.secsLeft': '{n} שנ׳',
  'player.langCode.ja': 'יפנית',
  'player.langCode.es': 'ספרדית',
  'player.langCode.en': 'אנגלית',
  'player.langCode.he': 'עברית',
} satisfies Record<keyof typeof enPlayer, string>;
