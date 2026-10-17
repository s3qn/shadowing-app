import type { en as enBeforeAfter } from '../en/before-after';

export const he = {
  'beforeAfter.title': 'לפני ואחרי',
  'beforeAfter.first': 'ראשון',
  'beforeAfter.now': 'עכשיו',
  'beforeAfter.noTakeNow': 'אין הקלטה עכשיו',
  'beforeAfter.empty': 'ההקלטה הראשונה של כל משפט נשמרת. אחרי הקלטה שנייה של משפט, שתי ההקלטות נפגשות כאן.',
} satisfies Record<keyof typeof enBeforeAfter, string>;
