/**
 * Dev review tour: "Take me there" can set a scenario first. The streak is
 * faked in memory (practice.ts devStreak); coins and freezes are real on the
 * dev backend (POST /dev/coins, 404 in prod), so a test purchase goes through.
 * No fake practice. All of it is a no-op outside __DEV__.
 */

import { devGrantCoins } from '@/lib/api';
import { clearLevelUp, clearStreakMoment, MILESTONE_DAYS, milestoneOf, pushLevelUp, pushStreakMoment } from '@/lib/level-up-store';
import { setDevStreak } from '@/lib/practice';
import { applyProgress, catalogNow, progressNow } from '@/lib/progression';

function streak(n: number | null): void {
  setDevStreak(n);
}

// --- youtube-asr-context-repair ---
// The video player's repair poll reads these instead of the server's status,
// one entry per 5 s tick, so the mid-watch landing and the failed job can be
// seen without a backend change. In memory: a kill clears it.
type RepairPhase = 'running' | 'done' | 'failed';
let repairPhases: RepairPhase[] = [];

/** True while a simulated repair sequence waits for the player's poll. */
export function devRepairPending(): boolean {
  return __DEV__ && repairPhases.length > 0;
}

/** The next simulated repair status, consumed per read; null when none is
 * set, so the poll reads the server's. */
export function devRepairPhase(): RepairPhase | null {
  if (!__DEV__) return null;
  return repairPhases.shift() ?? null;
}

// --- streak-tier-achievements ---
// tier-up-2 .. tier-up-10: the rung's "New item unlocked" screen (its item
// from the catalog cache, no grant, nothing marked seen) and then the up
// moment with the plain milestone tile. Tier N's floor is MILESTONE_DAYS[N - 2].
function tierUp(floor: number): void {
  streak(floor);
  const item = catalogNow()?.find((i) => i.unlock?.source === 'achievement' && i.unlock.need === `streak_${floor}`);
  const level = progressNow()?.level ?? 1;
  if (item) pushLevelUp({ level, prevLevel: level, coins: 0, hoursItem: item.id });
  pushStreakMoment({ kind: 'up', streak: floor, milestone: milestoneOf(floor) });
}
const TIER_UPS = Object.fromEntries(MILESTONE_DAYS.map((floor, i) => [`tier-up-${i + 2}`, () => tierUp(floor)]));
// tier-0 .. tier-10: the gem at the ladder mock's sample day for each tier (round8-hybrid/ladder.png), no moment.
const TIER_DAYS = [0, 3, 9, 21, 42, 77, 150, 250, 400, 700, 1000];
const TIERS = Object.fromEntries(TIER_DAYS.map((days, i) => [`tier-${i}`, () => streak(days)]));

const SIMULATIONS: Record<string, () => Promise<void> | void> = {
  ...TIER_UPS,
  ...TIERS,
  // The up moment on a rung reached again: the disc with "14 day milestone" on an account that owns face.streak_14, else the plain tile.
  'tier-rereach': () => {
    streak(14);
    pushStreakMoment({ kind: 'up', streak: 14, milestone: milestoneOf(14) });
  },
  'streak-zero': () => streak(0),
  'streak-milestone': () => streak(7),
  // The gem's calm (non-milestone) and three-digit numeral states.
  'streak-42': () => streak(42),
  'streak-100': () => streak(100),
  'streak-up': () => {
    streak(4);
    pushStreakMoment({ kind: 'up', streak: 4, milestone: null });
  },
  'streak-up-milestone': () => {
    streak(7);
    pushStreakMoment({ kind: 'up', streak: 7, milestone: milestoneOf(7) });
  },
  'streak-broken': () => {
    streak(0);
    clearStreakMoment();
    pushStreakMoment({ kind: 'broken', lost: 12 });
  },
  // The own profile's strip reads devStreak; needs the route of the signed-in user's profile.
  'profile-streak': () => streak(12),
  'streak-sheet': () => streak(5),
  rich: async () => applyProgress(await devGrantCoins(100000)),
  'freeze-offer': async () => {
    streak(5);
    applyProgress(await devGrantCoins(100000, true));
  },
  // Repair runs for two polls (10 s), then lands: the island reloads from the real backend.
  'repair-landing': () => {
    repairPhases = ['running', 'running', 'done'];
  },
  // The next poll reads failed: the island keeps its text, the player keeps working.
  'repair-failed': () => {
    repairPhases = ['failed'];
  },
  reset: () => {
    streak(null);
    repairPhases = [];
    clearLevelUp();
    clearStreakMoment();
  },
};

export async function runSimulation(key: string): Promise<void> {
  if (!__DEV__) return;
  await SIMULATIONS[key]?.();
}

export function resetSimulation(): void {
  if (!__DEV__) return;
  streak(null);
  repairPhases = [];
  clearLevelUp();
  clearStreakMoment();
}
