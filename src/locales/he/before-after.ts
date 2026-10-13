import type { en as enBeforeAfter } from '../en/before-after';

export const he = {
  'beforeAfter.title': 'לפני ואחרי',
  'beforeAfter.first': 'ראשון',
  'beforeAfter.now': 'עכשיו',
  'beforeAfter.noTakeNow': 'אין הקלטה עכשיו',
  'beforeAfter.empty': 'ההקלטה הראשונה של כל משפט נשמרת. הקליטו משפט פעם שנייה ושתי ההקלטות ייפגשו כאן.',
} satisfies Record<keyof typeof enBeforeAfter, string>;
