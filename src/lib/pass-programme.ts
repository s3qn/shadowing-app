/**
 * The player's step machine, factored out of `src/app/island/[id].tsx` so the
 * step vocabulary and every "what happens next" rule live in one pure place:
 * the five-pass ladder (Listen, Memorise, Say, Record, Compare, once per
 * line). No React, no storage, no timers: every export here is a plain
 * function or constant over its arguments.
 */

import type { SheetIcon } from '@/components/sheet/sheet-rows';
import { tide, verb } from '@/constants/theme';
import type { Key } from '@/locales/en';

/**
 * Every step the ladder can be in. `idle` is before Start and `done` is after
 * the run ends. The `ladder*` steps are one per pass except Record
 * (`ladderArmed` while waiting on a manual Record, `ladderRecord` while
 * recording) and Compare (`ladderCompare` plays the line, `ladderPlay` plays
 * the take back), which each share one segment bar.
 */
export type PassStep =
  | 'idle'
  | 'done'
  | 'ladderListen'
  | 'ladderMemorise'
  | 'ladderSay'
  | 'ladderArmed'
  | 'ladderRecord'
  | 'ladderCompare'
  | 'ladderPlay';

/** What the active segment's fill animates against. */
export type FillKind = 'line' | 'record' | 'take' | 'none';

/**
 * The five ladder passes in order: the pass's title, its one-line
 * description for the ladder overview, its icon and its colour.
 * `pass-step.tsx`'s onboarding screens spread these same entries, so the
 * onboarding and the live sheet cannot drift apart.
 */
export const LADDER_PASSES: readonly { titleKey: Key; lineKey: Key; icon: SheetIcon; colour: string }[] = [
  {
    titleKey: 'settings.onboarding.passListenTitle',
    lineKey: 'settings.onboarding.ladderListen',
    icon: { ios: 'ear', android: 'hearing' },
    colour: verb.listen.c1,
  },
  {
    titleKey: 'settings.onboarding.passMemoriseTitle',
    lineKey: 'settings.onboarding.ladderMemorise',
    icon: { ios: 'brain.head.profile', android: 'psychology' },
    colour: verb.read.c1,
  },
  {
    titleKey: 'settings.onboarding.passSayTitle',
    lineKey: 'settings.onboarding.ladderSay',
    icon: { ios: 'mouth', android: 'record_voice_over' },
    colour: verb.speak.c2,
  },
  {
    titleKey: 'settings.onboarding.passRecordTitle',
    lineKey: 'settings.onboarding.ladderRecord',
    icon: { ios: 'mic', android: 'mic' },
    colour: verb.speak.c1,
  },
  {
    titleKey: 'settings.onboarding.passCompareTitle',
    lineKey: 'settings.onboarding.ladderCompare',
    icon: { ios: 'arrow.left.and.right', android: 'compare_arrows' },
    colour: tide.pos.verb,
  },
] as const;

/**
 * The hint line for a step: the line the onboarding already taught for that
 * pass, so the sheet says exactly what the tutorial promised.
 */
export function hintKeyOf(step: PassStep): Key {
  switch (step) {
    case 'idle':
      return 'player.stepReady';
    case 'done':
      return 'player.ladderDone';
    case 'ladderListen':
      return 'settings.onboarding.passListenLine';
    case 'ladderMemorise':
      return 'settings.onboarding.passMemoriseLine';
    case 'ladderSay':
      return 'settings.onboarding.passSayLine';
    case 'ladderArmed':
    case 'ladderRecord':
      return 'settings.onboarding.passRecordLine';
    case 'ladderCompare':
    case 'ladderPlay':
      return 'settings.onboarding.passCompareLine';
  }
}

/**
 * Which pass's explanation the practice sheet's help should show for a step,
 * 0 based over the five ladder passes. `idle` and `done` return Listen, the
 * pass Start (or Start again) begins with.
 */
export function helpPassOf(step: PassStep): 0 | 1 | 2 | 3 | 4 {
  switch (step) {
    case 'ladderMemorise':
      return 1;
    case 'ladderSay':
      return 2;
    case 'ladderArmed':
    case 'ladderRecord':
      return 3;
    case 'ladderCompare':
    case 'ladderPlay':
      return 4;
    case 'ladderListen':
    case 'idle':
    case 'done':
      return 0;
  }
}

/**
 * What the active segment's fill animates against: a `line`'s own playback
 * position, a `record`ing in progress, or a saved `take` playing back.
 * `none` for the steps with nothing to time a fill against (idle, armed,
 * done).
 */
export function fillKindOf(step: PassStep): FillKind {
  switch (step) {
    case 'ladderListen':
    case 'ladderMemorise':
    case 'ladderSay':
    case 'ladderCompare':
      return 'line';
    case 'ladderRecord':
      return 'record';
    case 'ladderPlay':
      return 'take';
    default:
      return 'none';
  }
}

/**
 * Whether the sentence area and the waterline should show the text: a fixed
 * `true`/`false` during a run, which overrides Blind step by step, and `null`
 * before Start, where the Blind setting alone decides. The text stays in
 * view through every stage, the recorded take included; only the blind take
 * after it (`finalTake`, run when `blindTake` is on) hides it.
 */
export function textShownAt(step: PassStep, blindTake: boolean, finalTake = false): boolean | null {
  switch (step) {
    case 'ladderArmed':
    case 'ladderRecord':
      return !(blindTake && finalTake);
    case 'ladderListen':
    case 'ladderMemorise':
    case 'ladderSay':
    case 'ladderCompare':
    case 'ladderPlay':
    case 'done':
      return true;
    default:
      return null;
  }
}

