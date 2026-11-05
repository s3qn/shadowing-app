/**
 * Dev review tour: "Take me there" can set a scenario first. The streak is
 * faked in memory (practice.ts devStreak); coins and freezes are real on the
 * dev backend (POST /dev/coins, 404 in prod), so a test purchase goes through.
 * No fake practice. All of it is a no-op outside __DEV__.
 */

import { devGrantCoins, type CatchCollection, type Line, type NativeLanguage } from '@/lib/api';
import { setBetaOverride } from '@/lib/beta';
import { clearLevelUp, clearStreakMoment, MILESTONE_DAYS, milestoneOf, pushLevelUp, pushStreakMoment } from '@/lib/level-up-store';
import { setDevApiBlock } from '@/lib/dev-api-block';
import { setDevEnergy } from '@/lib/energy';
import { requestTranscriptEnd, resetTranscriptSim, setTranscriptSim } from '@/lib/dev-transcripts';
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

// --- bl72-known-words ---
// The My words page reads this instead of the server: a fresh account (empty)
// or a spread of known and learning words. In memory: a kill clears it.
let wordsSim: CatchCollection | null = null;

/** The simulated My words collection, or null to read the server's. */
export function devWordsCollection(): CatchCollection | null {
  return __DEV__ ? wordsSim : null;
}

function simWords(kind: 'empty' | 'mixed'): void {
  if (kind === 'empty') {
    wordsSim = { language: 'ja', total: 0, learning: 0, known: 0, words: [] };
    return;
  }
  const row = (word: string, meaning: string, state: 'known' | 'learning', caught: number, missed: number) => ({
    word, meaning, sentence: `${word}が好きです。`, island_id: '', state, caught, missed, reviews: caught + missed, due: '',
  });
  const words = [
    row('猫', 'cat', 'learning', 1, 2),
    row('犬', 'dog', 'known', 4, 0),
    row('水', 'water', 'known', 5, 1),
    row('食べる', 'to eat', 'learning', 2, 1),
  ];
  const known = words.filter((w) => w.state === 'known').length;
  wordsSim = { language: 'ja', total: words.length, learning: words.length - known, known, words };
}

// --- night-flow ---
// The ladder's Record becomes a 2 s fake take with a fixed score, so Compare,
// the hold, the score and Loop run without a good mic. In memory. The score:
// `ladder-fake-take` 86 (4 of 5 words), `ladder-fake-take-90` 95 (5 of 5
// words, so a 90+ moment like the island's Easy offer fires).
let fakeTake: number | null = null;

/** True while a `ladder-fake-take*` key is on: use-ladder skips the mic. */
export function devFakeTake(): boolean {
  return __DEV__ && fakeTake !== null;
}

/** The fake take's score; 86 when no key is on (callers check `devFakeTake()` first). */
export function devFakeTakeScore(): number {
  return fakeTake ?? 86;
}

// --- focus-session ---
// The ladder's stage without the phone or Settings: a forced mic route (the
// headphones hint and turn-taking), the run's blind take, and a run that pauses
// itself. In memory: a kill clears them.
let forcedRoute: 'speaker' | 'headset' | null = null;
let blindTakeSim: boolean | null = null;
let autoPause = false;

/** The forced mic route for `probeHeadset`, null to probe for real. */
export function devForcedRoute(): 'speaker' | 'headset' | null {
  return __DEV__ ? forcedRoute : null;
}

/** The run's blind take, null to read Settings. */
export function devBlindTake(): boolean | null {
  return __DEV__ ? blindTakeSim : null;
}

/** True once after `ladder-paused`: the next run pauses itself 1.5 s after it starts. */
export function devAutoPause(): boolean {
  if (!__DEV__ || !autoPause) return false;
  autoPause = false;
  return true;
}

// --- focus-stories ---
// The Stories gestures without Settings or a second island: the run's hands-free,
// an island with no neighbours (the cube bounces), a line with no translation.
let handsFreeSim: boolean | null = null;
let noNeighbours = false;
let noTranslation = false;

/** The run's Hands-free (`ladder-handsfree-off` / `-on`), null to read the host and Settings. */
export function devHandsFree(): boolean | null {
  return __DEV__ ? handsFreeSim : null;
}

/** True while `ladder-no-neighbours` is on: the stage gets no neighbours, so both swipes rubber-band. */
export function devNoNeighbours(): boolean {
  return __DEV__ && noNeighbours;
}

/** True while `ladder-no-translation` is on: the stage reads the line's translation as empty. */
export function devNoTranslation(): boolean {
  return __DEV__ && noTranslation;
}

