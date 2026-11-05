import { Platform } from 'react-native';

/** `#rrggbb` as `r,g,b` for an rgba(); anything else reads as the ink. */
export function rgbOf(hex: string): string {
  const m = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex);
  return m ? `${parseInt(m[1]!, 16)},${parseInt(m[2]!, 16)},${parseInt(m[3]!, 16)}` : '236,232,244';
}

/**
 * How the platform draws the blur's soft shape. Web and Android (`Paint.setShadowLayer`) take a
 * translucent shadow's alpha from the shadow colour, so the glyph itself can fade and its shadow
 * stays. iOS (UIKit's NSShadow) shadows only the ink a glyph lays down, so a transparent glyph casts
 * nothing: there an opaque copy sits out of view and its shadow alone is moved back over the text.
 */
export const BLUR_BY_OFFSET = Platform.OS === 'ios';

function clamp01(k: number): number {
  'worklet';
  return Number.isFinite(k) ? Math.min(1, Math.max(0, k)) : 0;
}

/** The shadow's radius at blur `b`: 8pt at 22pt, growing with the type (`scale` is the size over 22pt). */
function blurRadius(b: number, scale: number): number {
  'worklet';
  return b * 8 * (Number.isFinite(scale) && scale > 0 ? scale : 1);
}

/**
 * The Final take's blur (focus-controls mock, Round 3 B2): the glyphs fade out and only a soft text
 * shadow of the same ink stays, so no box edge ever shows. `k` runs 0 (sharp) to 1 (a soft shape).
 * `scale` is the text's size over 22pt: the shadow's radius is 8pt at 22pt and grows with the type.
 * Web and Android; iOS draws the same look with `blurGlyph` plus `blurShadow`.
 */
export function textBlur(k: number, rgb: string, scale: number = 1) {
  'worklet';
  const b = clamp01(k);
  return {
    color: `rgba(${rgb},${b <= 0.001 ? 1 : Math.max(0, 1 - b * 1.6)})`,
    textShadowColor: b <= 0.001 ? 'transparent' : `rgba(${rgb},${0.95 - b * 0.35})`,
    textShadowOffset: { width: 0, height: 0 },
    textShadowRadius: blurRadius(b, scale),
  };
}

/** The glyph alone at blur `k`: it fades out as the shape takes over, with no shadow of its own. */
export function blurGlyph(k: number, rgb: string) {
  'worklet';
  const b = clamp01(k);
  const solid = b <= 0.001 ? 1 : Math.max(0, 1 - b * 1.6);
  return { color: `rgba(${rgb},${solid})`, textShadowColor: 'transparent', textShadowOffset: { width: 0, height: 0 }, textShadowRadius: 0 };
}

/**
 * The soft shape alone at blur `k`, for iOS: an opaque glyph drawn `lift` points below the text (out of
 * view) whose shadow, offset back up by `lift`, lands on the text. Sharp, nothing is drawn.
 */
export function blurShadow(k: number, rgb: string, scale: number, lift: number) {
  'worklet';
  const b = clamp01(k);
  const on = b > 0.001;
  return {
    color: on ? `rgb(${rgb})` : 'transparent',
    textShadowColor: on ? `rgba(${rgb},${0.95 - b * 0.35})` : 'transparent',
    textShadowOffset: { width: 0, height: Number.isFinite(lift) ? -lift : 0 },
    textShadowRadius: blurRadius(b, scale),
  };
}

/** The room around a Text that its widest shadow needs, so iOS (which clips a Text's drawing to its box) never cuts it. */
export function blurPad(scale: number): number {
  return Math.ceil(blurRadius(1, scale) * 1.5) + 2;
}

/**
 * The grain's share of the blur (V4 "Grain", research/pre-animator/final-take-blur/recipe.md): a
 * character that starts at `at` and takes `span` of the sentence's blur `h`, eased out (quad), so each
 * one dissolves on its own while one value drives the line.
 */
export function grainK(h: number, at: number, span: number): number {
  'worklet';
  const v = Number.isFinite(h) ? h : 0;
  const x = span > 0 ? Math.min(1, Math.max(0, (v - at) / span)) : v >= at ? 1 : 0;
  return 1 - (1 - x) * (1 - x);
}

/**
 * The blur of one Text: the line's blur `h` as is, or with `span` its grain share starting at `at`.
 * Declared after `grainK`: a worklet captures what it calls as the module loads, so order matters here.
 */
export function blurK(h: number, at: number, span: number): number {
  'worklet';
  return span > 0 ? grainK(h, at, span) : clamp01(h);
}

/** The grain's scatter: each character's start is this share of the blur at most (`0.62 * rand`). */
export const GRAIN_SCATTER = 0.62;

/** mulberry32: the mock's seeded order, so the scatter is the same every time the line shows. */
export function mulberry32(seed: number): () => number {
  let a = seed | 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
