import type { en as enRecord } from '../en/record';

import { isolate } from '@/lib/bidi';

export const he = {
  'record.close': 'סגירה',

  'record.title.idle': 'ספרו על היום שלכם, בערך 30 שניות.',
  'record.title.recording': 'המשיכו לספר על היום שלכם.',
  'record.title.review': 'ההקלטה שלכם',
  'record.topic.title.idle': 'אמרו נושא',
  'record.topic.title.recording': 'בהאזנה…',
  'record.topic.title.review': 'הנושא שלכם',
  'record.topic.hint': 'אמרו נושא, למשל ״ביטויים לחדר כושר״, או נקודת דקדוק, למשל ながら',
  'record.topic.build': 'בניית ביטויים',
  'record.promptHint':
    'דברו בעברית או באנגלית, איך שנוח לכם. מה שתגידו יהפוך למשפטים ב{language} על החיים שלכם, אז כדאי להשתמש בשמות ובמקומות אמיתיים.',
  'record.language.ja': 'יפנית',
  'record.language.es': 'ספרדית',
  'record.language.en': 'אנגלית',
  'record.language.he': 'עברית',

  'record.mode.say': 'משפט אחד',
  'record.mode.island': 'היום שלי',
  'record.say.title.idle': 'אמרו משפט אחד ב{language}.',
  'record.say.title.recording': 'בהאזנה…',
  'record.say.hint': 'זה חוזר ב{language}, מוקלט בקול, מוכן לשאדו.',
  'record.say.ready': 'תורגם והוקלט',
  'record.say.youSaid': 'אמרתם · {language}',
  'record.say.more': '+ עוד {count} שורות',
  'record.say.more_one': '+ עוד שורה אחת',
  'record.say.more_other': '+ עוד {count} שורות',
  'record.say.back': 'שורה חדשה',
  'record.say.again': 'להגיד שוב',
  'record.say.shadow': 'לחזור אחריו',

  'record.waveform': 'צורת הגל של ההקלטה',
  'record.playRecording': 'השמעת ההקלטה',
  'record.pauseRecording': 'השהיית ההקלטה',

  'record.sentencesLabel': 'משפטים',
  'record.complexity.simple.label': 'אחד בכל פעם',
  'record.complexity.simple.description': 'שורות קצרות ונפרדות, רעיון אחד בכל שורה.',
  'record.complexity.complex.label': 'מורכב',
  'record.complexity.complex.description': 'משפטים מורכבים ודיבור רציף.',

  'record.styleLabel': 'סגנון',
  'record.register.polite.label': 'מנומס',
  'record.register.polite.description': `${isolate('です/ます')}, הסגנון היומיומי הרגיל.`,
  'record.register.casual.label': 'יומיומי',
  'record.register.casual.description': 'צורת מילון, כמו שמדברים עם חבר.',

  'record.startRecording': 'התחלת הקלטה',
  'record.stopRecording': 'עצירת ההקלטה',
  'record.tapToStart': 'לחצו כדי להתחיל',
  'record.tapToStop': 'לחצו כדי לעצור',
  'record.keepGoing': 'המשיכו, עוד {seconds} שניות',

  'record.buildIsland': 'בניית האי',
  'record.recordAgain': 'הקלטה מחדש',
  'record.discard': 'מחיקת ההקלטה',

  'record.buildHint': 'זה לוקח בערך דקה. אפשר לסגור את המסך הזה, האי ממשיך להיבנות ומופיע ברשימה כשהוא מוכן.',
  'record.say.buildHint': 'אפשר לחזור אחורה, זה ממשיך להיבנות.',
  'record.podcastBuildHint': 'זה לוקח כמה דקות. אפשר לסגור את המסך הזה, האי ממשיך להיבנות ומופיע ברשימה כשהוא מוכן.',
  'record.defaultEpisodeTitle': 'פרק פודקאסט',

  'record.micOff': 'הגישה למיקרופון כבויה. הפעילו אותה בהגדרות ונסו שוב.',
  'record.backgroundStopped': 'ההקלטה נעצרה כשהאפליקציה עברה לרקע.',
  'record.uploadFailed': 'ההעלאה נכשלה',
  'record.episodeDownloadFailed': 'הורדת הפרק נכשלה.',
} satisfies Record<keyof typeof enRecord, string>;
