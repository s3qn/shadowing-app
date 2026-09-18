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
  'player.play': 'נגינה',
  'player.sharingUnavailable': 'השיתוף אינו זמין במכשיר הזה',
  'player.exportFailed': 'לא ניתן לייצא את האי. כדאי לנסות שוב.',
  'player.exportNotReady': 'האי עדיין בבנייה, או שלשורה אין קול עדיין.',
  'player.exportVoiceUnavailable': 'מנוע הקול אינו זמין כרגע.',
} satisfies Record<keyof typeof enPlayer, string>;
