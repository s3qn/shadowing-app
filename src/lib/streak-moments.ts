/**
 * The streak-broken check. Home calls it on focus and again once progress
 * loads; it judges at most once per app run, and only after progress has
 * loaded or 4 s have passed, so a freeze the server just settled is in the
 * log before a lost streak is called lost. The streak-up moment is detected
 * where the day crosses into counting (practice.ts `flushPractice`).
 */

import { pushStreakMoment } from '@/lib/level-up-store';
import { getPracticeLog, setSeenStreak, streakDays } from '@/lib/practice';

const GRACE_MS = 4000;

let judged = false;
let judging = false;
let firstAt = 0;
let timer: ReturnType<typeof setTimeout> | null = null;

async function judge() {
  if (judged || judging) return;
  judging = true;
  try {
    // Fresh from disk: a progress snapshot may have just written its frozen days.
    const log = await getPracticeLog();
    judged = true;
    const now = streakDays(log, new Date());
    const seen = log.seenStreak;
    if (seen >= 2 && now === 0) {
      // seenStreak drops to 0 when the moment mounts, so a kill before then shows it again.
      pushStreakMoment({ kind: 'broken', lost: seen });
      return;
    }
    // A fresh install, an old build's log, or practice the moment did not see: seed quietly.
    if (now !== seen) await setSeenStreak(now);
  } finally {
    judging = false;
  }
}

export function checkStreakMoments(progressLoaded: boolean): void {
  if (judged) return;
  if (!firstAt) firstAt = Date.now();
  const waited = Date.now() - firstAt;
  if (progressLoaded || waited >= GRACE_MS) {
    if (timer) clearTimeout(timer);
    timer = null;
    void judge();
    return;
  }
  if (!timer) {
    timer = setTimeout(() => {
      timer = null;
      void judge();
    }, GRACE_MS - waited);
  }
}
