/**
 * Dev review tour: "Take me there" can set a scenario first. The streak is
 * faked in memory (practice.ts devStreak); coins and freezes are real on the
 * dev backend (POST /dev/coins, 404 in prod), so a test purchase goes through.
 * No fake practice. All of it is a no-op outside __DEV__.
 */

import { clearSessionLines, devGrantCoins, devTtsSim, linesSim, type CatchCollection, type Line, type NativeLanguage } from '@/lib/api';
import { setBetaOverride } from '@/lib/beta';
import { clearLevelUp, clearStreakMoment, MILESTONE_DAYS, milestoneOf, pushLevelUp, pushStreakMoment } from '@/lib/level-up-store';
import { setDevApiBlock } from '@/lib/dev-api-block';
import { setDevEnergy } from '@/lib/energy';
import { LANGUAGE_IDS } from '@/lib/languages';
import { requestTranscriptEnd, resetTranscriptSim, setTranscriptSim } from '@/lib/dev-transcripts';
import { setDevStreak } from '@/lib/practice';
import { applyProgress, catalogNow, progressNow } from '@/lib/progression';

// Home's list and due count, faked in memory (dev only). Home reads it each render.
export type HomeSim = 'empty' | 'due0' | 'due99';
let homeSim: HomeSim | null = null;
export function devHomeSim(): HomeSim | null {
  return __DEV__ ? homeSim : null;
}

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

// --- harmonize ---
// `harmonize.error`: the next My words or Leaderboard mount shows its error
// state once, so Retry can be tapped. Consumed on read; a kill clears it.
let harmonizeError = false;

