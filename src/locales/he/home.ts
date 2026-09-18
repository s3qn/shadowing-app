import type { en as enHome } from '../en/home';

import { isolate } from '@/lib/bidi';

export const he = {
  // Home screen chrome
  'home.searchAccessibilityLabel': 'חיפוש איים',
  'home.recordAccessibilityLabel': 'הקלטת אי חדש',
  'home.notConfigured': `יש להגדיר את ${isolate('EXPO_PUBLIC_SHADOW_API_URL')} ואת ${isolate('EXPO_PUBLIC_SHADOW_TOKEN')} בקובץ ${isolate('.env')}, ולאחר מכן להפעיל מחדש את שרת הפיתוח.`,
  'home.serverUnreachable': 'לא ניתן להגיע לשרת',
  'home.serverNoAnswer': 'השרת לא הגיב.',

  // Sort row
  'home.sortNewest': 'החדשים ביותר',
  'home.sortLeastPracticed': 'הכי פחות מתורגלים',

  // Empty and error states
  'home.noIslandMatches': 'לא נמצא אי מתאים',
  'home.noIslandsYet': 'עדיין אין איים. אפשר להקליט דקה מהיום ולבנות ממנה אי.',

  // Island card
  'home.untitledIsland': 'אי ללא שם',
  'home.failed': 'נכשל',
  'home.dueToday': 'ממתין להיום',
  'home.lines': '{count} שורות',
  'home.lines_one': '{count} שורה',
  'home.lines_two': '{count} שורות',
  'home.lines_other': '{count} שורות',
  'home.minutes': '{count} דקות',
  'home.minutes_one': '{count} דקה',
  'home.minutes_two': '{count} דקות',
  'home.minutes_other': '{count} דקות',
  'home.keptUp': `עמידה בקצב ${isolate('{kept}/{total}')}`,
  'home.complexitySimple': 'פשוט',
  'home.complexityComplex': 'מורכב',

  // Rename/delete sheet
  'home.deleteConfirmTitle': 'למחוק את "{title}"?',
  'home.deleteConfirmBody': 'ההקלטה, השורות שלה והשמע שלהן יוסרו. לא ניתן לבטל פעולה זו.',
  'home.deleteFailedTitle': 'לא ניתן למחוק',
  'home.renameFailedTitle': 'לא ניתן לשנות שם',
  'home.save': 'שמירה',
  'home.rename': 'שינוי שם',
  'home.deleteIsland': 'מחיקת אי',

  // Practice card
  'home.practiceToday': 'היום',
  'home.practiceStreak': 'רצף',
  // Isolated: the run is all neutral ("/" and digits), so without it the
  // slash takes the line's right to left direction and drifts off the
  // numbers it joins.
  'home.practiceGoal': isolate('/{goal}'),
  'home.weekdaySun': 'א',
  'home.weekdayMon': 'ב',
  'home.weekdayTue': 'ג',
  'home.weekdayWed': 'ד',
  'home.weekdayThu': 'ה',
  'home.weekdayFri': 'ו',
  'home.weekdaySat': 'ש',

  // Island search
  'home.searchPlaceholder': 'חיפוש איים',
  'home.closeSearchAccessibilityLabel': 'סגירת חיפוש',

  // Podcast tab
  'home.podcastSearchPlaceholder': `חיפוש פודקאסט או כתובת ${isolate('URL')}`,
  'home.podcastCatalogError': 'לא ניתן לטעון את הקטלוג.',
  'home.podcastSearchError': 'החיפוש נכשל.',
  'home.podcastNoShowsFound': 'לא נמצאו תוכניות.',
  'home.podcastLevelBeginner': 'בסיסית',
  'home.podcastLevelIntermediate': 'בינונית',
  'home.podcastLevelAdvanced': 'מתקדמת',
  'home.podcastViewAll': 'הצגת הכל ({count})',

  // Podcast episodes
  'home.episodesTitle': 'פרקים',
  'home.episodesFeedError': 'לא ניתן לטעון את הפיד.',
  'home.episodeFallbackTitle': 'פרק פודקאסט',
  'home.untitledEpisode': 'פרק ללא שם',
} satisfies Record<keyof typeof enHome, string>;
