// The ladder stage's shared tokens: the easing, inks, sizes and helpers that two
// or more of the stage's files read. A constant one file alone reads lives in that file.
// Split out of ladder-stage.tsx as a pure move, no behaviour change.
import { Easing } from 'react-native-reanimated';

/** The fixed slot under the sentence: the live meter or the score (empty through the count), never a height change. */
export const SCORE_H = 78;
export const SLOT_GAP = 16;
export const LINE_PT = 36;
// The sentence steps down from 36pt in 2pt steps to fit the body, never under 20pt (then it scrolls).
export const LINE_MIN = 20;
export const LINE_STEP = 2;
/** The sentence's side margin: its width is the window less 48. */
export const BODY_PAD_H = 24;
export const TRACK = 'rgba(236,232,244,0.14)';
export const EDGE = 'rgba(236,232,244,0.10)';
export const DIM = 'rgba(7,10,18,0.55)';
export const noop = () => {};
export const OUT = Easing.out(Easing.cubic);
// The gold of the XP toast (session-celebration.tsx), for the slot's "+N XP".
export const XP_GOLD = '#FFC857';
// The count-in (focus-controls mock, Round 2 D3): the sentence waits in this
// grey while a band of the step's colour sweeps it once, then lifts to its ink.
export const COUNT_GREY = '#3a3f52';
/** The Final take's blur (mock Round 3 B2) coming in at the count's end; the blur hook and the count-in both time by it. */
export const BLUR_MS = 700;
/** The plain (word-less) line's ink. */
export const PLAIN_INK = '#F5F5FA';
/** The band's three windows, one centre: share of the sentence width, opacity, and the near-white core. */
export const BAND: readonly { w: number; o: number; core: boolean }[] = [
  { w: 0.38, o: 0.3, core: false },
  { w: 0.22, o: 0.6, core: false },
  { w: 0.08, o: 1, core: true },
];
/** The chips' row (mock `.mini`): one chip's height and the room it takes above the hint. */
export const CHIPS_H = 28;

/** `hex` mixed `k` of the way with white: the band's near-white core. */
export function towardWhite(hex: string, k: number): string {
  const h = hex.replace('#', '');
  const ch = [0, 2, 4].map((i) => {
    const n = parseInt(h.slice(i, i + 2), 16);
    return Math.round((Number.isFinite(n) ? n : 255) * (1 - k) + 255 * k);
  });
  return `rgb(${ch[0]},${ch[1]},${ch[2]})`;
}

/**
 * The largest size, 36pt down to 20pt in 2pt steps, at which `chars`
 * characters are guessed to fit `w` by `h`. A first guess so the fit rarely
 * shows a step; the measured height has the last word.
 */
export function guessPt(chars: number, w: number, h: number): number {
  for (let pt = LINE_PT; pt > LINE_MIN; pt -= LINE_STEP) {
    // A glyph measures about 1.17x its size once the ruby word spacing is in (8 chars at 36pt ran 331px).
    const perRow = Math.max(1, Math.floor(w / (pt * 1.17)));
    const rows = Math.ceil(Math.max(chars, 1) / perRow);
    if (rows * pt * 1.6 <= h) return pt;
  }
  return LINE_MIN;
}
/** The count-in band's run as a share of the count (V2 Hairline, Sean 2026-11-05): it passes quicker, then settles before go. */
export const SWEEP_K = 0.65;
export const SWEEP_EASING = Easing.inOut(Easing.sin);
/** The room the sentence leaves under its slot for the stage stamp's stop button: the old 36pt hint reserve, the 72pt button and an 8pt gap. */
export const CUE_ROOM = 116;