/** True once after `harmonize.error` ran, then false until it runs again. */
export function devHarmonizeError(): boolean {
  if (!__DEV__ || !harmonizeError) return false;
  harmonizeError = false;
  return true;
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

// `ladder-scoring-hold` keeps the ladder score slot on the Scoring label, so the
// shimmer can be judged. In memory.
let scoringHold = false;

/** True while `ladder-scoring-hold` is on. */
export function devScoringHold(): boolean {
  return __DEV__ && scoringHold;
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

// --- stage-stamp ---
// The stamp's clocks slowed to judge the fall, the squash and the travel frame by frame.
let stampSlow = 1;

/** The factor every stamp duration is multiplied by (`ladder-stamp-slow` sets 4), 1 in a release build. */
export function devStampSlow(): number {
  return __DEV__ ? stampSlow : 1;
}

// --- bl106-countin ---
// The Listen count-in's clock slowed: the lead, the beats, the impact and the drops with them.
let countSlow = 1;

/** The factor the drops count-in is multiplied by (`ladder-count-slow` sets 4), 1 in a release build. */
export function devCountSlow(): number {
  return __DEV__ ? countSlow : 1;
}

// --- welcome-v6 ---
// The welcome hero's clock: slowed, sent down the Account path with a session, or in its reduced-motion pose.
let welcomeSlow = 1;
let welcomeForceAccount = false;
let welcomeReduced = false;

/** The factor the hero clock and the hand-off are divided by (`welcome.slow` sets 4), 1 in a release build. */
export function devWelcomeSlow(): number {
  return __DEV__ ? welcomeSlow : 1;
}

/** `welcome.handoff`: Get started leads to the Account step even with a session, so the pill ride can be seen signed in. */
export function devWelcomeForceAccount(): boolean {
  return __DEV__ && welcomeForceAccount;
}

/** `welcome.reduced`: the hero's reduced-motion pose and fades without touching the OS setting. */
export function devWelcomeReduced(): boolean {
  return __DEV__ && welcomeReduced;
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

// --- lang-core ---
// `lang-say-<code>`: the say result frame on a canned line in that language,
// the way `record.sayResult` does for Japanese. Hebrew and Arabic have no voice
// yet, so this is the only way to see their text on a phone.
const SAY_EN = 'The weather is nice today, so I will go for a walk.';
function sayLine(ja: string, romaji: string, words: { text: string; rt?: string }[]): Line {
  const step = 3.4 / words.length;
  return {
    idx: 0,
    ja,
    kana: '',
    romaji,
    en: SAY_EN,
    duration: 3.4,
    timeline: [],
    words: words.map((w, i) => ({
      text: w.text,
      start: Math.round(i * step * 100) / 100,
      end: Math.round((i + 1) * step * 100) / 100,
      ...(w.rt !== undefined ? { ruby: [{ text: w.text, rt: w.rt }] } : {}),
    })),
  };
}
const LANG_SAY_LINES: Record<string, Line> = {
  zh: sayLine('今天天气很好，所以我去散步。', 'jīntiān tiānqì hěn hǎo, suǒyǐ wǒ qù sànbù.', [
    { text: '今天', rt: 'jīntiān' },
    { text: '天气', rt: 'tiānqì' },
    { text: '很', rt: 'hěn' },
    { text: '好', rt: 'hǎo' },
    { text: '，', rt: '' },
    { text: '所以', rt: 'suǒyǐ' },
    { text: '我', rt: 'wǒ' },
    { text: '去', rt: 'qù' },
    { text: '散步', rt: 'sànbù' },
    { text: '。', rt: '' },
  ]),
  ko: sayLine('오늘은 날씨가 좋아서 산책하러 가요.', 'oneureun nalssiga joaseo sanchaekhareo gayo.', [
    { text: '오늘은' },
    { text: '날씨가' },
    { text: '좋아서' },
    { text: '산책하러' },
    { text: '가요.' },
  ]),
  he: sayLine('היום מזג האוויר יפה, אז אני הולך לטייל.', 'haYOM MEzeg haaVIR yaFE, az aNI hoLEKH letaYEL.', [
    { text: 'היום' },
    { text: 'מזג' },
    { text: 'האוויר' },
    { text: 'יפה,' },
    { text: 'אז' },
    { text: 'אני' },
    { text: 'הולך' },
    { text: 'לטייל.' },
  ]),
  ar: sayLine('الطَّقْسُ جَمِيلٌ الْيَوْمَ، لِذَلِكَ سَأَذْهَبُ فِي نُزْهَةٍ.', 'aṭ-ṭaqsu jamīlun al-yawma, li-dhālika sa-adhhabu fī nuzhatin.', [
    { text: 'الطَّقْسُ' },
    { text: 'جَمِيلٌ' },
    { text: 'الْيَوْمَ،' },
    { text: 'لِذَلِكَ' },
    { text: 'سَأَذْهَبُ' },
    { text: 'فِي' },
    { text: 'نُزْهَةٍ.' },
  ]),
};
const LANG_SAYS = Object.fromEntries(
  Object.entries(LANG_SAY_LINES).map(([code, line]) => [
    `lang-say-${code}`,
    () => {
      sayResult = { id: 'dev-say', said: SAY_EN, native: 'en', line, count: 3 };
    },
  ]),
);

const SIMULATIONS: Record<string, () => Promise<void> | void> = {
  ...TIER_UPS,
  ...TIERS,
  // Practice now: 8 islands (scroll and fades), a 2 s lines fetch (loading state), a failing one (retry line).
  sessionManyIslands: () => {
    linesSim.many = true;
  },
  sessionLinesSlow: () => {
    linesSim.slow = true;
    clearSessionLines();
  },
  sessionLinesFail: () => {
    linesSim.fail = true;
    clearSessionLines();
  },
  // Island peek: every island lists 20 lines, so the card scrolls and its edges fade.
  peekLongList: () => {
    linesSim.long = true;
    clearSessionLines();
  },
  // My words page: a fresh account, and a mix of known and learning words.
  'words-empty': () => simWords('empty'),
  'words-mixed': () => simWords('mixed'),
  'harmonize.error': () => {
    harmonizeError = true;
  },
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
  // lang-core: every catalogue language under "Ready to learn" (picker and settings only; the backend still gates).
  'lang-all': () => setBetaOverride({ languages: LANGUAGE_IDS.map((id) => ({ id, speaker: 10001 })) }),
  ...LANG_SAYS,
  // The route guard's refusal on the next build: the create error copy with Retry.
  'lang-unavailable': () => setDevApiBlock('language_unavailable'),
  // --- home dock and chips --- no islands and no due, 0 due, 99 due (width check).
  'home-empty': () => {
    homeSim = 'empty';
  },
  'home-due-0': () => {
    homeSim = 'due0';
  },
  'home-due-many': () => {
    homeSim = 'due99';
  },
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
  // admin-device-bound: the Admin screen's phone-key states, without a request.
  'admin-device-pending': () => setBetaOverride({ admin: true, device: 'pending' }),
  'admin-device-revoked': () => setBetaOverride({ admin: true, device: 'revoked' }),
  'admin-device-rejected': () => setBetaOverride({ admin: true, device: 'rejected' }),
  'admin-device-unsupported': () => setBetaOverride({ admin: true, device: 'unsupported' }),
  'ladder-fake-take': () => {
    fakeTake = 86;
  },
  'ladder-scoring-hold': () => {
    scoringHold = true;
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
  // stage-stamp: every stamp clock 4x slower (the fall, the squash, the rings, the travel).
  'ladder-stamp-slow': () => {
    stampSlow = 4;
  },
  // bl106-countin: the drops' clock and the hook's lead, beats and impact 4x slower, and the stamp's clocks with them.
  'ladder-count-slow': () => {
    countSlow = 4;
    stampSlow = 4;
  },
  // welcome-v6: the Account step follows Get started even with a session (a fresh /onboarding mount replays the welcome).
  'welcome.handoff': () => {
    welcomeForceAccount = true;
  },
  // welcome-v6: the hero clock and the hand-off at 1/4 speed.
  'welcome.slow': () => {
    welcomeSlow = 4;
  },
  // welcome-v6: the reduced-motion pose and fades without the OS setting.
  'welcome.reduced': () => {
    welcomeReduced = true;
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
  // session-old-look: the say result frame on a canned line.
  'record.sayResult': () => {
    sayResult = { id: 'dev-say', said: 'היום מזג האוויר יפה, אז אלך לטייל.', native: 'he', line: SAY_RESULT_LINE, count: 3 };
  },
  // --- tts-providers --- the dev backend's hosted-voice switch: every hosted
  // render over budget (free voice fills in, reason budget), every provider
  // raising (reason error), or every hosted provider disabled (local cards only).
  'voice-budget-out': () => devTtsSim('budget_out'),
  'voice-provider-down': () => devTtsSim('provider_down'),
  'voice-hosted-off': () => devTtsSim('hosted_off'),
  reset: () => {
    fakeTake = null;
    resetFocus();
    resetSay();
    stampSlow = 1;
    countSlow = 1;
    welcomeSlow = 1;
    welcomeForceAccount = false;
    welcomeReduced = false;
    setBetaOverride({});
    streak(null);
    homeSim = null;
    repairPhases = [];
    wordsSim = null;
    setDevApiBlock(null);
    setDevEnergy(null);
    clearLevelUp();
    clearStreakMoment();
    resetTtsSim();
  },
};

/** Clears the dev backend's hosted-voice switch; a prod backend answers 404,
 * which is the same as cleared. */
function resetTtsSim(): void {
  void devTtsSim('').catch(() => undefined);
}

export async function runSimulation(key: string): Promise<void> {
  if (!__DEV__) return;
  await SIMULATIONS[key]?.();
}

export function resetSimulation(): void {
  if (!__DEV__) return;
  fakeTake = null;
  scoringHold = false;
  resetFocus();
  resetSay();
  stampSlow = 1;
  countSlow = 1;
  welcomeSlow = 1;
  welcomeForceAccount = false;
  welcomeReduced = false;
  setBetaOverride({});
  streak(null);
  repairPhases = [];
  wordsSim = null;
  harmonizeError = false;
  linesSim.many = linesSim.slow = linesSim.fail = linesSim.long = false;
  clearSessionLines();
  resetTranscriptSim();
  setDevApiBlock(null);
  setDevEnergy(null);
  resetTtsSim();
  clearLevelUp();
  clearStreakMoment();
}
