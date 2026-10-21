import { isolate } from '@/lib/bidi';

export const he = {
  'leaderboard.title': 'דירוג',
  'leaderboard.highest': 'הרמה הגבוהה ביותר',
  'leaderboard.lv': 'רמה',
  'leaderboard.you': 'אני',
  'leaderboard.rowLabel': '{rank}. {name}, רמה {level}',
  'leaderboard.next': `הבא: ${isolate('@{name}')}, עוד {n} רמות`,
  'leaderboard.next_one': `הבא: ${isolate('@{name}')}, עוד רמה אחת`,
  'leaderboard.next_two': `הבא: ${isolate('@{name}')}, עוד שתי רמות`,
  'leaderboard.empty': 'עוד אין חתולים בלוח. אחרי שתתרגלו שורה, החתול שלכם יצטרף.',
  'leaderboard.failed': 'לא ניתן לטעון את הדירוג.',
  'leaderboard.retry': 'ניסיון חוזר',
  'leaderboard.open': 'פתיחת הדירוג',
  'leaderboard.tabLevel': 'רמה',
  'leaderboard.tabWeek': 'השבוע',
  'leaderboard.weekTop': 'השבוע',
  'leaderboard.pts': 'נק׳',
  'leaderboard.topPct': '\u2066{n}%\u2069 העליונים',
  'leaderboard.weeklyEmpty': 'עוד אין דקות השבוע. האזינו לפודקאסט והחתול שלכם יצטרף.',
  'leaderboard.weeklyJoin': 'החתול שלכם יצטרף אחרי דקת האזנה ראשונה.',
};
