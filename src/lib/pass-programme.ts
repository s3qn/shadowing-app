/**
 * The player's step machine, factored out of `src/app/island/[id].tsx` so the
 * step vocabulary and every "what happens next" rule live in one pure place.
 * Two programmes share it: Auto Echo (Listen, Echo, Speak, Play, wrapping
 * forever) and the five-pass ladder (Listen, Mumble, Read along, Shadow,
 * Compare, once per line, no wrap). No React, no storage, no timers: every
 * export here is a plain function or constant over its arguments.
 */

import type { SheetIcon } from '@/components/sheet/sheet-rows';
import { SPEED_MIN, tide, verb } from '@/constants/theme';
import type { Key } from '@/locales/en';

/** One programme the player's record button can run. */
export type Programme = 'echo' | 'ladder';

/**
 * Every step either programme's step machine can be in. `idle` is before
 * Start and `done` is after the run ends, both shared by the two programmes
 * and outside the segment row. The unprefixed five (`listen`, `echo`,
 * `armed`, `speak`, `play`) belong to Auto Echo; the `ladder*` steps belong
 * to the five-pass ladder, one per pass except Shadow (`ladderArmed` while
 * waiting on a manual Record, `ladderShadow` while recording) and Compare
 * (`ladderCompare` plays the line, `ladderPlay` plays the take back), which
 * each share one segment bar.
 */
export type PassStep =
  | 'idle'
  | 'done'
  | 'listen'
  | 'echo'
  | 'armed'
  | 'speak'
  | 'play'
  | 'ladderListen'
  | 'ladderMumble'
  | 'ladderRead'
  | 'ladderArmed'
  | 'ladderShadow'
  | 'ladderCompare'
  | 'ladderPlay';

/** Old name for `PassStep`, kept so files that have not moved to the ladder
 * yet still compile against the same type. */
export type EchoStep = PassStep;

