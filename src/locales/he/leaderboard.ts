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
  'leaderboard.empty': 'עוד אין חתולים בלוח. אחרי תרגול של שורה, החתול שלך מצטרף.',
  'leaderboard.failed': 'לא ניתן לטעון את הדירוג.',
  'leaderboard.retry': 'ניסיון חוזר',
  'leaderboard.open': 'פתיחת הדירוג',
};
