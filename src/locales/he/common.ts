import type { en as enCommon } from '../en/common';

import { isolate } from '@/lib/bidi';

/**
 * Glossary (fixed, used by every namespace): island אי / איים; line שורה;
 * take טייק; podcast פודקאסט; episode פרק; Blind ללא טקסט; Reading קריאה
 * (Furigana פוריגנה, Kana קאנה, Romaji רומאג'י); Speed מהירות; Times פעמים;
 * Pause הפסקה; Auto Echo אקו אוטומטי (Listen האזנה, Echo הד, Speak דיבור,
 * Play נגינה); Compare השוואה; Voice קול; Regenerate בנייה מחדש; Re-voice
 * החלפת קול; Calibrate speaker כיול רמקול; Export ייצוא; Rename שינוי שם;
 * Delete מחיקה; Settings הגדרות; Islands (tab) איים; Learning language שפת
 * הלימוד; Understood language שפה מובנת; App language שפת האפליקציה; Daily
 * limit מכסה יומית; Ladder סולם (Mumble מלמול, Read along קריאה יחד, Shadow
 * צל); Mode מצב.
 *
 * Gender-neutral throughout: nouns and infinitives, never a masculine-only
 * imperative (decision 5 in the app-language plan). A verb that only agrees
 * with a noun's grammatical gender (e.g. "ההקלטה נכשלה") is fine; a verb
 * conjugated for the person addressed is not used here.
 */
export const he = {
  'tab.islands': 'איים',
  'tab.podcast': 'פודקאסט',
  'tab.settings': 'הגדרות',

  'title.newIsland': 'אי חדש',
  'title.voice': 'קול',
  'title.playback': 'נגינה',
  'title.practice': 'תרגול',
  'title.data': 'נתונים',
  'title.about': 'אודות',
  'title.language': 'שפה',
  'title.prismLab': 'מעבדת פריזמה',
  'title.catLab': 'מעבדת החתול',

  'common.cancel': 'ביטול',
  'common.delete': 'מחיקה',
  'common.ok': 'אישור',
  'common.retry': 'ניסיון חוזר',
  'common.working': 'בעבודה…',
  'common.loading': 'בטעינה',

  'stage.queued': 'בתור…',
  'stage.transcribing': 'תמלול…',
  'stage.writing': 'כתיבה…',
  'stage.speaking': 'דיבור…',
  'stage.slicing': 'חיתוך…',
  'stage.extracting': 'חילוץ…',
  'stage.downloading': 'הורדה…',
  'stage.working': 'בעבודה…',
  'stage.ready': 'מוכן.',

  'api.unreachable': '\u05d0\u05d9\u05df \u05db\u05e8\u05d2\u05e2 \u05d2\u05d9\u05e9\u05d4 \u05dc\u05e9\u05e8\u05ea. \u05db\u05d3\u05d0\u05d9 \u05dc\u05e0\u05e1\u05d5\u05ea \u05e9\u05d5\u05d1 \u05d1\u05e2\u05d5\u05d3 \u05e8\u05d2\u05e2.',
  'api.daily_limit_any': '\u05d4\u05de\u05db\u05e1\u05d4 \u05d4\u05d9\u05d5\u05de\u05d9\u05ea \u05e0\u05d5\u05e6\u05dc\u05d4. \u05db\u05d3\u05d0\u05d9 \u05dc\u05e0\u05e1\u05d5\u05ea \u05e9\u05d5\u05d1 \u05de\u05d7\u05e8.',
  'api.daily_limit': 'מכסה יומית: {limit}.',
  'api.voice_unreachable': 'מנוע הקול לא זמין.',
  'api.file_too_large': 'הקובץ גדול מדי לייבוא.',
  'api.username_taken': 'שם המשתמש הזה תפוס.',
  'api.username_invalid': 'יש להשתמש ב-3-20 אותיות באנגלית, ספרות או קו תחתון.',
  'api.recording_too_large': 'ההקלטה גדולה מדי.',
  'api.audio_undecodable': 'לא ניתן לפענח את הקול.',
  'api.empty_upload': 'העלאה ריקה.',
  'api.too_long': 'הטקסט ארוך מדי. עד {limit} תווים.',
  'api.no_episode': 'לפרק הזה עדיין אין שמע לנגינה.',
  'api.not_video': 'האי הזה אינו סרטון.',
  'api.align_busy': 'השמע של הסרטון עדיין בהתאמה.',
  'api.align_closed': 'אי אפשר להתאים את הסרטון הזה שוב.',
  'api.profile_not_found': 'הפרופיל הזה לא קיים.',
  'api.requestFailed': `הבקשה נכשלה ${isolate('({status})')}`,
  'api.level_locked': 'נפתח ברמה {level_req}.',
  'api.not_enough_coins': 'אין מספיק מטבעות.',
  'api.not_owned': 'הפריט הזה עדיין לא שלך.',
  'api.unknown_item': 'הפריט הזה כבר לא קיים.',

  'islandError.import_interrupted': 'הייבוא הופסק.',
  'islandError.build_interrupted': 'הבנייה הופסקה.',
  'islandError.transcribe_empty': 'לא נמצא תמלול.',
  'islandError.no_lines': 'לא נמצאו שורות.',
  'islandError.voice_no_audio': 'הקול לא הפיק שמע.',
  'islandError.audio_undecodable': 'לא ניתן לפענח את הקול.',
  'islandError.no_line_cut': 'לא ניתן לחתוך שורה.',
  'islandError.media_undecodable': 'לא ניתן לפענח את המדיה.',
  'islandError.media_no_audio': 'אין שמע במדיה.',
  'islandError.start_past_end': 'זמן ההתחלה מאוחר מזמן הסיום.',
  'islandError.whisper_no_timings': 'התמלול לא החזיר תזמונים.',
  'islandError.no_subtitles_in_range': 'לא נמצאו כתוביות בטווח הזה.',
  'islandError.episode_download_failed': 'הורדת הפרק נכשלה.',
  'islandError.unknown': 'משהו השתבש.',

  'api.account_delete_unavailable': 'מחיקת חשבון עדיין לא הוגדרה בשרת.',
  'api.account_delete_failed': 'לא ניתן היה למחוק את החשבון. כדאי לנסות שוב מאוחר יותר.',
} satisfies Record<keyof typeof enCommon, string>;
