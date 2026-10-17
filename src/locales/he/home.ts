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
  'home.practiceNow': 'לתרגל עכשיו',
  'home.dueToday': 'ממתינים היום',
  'home.lines': '{count} שורות',
  'home.lines_one': 'שורה אחת',
  'home.lines_two': '{count} שורות',
  'home.lines_other': '{count} שורות',
  'home.minutes': '{count} דקות',
  'home.minutes_one': 'דקה אחת',
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
  'home.download': 'הורדה',
  'home.downloading': 'הורדה: {done} מתוך {total}',
  'home.downloaded': 'הורד · {size}',
  'home.downloadFailed': 'ההורדה נכשלה, הקשה לניסיון חוזר',
  'home.downloadStopTitle': 'לעצור את ההורדה?',
  'home.downloadKeepGoing': 'להמשיך',
  'home.downloadStop': 'עצירה',
  'home.downloadRemoveTitle': 'להסיר את ההורדה?',
  'home.downloadRemoveBody': 'האי נשאר בשרת. הטייקים שלך בטלפון הזה נשמרים.',
  'home.downloadRemove': 'הסרה',
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

  // Add-island sheet and ready-made phrases
  'home.addTitle': 'הוספת אי',
  'home.add.record': 'הקלטה',
  'home.add.phrases': 'ביטויים',
  'home.noIslandsHint': 'הקשה על + פותחת הקלטה, ביטויים מוכנים, ייבוא שמע או קישור ל-YouTube.',
  'home.phrasesTitle': 'ביטויים',
  'home.phrasesError': 'לא ניתן לטעון את הביטויים.',
  'home.phrasesCount': '{count} ביטויים',
  'home.drive': 'נהיגה',
  'home.phrasesCount_one': 'ביטוי אחד',
  'home.phrasesCount_two': '{count} ביטויים',
  'home.phrasesCount_other': '{count} ביטויים',
  'phrases.prompt': 'מה רוצים להגיד?',
  'phrases.promptHint': 'לוחצים על הנקודה האדומה ואומרים נושא, למשל "חדר כושר"',
  'phrases.micLabel': 'להגיד נושא',
  'phrases.topicHint': 'יוצרים משפטים על מה שאמרתם. לוקח פחות מדקה.',
  'phrases.added': 'נוסף',
  'phrases.tabPhrases': 'ביטויים',
  'phrases.tabGrammar': 'דקדוק',
  'phrases.flipHint': '‹ גוררים הצידה כדי להחליף ›',
  'phrases.grammarSearch': 'חיפוש דקדוק לפי תבנית, קריאה או משמעות',
  'phrases.grammarSearchClear': 'ניקוי החיפוש',
  'phrases.grammarNoMatch': 'אין נקודת דקדוק שמתאימה',
  'home.phrasesBuildHint': 'זה לוקח פחות מדקה. אפשר לסגור את המסך הזה, האי ממשיך להיבנות ומופיע ברשימה כשהוא מוכן.',
} satisfies Record<keyof typeof enHome, string>;