/** What the active segment's fill animates against. */
export type FillKind = 'line' | 'pad' | 'record' | 'take' | 'none';

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
    titleKey: 'settings.onboarding.passMumbleTitle',
    lineKey: 'settings.onboarding.ladderMumble',
    icon: { ios: 'mouth', android: 'record_voice_over' },
    colour: verb.speak.c2,
  },
  {
    titleKey: 'settings.onboarding.passReadTitle',
    lineKey: 'settings.onboarding.ladderRead',
    icon: { ios: 'book', android: 'menu_book' },
    colour: verb.read.c1,
  },
  {
    titleKey: 'settings.onboarding.passShadowTitle',
    lineKey: 'settings.onboarding.ladderShadow',
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

// Auto Echo's four bars all fill in the same tide blue, as they always have.
const ECHO_SEGMENTS: readonly { labelKey: Key; colour: string }[] = [
  { labelKey: 'player.segmentListen', colour: tide.lang.ja },
  { labelKey: 'player.segmentEcho', colour: tide.lang.ja },
  { labelKey: 'player.segmentSpeak', colour: tide.lang.ja },
  { labelKey: 'player.play', colour: tide.lang.ja },
];

/**
 * The segment row for a programme: one bar per pass, in order, with the
 * label key the bar shows and the colour it fills in. Four bars for Auto
 * Echo, five for the ladder (each in its own pass colour).
 */
export function segmentsOf(programme: Programme): readonly { labelKey: Key; colour: string }[] {
  if (programme === 'echo') return ECHO_SEGMENTS;
  return LADDER_PASSES.map((pass) => ({ labelKey: pass.titleKey, colour: pass.colour }));
}

/**
 * Which segment bar (0 based) a step lights up: -1 before Start, one past
 * the last bar once the run is `done` (every bar reads as finished). Armed
 * shares its pass's own recording step (Speak and Shadow); Compare's take
 * half (`ladderPlay`) shares `ladderCompare`'s bar. `programme` only matters
 * for `idle` and `done`, the two steps both programmes pass through; every
 * other step names its programme in its own literal.
 */
export function segmentIndexOf(step: PassStep, programme: Programme): number {
  if (step === 'idle') return -1;
  if (step === 'done') return segmentsOf(programme).length;
  switch (step) {
    case 'listen':
      return 0;
    case 'echo':
      return 1;
    case 'armed':
    case 'speak':
      return 2;
    case 'play':
      return 3;
    case 'ladderListen':
      return 0;
    case 'ladderMumble':
      return 1;
    case 'ladderRead':
      return 2;
    case 'ladderArmed':
    case 'ladderShadow':
      return 3;
    case 'ladderCompare':
    case 'ladderPlay':
      return 4;
  }
}

/**
 * The hint line under the segment row for a step: Auto Echo keeps its own
 * short instructions; the ladder reuses the longer line the onboarding
 * already taught for that pass, so the sheet says exactly what the
 * tutorial promised. `programme` disambiguates `idle` and `done`.
 */
export function hintKeyOf(step: PassStep, programme: Programme): Key {
  switch (step) {
    case 'idle':
      return 'player.stepReady';
    case 'done':
      return programme === 'ladder' ? 'player.ladderDone' : 'player.stepDone';
    case 'listen':
      return 'player.stepListen';
    case 'echo':
      return 'player.stepEcho';
    case 'armed':
    case 'speak':
      return 'player.stepSpeak';
    case 'play':
      return 'player.stepPlay';
    case 'ladderListen':
      return 'settings.onboarding.passListenLine';
    case 'ladderMumble':
      return 'settings.onboarding.passMumbleLine';
    case 'ladderRead':
      return 'settings.onboarding.passReadLine';
    case 'ladderArmed':
    case 'ladderShadow':
      return 'settings.onboarding.passShadowLine';
    case 'ladderCompare':
    case 'ladderPlay':
      return 'settings.onboarding.passCompareLine';
  }
}

/**
 * Which pass's explanation the practice sheet's help should show for a step,
 * 0 based over the five ladder passes, or `null` where there is nothing to
 * show. Auto Echo returns `null` at every step: the onboarding only teaches
 * the ladder, so its four steps have no explanation to open. The ladder's
 * `idle` and `done` return Listen, the pass Start (or Start again) begins
 * with.
 */
export function helpPassOf(step: PassStep, programme: Programme): 0 | 1 | 2 | 3 | 4 | null {
  if (programme === 'echo') return null;
  switch (step) {
    case 'ladderMumble':
      return 1;
    case 'ladderRead':
      return 2;
    case 'ladderArmed':
    case 'ladderShadow':
      return 3;
    case 'ladderCompare':
    case 'ladderPlay':
      return 4;
    case 'ladderListen':
    case 'idle':
    case 'done':
      return 0;
    default:
      return null;
  }
}

/**
 * What the active segment's fill animates against: a `line`'s own playback
 * position, the `pad` (the post-line silence Echo listens through), a
 * `record`ing in progress, or a saved `take` playing back. `none` for the
 * steps with nothing to time a fill against (idle, armed and its ladder
 * twin, done).
 */
export function fillKindOf(step: PassStep): FillKind {
  switch (step) {
    case 'listen':
    case 'ladderListen':
    case 'ladderMumble':
    case 'ladderRead':
    case 'ladderCompare':
      return 'line';
    case 'echo':
      return 'pad';
    case 'speak':
    case 'ladderShadow':
      return 'record';
    case 'play':
    case 'ladderPlay':
      return 'take';
    default:
      return 'none';
  }
}

/**
 * Whether the sentence area and the waterline should show the text: `null`
 * for every Auto Echo step, where the Blind setting alone decides as it
 * always has; a fixed `true`/`false` for the ladder's passes, which
 * override Blind pass by pass (hidden through Listen, Mumble, Shadow and
 * its armed wait; shown for Read along, Compare, its take half, and the
 * finished ladder). `programme` disambiguates `idle` and `done`.
 */
export function textShownAt(step: PassStep, programme: Programme): boolean | null {
  if (programme === 'echo') return null;
  switch (step) {
    case 'ladderListen':
    case 'ladderMumble':
    case 'ladderShadow':
    case 'ladderArmed':
      return false;
    case 'ladderRead':
    case 'ladderCompare':
    case 'ladderPlay':
    case 'done':
      return true;
    default:
      return null;
  }
}

/** The step Shadow/Speak runs as, for the given programme. */
export function speakStepOf(programme: Programme): PassStep {
  return programme === 'ladder' ? 'ladderShadow' : 'speak';
}

/** True while a take is being recorded, in either programme. */
export function isSpeakStep(step: PassStep): boolean {
  return step === 'speak' || step === 'ladderShadow';
}

/** True while the sheet is waiting for a manual tap on Record (Auto Record
 * off), in either programme. */
export function isArmedStep(step: PassStep): boolean {
  return step === 'armed' || step === 'ladderArmed';
}

/** True while a saved take is playing back, in either programme. */
export function isPlayStep(step: PassStep): boolean {
  return step === 'play' || step === 'ladderPlay';
}

/** False only before Start and after the run ends: every other step is a
 * run in progress. */
export function isActive(step: PassStep): boolean {
  return step !== 'idle' && step !== 'done';
}

/**
 * Which programme a step belongs to, read from its own name: every ladder
 * step is prefixed `ladder`. `idle` and `done`, shared by both programmes,
 * read as `'echo'`; a caller that needs the true programme for those two
 * (the player is not mid-pass then) tracks it separately.
 */
export function programmeOf(step: PassStep): Programme {
  return step.startsWith('ladder') ? 'ladder' : 'echo';
}

/**
 * A pass's playback speed, relative to `base` (the island's rung as the
 * line started, i.e. `speed-ladder.ts`'s speed): Listen and Mumble play
 * 0.15 under it, clamped to `SPEED_MIN`; every other ladder pass, and every
 * Auto Echo step, plays at `base` itself. The session never writes the
 * rung: this only reads it.
 */
export function passSpeed(base: number, step: PassStep): number {
  if (step === 'ladderListen' || step === 'ladderMumble') {
    return Math.max(SPEED_MIN, Math.round((base - 0.15) * 100) / 100);
  }
  return base;
}

/**
 * The step a line's finish (its pad included) moves to. Listen and Echo
 * (Auto Echo) and Read along (the ladder) hand off to Speak/Shadow, armed
 * if Auto Record is off or straight into the recording if it is on;
 * Listen and Mumble in the ladder simply move on to the next line pass;
 * Compare's line half hands off to its take half. Any other step is not a
 * line-finish step and is returned unchanged.
 */
export function nextOnLineFinish(step: PassStep, autoRecord: boolean): PassStep {
  switch (step) {
    case 'listen':
    case 'echo':
      return autoRecord ? 'speak' : 'armed';
    case 'ladderListen':
      return 'ladderMumble';
    case 'ladderMumble':
      return 'ladderRead';
    case 'ladderRead':
      return autoRecord ? 'ladderShadow' : 'ladderArmed';
    case 'ladderCompare':
      return 'ladderPlay';
    default:
      return step;
  }
}

/**
 * The step a saved take moves to: Speak hands off to Play, Shadow to
 * Compare's take half. Any other step is returned unchanged.
 */
export function afterTakeSaved(step: PassStep): PassStep {
  if (step === 'speak') return 'play';
  if (step === 'ladderShadow') return 'ladderCompare';
  return step;
}

/**
 * The step a played-back take moves to: `more` is whether there is a line
 * left to run (Auto Echo's "go on to the next line" toggle, on and
 * wrapping past the last line; the ladder's same toggle, off past the
 * island's last line). `false` ends the run. Any other step is returned
 * unchanged.
 */
export function afterTakePlayed(step: PassStep, more: boolean): PassStep {
  if (step === 'play') return more ? 'listen' : 'done';
  if (step === 'ladderPlay') return more ? 'ladderListen' : 'done';
  return step;
}
