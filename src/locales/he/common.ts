import type { en as enCommon } from '../en/common';

/**
 * Glossary (fixed, used by every namespace): island אי / איים; line שורה;
 * take טייק; podcast פודקאסט; episode פרק; Blind ללא טקסט; Reading קריאה
 * (Furigana פוריגנה, Kana קאנה, Romaji רומאג'י); Speed מהירות; Times פעמים;
 * Pause הפסקה; Auto Echo אקו אוטומטי (Listen האזנה, Echo הד, Speak דיבור,
 * Play נגינה); Compare השוואה; Voice קול; Regenerate בנייה מחדש; Re-voice
 * החלפת קול; Calibrate speaker כיול רמקול; Export ייצוא; Rename שינוי שם;
 * Delete מחיקה; Settings הגדרות; Islands (tab) איים; Learning language שפת
 * הלימוד; Understood language שפה מובנת; App language שפת האפליקציה; Daily
 * limit מכסה יומית.
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

  'common.cancel': 'ביטול',
  'common.delete': 'מחיקה',
  'common.ok': 'אישור',
  'common.retry': 'ניסיון חוזר',
  'common.working': 'בעבודה…',
  'common.loading': 'בטעינה',

  'stage.queued': 'בתור',
  'stage.transcribing': 'תמלול',
  'stage.writing': 'כתיבה',
  'stage.speaking': 'דיבור',
  'stage.slicing': 'חיתוך',
  'stage.extracting': 'חילוץ',
  'stage.downloading': 'הורדה',
  'stage.working': 'בעבודה…',

  'api.daily_limit': 'מכסה יומית: {limit}.',
  'api.voice_unreachable': 'מנוע הקול לא זמין.',
  'api.file_too_large': 'הקובץ גדול מדי לייבוא.',
  'api.recording_too_large': 'ההקלטה גדולה מדי.',
  'api.audio_undecodable': 'לא ניתן לפענח את הקול.',
  'api.empty_upload': 'העלאה ריקה.',

  'islandError.import_interrupted': 'הייבוא הופסק.',
  'islandError.build_interrupted': 'הבנייה הופסקה.',
  'islandError.transcribe_empty': 'לא נמצא תמלול.',
  'islandError.no_lines': 'לא נמצאו שורות.',
  'islandError.voice_no_audio': 'הקול לא הפיק שמע.',
  'islandError.audio_undecodable': 'לא ניתן לפענח את הקול.',
  'islandError.no_line_cut': 'לא ניתן היה לחתוך שורה.',
  'islandError.media_undecodable': 'לא ניתן לפענח את המדיה.',
  'islandError.media_no_audio': 'אין שמע במדיה.',
  'islandError.start_past_end': 'זמן ההתחלה מאוחר מזמן הסיום.',
  'islandError.whisper_no_timings': 'התמלול לא החזיר תזמונים.',
  'islandError.no_subtitles_in_range': 'לא נמצאו כתוביות בטווח הזה.',
  'islandError.episode_download_failed': 'הורדת הפרק נכשלה.',
  'islandError.unknown': 'משהו השתבש.',
} satisfies Record<keyof typeof enCommon, string>;
