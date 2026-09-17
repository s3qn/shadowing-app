import type { en as enRecord } from '../en/record';

export const he = {
  'record.close': 'סגירה',

  'record.title.idle': 'לספר על היום שלך, בערך 30 שניות.',
  'record.title.recording': 'להמשיך לספר על היום שלך.',
  'record.title.review': 'ההקלטה שלך',
  'record.promptHint':
    'אפשר לדבר בעברית או באנגלית, איך שנוח. מה שאומרים הופך למשפטים ב{language} על החיים שלך, אז כדאי להשתמש בשמות ובמקומות אמיתיים.',
  'record.language.ja': 'יפנית',
  'record.language.es': 'ספרדית',
  'record.language.en': 'אנגלית',

  'record.waveform': 'צורת הגל של ההקלטה',
  'record.playRecording': 'השמעת ההקלטה',
  'record.pauseRecording': 'השהיית ההקלטה',

  'record.sentencesLabel': 'משפטים',
  'record.complexity.simple.label': 'אחד בכל פעם',
  'record.complexity.simple.description': 'שורות קצרות ונפרדות, רעיון אחד בכל שורה.',
  'record.complexity.complex.label': 'מורכב',
  'record.complexity.complex.description': 'משפטי משנה ודיבור מחובר.',

  'record.styleLabel': 'סגנון',
  'record.register.polite.label': 'מנומס',
  'record.register.polite.description': 'です/ます, הסגנון היומיומי הרגיל.',
  'record.register.casual.label': 'יומיומי',
  'record.register.casual.description': 'צורת מילון, כמו שמדברים עם חבר.',

  'record.startRecording': 'התחלת הקלטה',
  'record.stopRecording': 'עצירת ההקלטה',
  'record.tapToStart': 'הקשה כדי להתחיל',
  'record.tapToStop': 'הקשה כדי לעצור',
  'record.keepGoing': 'להמשיך, עוד {seconds} שניות',

  'record.buildIsland': 'בניית האי',
  'record.recordAgain': 'הקלטה מחדש',
  'record.discard': 'מחיקת ההקלטה',

  'record.buildHint': 'זה לוקח בערך דקה. אפשר לסגור את המסך הזה, האי ממשיך להיבנות ומופיע ברשימה כשהוא מוכן.',
  'record.podcastBuildHint': 'זה לוקח כמה דקות. אפשר לסגור את המסך הזה, האי ממשיך להיבנות ומופיע ברשימה כשהוא מוכן.',
  'record.defaultEpisodeTitle': 'פרק פודקאסט',

  'record.micOff': 'הגישה למיקרופון כבויה. אפשר להפעיל אותה בהגדרות ולנסות שוב.',
  'record.backgroundStopped': 'ההקלטה נעצרה כשהאפליקציה עברה לרקע.',
  'record.uploadFailed': 'ההעלאה נכשלה',
  'record.episodeDownloadFailed': 'הורדת הפרק נכשלה.',
} satisfies Record<keyof typeof enRecord, string>;
