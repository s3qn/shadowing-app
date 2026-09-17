import type { en as enPlayerSheets } from '../en/player-sheets';

export const he = {

  'player.lookingUp': 'בחיפוש…',
  'player.noDictionaryEntry': 'אין ערך במילון.',
  'player.nothingToAdd': 'אין מה להוסיף.',
  'player.inThisSentence': 'במשפט הזה: {context}',
  'player.hearAgain': 'לשמוע שוב',

  'player.explainTitle': 'הסבר',
  'player.explainNoAnswer': 'לא התקבלה תשובה כרגע.',
  'player.vocabulary': 'אוצר מילים',
  'player.grammar': 'דקדוק',
  'player.summary': 'סיכום',

  'player.saveTakeFailed': 'לא ניתן היה לשמור את הטייק.',
  'player.recordingStoppedUnexpectedly': 'ההקלטה נעצרה באופן בלתי צפוי.',
  'player.micAccessOff': 'הגישה למיקרופון כבויה. יש להפעיל אותה בהגדרות ולנסות שוב.',
  'player.startRecordingFailed': 'לא ניתן היה להתחיל בהקלטה.',
} satisfies Record<keyof typeof enPlayerSheets, string>;
