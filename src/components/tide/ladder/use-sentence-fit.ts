// The sentence's fit pass: the size, 36pt down to 20pt in 2pt steps, at which the line
// fits its room, from a first guess, the measured height and the widest unit's width.
// A size once fitted is kept per line and room, so the same line in the same room (the
// cube's still preview, then the stage after the hop) opens at it in one pass, shown.
import { useState } from 'react';

import { guessPt, LINE_MIN, LINE_PT, LINE_STEP } from '@/components/tide/ladder/stage-tokens';

/** The sentence's fit pass: its line, size, and the measured text height once done. */
export type Fit = { key: string; lineKey: string; mount: string; pt: number; done: boolean; shown: boolean; h: number };

/** Fitted sizes by line and room (`key|innerW`), the newest last. */
const fitted = new Map<string, number>();
const MAX_FITTED = 200;
function keep(room: string, pt: number) {
  fitted.delete(room);
  fitted.set(room, pt);
  if (fitted.size > MAX_FITTED) {
    const oldest = fitted.keys().next().value;
    if (oldest !== undefined) fitted.delete(oldest);
  }
}

/** The next size to try after `pt` measured `h` in `maxH`: the height grows about with the size squared. */
function stepDown(pt: number, h: number, maxH: number): number {
  const est = h > 0 && maxH > 2 ? Math.ceil((pt * Math.sqrt((maxH - 2) / h)) / LINE_STEP) * LINE_STEP : pt - LINE_STEP;
  const next = Number.isFinite(est) ? Math.min(pt - LINE_STEP, est) : pt - LINE_STEP;
  return Math.max(LINE_MIN, next);
}

/**
 * The fit for `lineKey` (the line's index and text) with `chars` characters in `innerW` by
 * `maxH`: the current pass, and the two layout reports that step the size down.
 */
export function useSentenceFit({ lineKey, chars, innerW, maxH }: { lineKey: string; chars: number; innerW: number; maxH: number }) {
  // The fit restarts for each line from the size it fitted at before in this room, shown at once,
  // or from the guess, the text hidden until the measured height fits (or reaches 20pt).
  // `mount` remounts the text per pass.
  const key = `${lineKey}|${Math.round(maxH)}`;
  const room = `${key}|${Math.round(innerW)}`;
  const start = (shown = false, from = LINE_PT): Fit => {
    const known = fitted.get(room);
    if (known !== undefined && known <= from) return { key, lineKey, mount: key, pt: known, done: false, shown: true, h: 0 };
    return { key, lineKey, mount: key, pt: Math.min(from, guessPt(chars, innerW, maxH)), done: false, shown, h: 0 };
  };
  // The same line's room changing keeps a fitted size that still fits and never
  // grows it mid-line; a size that no longer fits steps down with the text shown.
  const regap = (f: Fit): Fit => {
    if (f.lineKey !== lineKey || !f.done) return start();
    if (f.h > 0 && f.h + 2 > maxH) return start(true, f.pt);
    return { ...f, key };
  };
  const [fit, setFit] = useState(() => start());
  if (fit.key !== key) setFit(regap(fit));
  const onSize = (_w: number, h: number) => {
    if (fit.key !== key || !(h > 0)) return;
    // Content that grows after the fit settled (the serif font loading, the ruby arriving) steps the
    // size down with the text kept shown, instead of clipping past the room.
    if (fit.done) {
      if (h + 2 > maxH && fit.pt > LINE_MIN) setFit((f) => (f.key === fit.key && f.pt === fit.pt && f.done ? { ...f, pt: Math.max(LINE_MIN, f.pt - LINE_STEP), done: false, shown: true, h: 0 } : f));
      return;
    }
    if (h + 2 <= maxH) {
      keep(room, fit.pt);
      setFit((f) => (f.pt === fit.pt && f.key === fit.key ? { ...f, done: true, h } : f));
    } else if (fit.pt > LINE_MIN) setFit({ ...fit, pt: stepDown(fit.pt, h, maxH) });
    else {
      keep(room, fit.pt);
      setFit({ ...fit, done: true, h });
    }
  };
  // A unit never wraps, so a long one (a whole greeting) can be wider than the body while its height
  // still fits. Each unit reports its width; a wider one steps the size down to the width that fits.
  const onUnit = (uw: number) => {
    if (fit.key !== key || !(uw > innerW + 0.5) || fit.pt <= LINE_MIN) return;
    // Functional, so a height pass reporting in the same batch cannot overwrite the step.
    setFit((f) => {
      if (f.key !== key || f.pt <= LINE_MIN) return f;
      const next = Math.max(LINE_MIN, Math.floor((f.pt * innerW) / uw / LINE_STEP) * LINE_STEP);
      return { ...f, pt: Math.min(next, f.pt - LINE_STEP), done: false, h: 0 };
    });
  };
  return { fit, onSize, onUnit };
}