function resetFocus(): void {
  forcedRoute = null;
  blindTakeSim = null;
  autoPause = false;
  handsFreeSim = null;
  noNeighbours = false;
  noTranslation = false;
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

// --- say-it ---
// The record screen's say mode reads these: the transcript rides the next
// uploads as dev_transcript (the backend honours it outside prod and skips
// whisper), offline makes the upload throw before it starts. Both stay set
// until reset. In memory: a kill clears them.
let sayTranscript = '';
let sayOffline = false;

/** The canned transcript for a say upload, '' when none is set. */
export function devSayTranscript(): string {
  return __DEV__ ? sayTranscript : '';
}

/** True when a say upload should fail before it reaches the server. */
export function devSayOffline(): boolean {
  return __DEV__ && sayOffline;
}

// --- session-old-look ---
// `record.sayResult`: the record screen opens on its say result frame with this
// canned line, with no energy spent and no backend call. Read once on mount.
export type SayResultSim = { id: string; said: string; native: NativeLanguage; line: Line; count: number };
let sayResult: SayResultSim | null = null;

/** The canned say result for the record screen, null when none is set. */
export function devSayResult(): SayResultSim | null {
  return __DEV__ ? sayResult : null;
}

const SAY_RESULT_LINE: Line = {
  idx: 0,
  ja: '今日は天気がいいので、散歩に行きます。',
  kana: 'きょうはてんきがいいので、さんぽにいきます。',
  romaji: 'kyou wa tenki ga ii node, sanpo ni ikimasu.',
  en: 'The weather is nice today, so I will go for a walk.',
  duration: 3.4,
  timeline: [],
  words: [
    { text: '今日は', start: 0, end: 0.5 },
    { text: '天気が', start: 0.55, end: 1.0 },
    { text: 'いいので', start: 1.05, end: 1.7 },
    { text: '散歩に', start: 2.0, end: 2.6 },
    { text: '行きます', start: 2.65, end: 3.4 },
  ],
};

function resetSay(): void {
  sayTranscript = '';
  sayOffline = false;
  sayResult = null;
}

const SIMULATIONS: Record<string, () => Promise<void> | void> = {
  ...TIER_UPS,
  ...TIERS,
  // My words page: a fresh account, and a mix of known and learning words.
  'words-empty': () => simWords('empty'),
  'words-mixed': () => simWords('mixed'),
  // --- transcript-review ---
  'transcripts-end': () => requestTranscriptEnd(),
  'transcripts-nowords': () => setTranscriptSim('nowords'),
  'transcripts-empty': () => setTranscriptSim('empty'),
  'transcripts-offline': () => setTranscriptSim('offline'),
  // The up moment on a rung reached again: the disc with "14 day milestone" on an account that owns face.streak_14, else the plain tile.
  'tier-rereach': () => {
    streak(14);
    pushStreakMoment({ kind: 'up', streak: 14, milestone: milestoneOf(14) });
  },
  // --- ai-guardrails --- the next build or import answers with the budget or kill-switch message.
  'ai-budget-reached': () => setDevApiBlock('daily_budget'),
  'ai-paused': () => setDevApiBlock('ai_paused'),
  // --- energy meter --- full 60, low 8, empty 0.
  'energy-full': () => setDevEnergy(60),
  'energy-low': () => setDevEnergy(8),
  'energy-empty': () => setDevEnergy(0),
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
  // launch-basics: beta gate overrides, in memory.
  'beta-on': () => setBetaOverride({ features: true }),
  'beta-off': () => setBetaOverride({ features: false }),
  'admin-on': () => setBetaOverride({ admin: true }),
  'admin-denied': () => setBetaOverride({ admin: true, denied: true }),
  // beta-gate: the people in the State table. beta-off above is the regular user.
  'admin-beta-off': () => setBetaOverride({ features: false, admin: true }),
  'admin-beta-on': () => setBetaOverride({ features: true, admin: true }),
  'friend-beta-on': () => setBetaOverride({ features: true, admin: false }),
  'ladder-fake-take': () => {
    fakeTake = 86;
  },
  'ladder-fake-take-90': () => {
    fakeTake = 95;
  },
  // focus-session: the mic route, the run's blind take, and a run that pauses itself.
  'ladder-speaker': () => {
    forcedRoute = 'speaker';
  },
  'ladder-headset': () => {
    forcedRoute = 'headset';
  },
  'ladder-final-on': () => {
    blindTakeSim = true;
  },
  'ladder-final-off': () => {
    blindTakeSim = false;
  },
  'ladder-paused': () => {
    autoPause = true;
  },
  // focus-stories: hands-free without Settings, no neighbours (the bounce), no translation (hold pauses only).
  'ladder-handsfree-off': () => {
    handsFreeSim = false;
  },
  'ladder-handsfree-on': () => {
    handsFreeSim = true;
  },
  'ladder-no-neighbours': () => {
    noNeighbours = true;
  },
  'ladder-no-translation': () => {
    noTranslation = true;
  },
  // say-it: the real translate and voice run on a canned transcript.
  'say-canned-sentence': () => {
    sayTranscript = 'היום מזג האוויר יפה, אז אלך לטייל.';
  },
  'say-canned-phrases': () => {
    sayTranscript = 'תן לי שלושה משפטים לחדר כושר';
  },
  'say-canned-story': () => {
    sayTranscript = 'קמתי מוקדם. שתיתי קפה. אחר כך הלכתי לעבודה.';
  },
  'say-unclear': () => {
    sayTranscript = 'אה... אממ';
  },
  'say-offline': () => {
    sayOffline = true;
  },
  // session-old-look: the say result frame on a canned line, and the island's Easy offer. The offer
  // fires on a 90+ Compare of a line not yet known (island/[id].tsx), so this is the 95 fake take.
  'record.sayResult': () => {
    sayResult = { id: 'dev-say', said: 'היום מזג האוויר יפה, אז אלך לטייל.', native: 'he', line: SAY_RESULT_LINE, count: 3 };
  },
  'ladder.easyOffer': () => {
    fakeTake = 95;
  },
  reset: () => {
    fakeTake = null;
    resetFocus();
    resetSay();
    setBetaOverride({});
    streak(null);
    repairPhases = [];
    wordsSim = null;
    setDevApiBlock(null);
    setDevEnergy(null);
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
  fakeTake = null;
  resetFocus();
  resetSay();
  setBetaOverride({});
  streak(null);
  repairPhases = [];
  wordsSim = null;
  resetTranscriptSim();
  setDevApiBlock(null);
  setDevEnergy(null);
  clearLevelUp();
  clearStreakMoment();
}
