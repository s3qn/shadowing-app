// The ladder stage's model: the frames, the Stories bar's steps with their looks,
// and the speed chip's cycle. Pure data and functions, no React.
// Split out of ladder-stage.tsx as a pure move, no behaviour change.
import { verb } from '@/constants/theme';
import type { LadderStageProps } from '@/hooks/ladder/ladder-types';
import type { useT } from '@/lib/i18n';

export type Frame = 'listen' | 'memorise' | 'say' | 'ready' | 'recording' | 'final' | 'compare';
type TKey = Parameters<ReturnType<typeof useT>['t']>[0];

/** A tile's look from the mock: its tint and the 145deg gradient's two alphas and rim. */
export type Look = { tint: string; from: number; to: number; rim: number; glow?: boolean };
export const LISTEN: Look = { tint: verb.listen.c1, from: 0.38, to: 0.12, rim: 0.5 };
export const MUMBLE: Look = { tint: verb.mumble.c1, from: 0.38, to: 0.12, rim: 0.5 };
export const ALONG: Look = { tint: verb.along.c1, from: 0.38, to: 0.12, rim: 0.5 };
export const READY: Look = { tint: verb.listen.c2, from: 0.38, to: 0.12, rim: 0.5 };
export const REC: Look = { tint: verb.speak.c1, from: 0.55, to: 0.2, rim: 0.8, glow: true };
export const FIN: Look = { tint: verb.tools.c1, from: 0.28, to: 0.08, rim: 0.45 };

/** The bar's steps in order; the Final take segment is there only while `finalOn`. */
export const STEPS: readonly { look: Look; name: TKey }[] = [
  { look: LISTEN, name: 'settings.onboarding.passListenTitle' },
  { look: MUMBLE, name: 'settings.onboarding.passMemoriseTitle' },
  { look: ALONG, name: 'settings.onboarding.passSayTitle' },
  { look: REC, name: 'ladder.recordingTitle' },
  { look: FIN, name: 'ladder.finalTitle' },
  { look: READY, name: 'settings.onboarding.passCompareTitle' },
];
export const FINAL = 4;
export const COMPARE = 5;

export function frameOf(p: LadderStageProps): Frame {
  if (p.stage === 'listen') return 'listen';
  if (p.stage === 'memorise') return 'memorise';
  if (p.stage === 'say') return 'say';
  if (p.stage === 'compare') return 'compare';
  if (p.isRecording) return 'recording';
  return p.round === 2 ? 'final' : 'ready';
}

/** The STEPS index a frame lights: the Shadow count and take share one, round 2 is the Final take. */
export function stepOf(p: LadderStageProps, frame: Frame): number {
  switch (frame) {
    case 'listen':
      return 0;
    case 'memorise':
      return 1;
    case 'say':
      return 2;
    case 'ready':
      return 3;
    case 'recording':
      return p.round === 2 ? FINAL : 3;
    case 'final':
      return FINAL;
    case 'compare':
      return COMPARE;
  }
}

/** A tap on a segment, or a swipe landing on it: that step on this line. */
export function jumpStep(onJump: (i: number) => void, onFinal: (() => void) | undefined, s: number): void {
  if (s === FINAL) (onFinal ?? (() => onJump(3)))();
  else if (s === COMPARE) onJump(4);
  else onJump(s);
}

/** The speed chip's cycle; the island fetches the line on screen at each of these ahead of a tap. */
export const STAGE_SPEEDS = [0.75, 1, 1.25] as const;
const SPEED_CYCLE = STAGE_SPEEDS;

/** The next speed of the chip's cycle, from the cycle's speed nearest to `v`. */
export function nextSpeed(v: number): number {
  let at = 0;
  SPEED_CYCLE.forEach((s, i) => {
    if (Math.abs(s - v) < Math.abs(SPEED_CYCLE[at]! - v)) at = i;
  });
  return SPEED_CYCLE[(at + 1) % SPEED_CYCLE.length]!;
}