/**
 * The step a tap on mark `index` (0 based) jumps to. The listening passes
 * return their own step; Record returns the armed step (the screen counts in
 * from it); Compare returns its line half when a take is ready, and the armed
 * step when there is none.
 */
export function stepOfPass(index: number, hasTake: boolean): PassStep {
  const steps: PassStep[] = [
    'ladderListen',
    'ladderMemorise',
    'ladderSay',
    'ladderArmed',
    hasTake ? 'ladderCompare' : 'ladderArmed',
  ];
  return steps[Math.min(Math.max(index, 0), 4)]!;
}

/**
 * The count that runs before a stage: three beats, 600ms each unless the
 * ladder's pace sets its own beat. Shared by the screen, which runs the
 * beats, and by the dock, which pulses one ring per beat.
 */
export const COUNT_IN_BEATS = 3;
export const COUNT_IN_BEAT_MS = 600;

/** True while a take is being recorded. */
export function isSpeakStep(step: PassStep): boolean {
  return step === 'ladderRecord';
}

/** True while the sheet is waiting for a manual tap on Record (Auto Record off). */
export function isArmedStep(step: PassStep): boolean {
  return step === 'ladderArmed';
}

/** True while a saved take is playing back. */
export function isPlayStep(step: PassStep): boolean {
  return step === 'ladderPlay';
}

/** False only before Start and after the run ends: every other step is a
 * run in progress. */
export function isActive(step: PassStep): boolean {
  return step !== 'idle' && step !== 'done';
}

/**
 * The step a line's finish (its pad included) moves to. Listen and Memorise
 * move on to the next listening pass; Say hands off to Record, armed if Auto
 * Record is off or straight into the recording if it is on; Compare's line
 * half hands off to its take half. Any other step is not a line-finish step
 * and is returned unchanged.
 */
export function nextOnLineFinish(step: PassStep, autoRecord: boolean): PassStep {
  switch (step) {
    case 'ladderListen':
      return 'ladderMemorise';
    case 'ladderMemorise':
      return 'ladderSay';
    case 'ladderSay':
      return autoRecord ? 'ladderRecord' : 'ladderArmed';
    case 'ladderCompare':
      return 'ladderPlay';
    default:
      return step;
  }
}

/**
 * The step a saved take moves to: Record hands off to Compare. Any other
 * step is returned unchanged.
 */
export function afterTakeSaved(step: PassStep): PassStep {
  if (step === 'ladderRecord') return 'ladderCompare';
  return step;
}

/**
 * The step a played-back take moves to: `more` is whether there is a line
 * left to run (the "go on to the next line" toggle, off past the island's
 * last line). `false` ends the run. Any other step is returned unchanged.
 */
export function afterTakePlayed(step: PassStep, more: boolean): PassStep {
  if (step === 'ladderPlay') return more ? 'ladderListen' : 'done';
  return step;
}

/** How fast the ladder paces itself. */
export const LADDER_PACE_OPTIONS = ['calm', 'steady', 'quick'] as const;
export type LadderPace = (typeof LADDER_PACE_OPTIONS)[number];

/**
 * Per pace: how long a stage announces itself, one count beat, the gap
 * between repeats, and how many times Memorise and Say play.
 */
export const LADDER_PACING: Record<
  LadderPace,
  { announceMs: number; beatMs: number; gapMs: number; memorise: number; say: number }
> = {
  calm: { announceMs: 1200, beatMs: 800, gapMs: 700, memorise: 2, say: 2 },
  steady: { announceMs: 800, beatMs: 600, gapMs: 500, memorise: 2, say: 1 },
  quick: { announceMs: 400, beatMs: 450, gapMs: 300, memorise: 1, say: 1 },
};

/** What comes before a stage runs (or between its repeats). */
export type Prelude = { phase: 'announce' } | { phase: 'count'; beat: number } | { phase: 'gap' } | null;

/** Whether a stage announces and counts in before it runs. Compare does not: it plays the line, then the take, straight away. */
export function hasPrelude(step: PassStep): boolean {
  return step !== 'ladderCompare';
}

export type LadderStage = 'listen' | 'memorise' | 'say' | 'record' | 'compare';

/** The five stages in run order. */
export const LADDER_STAGE_ORDER: readonly LadderStage[] = ['listen', 'memorise', 'say', 'record', 'compare'];

/** The stage a ladder step belongs to, or null for any other step. */
export function stageOf(step: PassStep): LadderStage | null {
  switch (step) {
    case 'ladderListen':
      return 'listen';
    case 'ladderMemorise':
      return 'memorise';
    case 'ladderSay':
      return 'say';
    case 'ladderArmed':
    case 'ladderRecord':
      return 'record';
    case 'ladderCompare':
    case 'ladderPlay':
      return 'compare';
    default:
      return null;
  }
}

/** How many times a step's line plays in a row: Memorise and Say follow the
 * pace, every other step plays once. */
export function repeatsOf(step: PassStep, pace: LadderPace): number {
  if (step === 'ladderMemorise') return LADDER_PACING[pace].memorise;
  if (step === 'ladderSay') return LADDER_PACING[pace].say;
  return 1;
}

/**
 * What the ladder does when a line finishes playing: play it again while
 * `repeat` (1 based) is under the step's repeats, otherwise wrap
 * `nextOnLineFinish`.
 */
export function onLadderLineFinish(
  step: PassStep,
  repeat: number,
  autoRecord: boolean,
  pace: LadderPace,
): { kind: 'repeat' } | { kind: 'next'; step: PassStep } {
  if (repeat < repeatsOf(step, pace)) return { kind: 'repeat' };
  return { kind: 'next', step: nextOnLineFinish(step, autoRecord) };
}
