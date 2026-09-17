/**
 * Design tokens. Tide (below) is the one palette the app draws from: every
 * screen sits on the sky gradient from useSkyStyle, so there is no separate
 * light or dark scheme to pick between.
 */

import { Platform } from 'react-native';

export const Spacing = {
  xs: 4,
  sm: 8,
  md: 12,
  lg: 16,
  xl: 24,
  xxl: 32,
} as const;

export const Radius = { sm: 8, md: 14, lg: 22, pill: 999 } as const;

// Gradient stops [top, middle, bottom] per time of day. All four are dark
// tinted variants (never the light, high-key colours the names might
// suggest) so tide.text stays readable over the sentence, the transcript
// and the Home list at every hour.
export const tideSkies = {
  // Deep indigo warming to a hint of dawn blue at the horizon.
  morning: ['#12102A', '#1A2142', '#223A5E'] as const,
  // Deep teal-blue, the darkest and coolest of the four.
  day: ['#0B2430', '#10333F', '#17434F'] as const,
  // Deep plum with a warm ember glow near the horizon.
  sunset: ['#241530', '#34193A', '#5C2E28'] as const,
  night: ['#070A12', '#101A2A', '#16243A'] as const,
} as const;

// Per-period water palette for the Tide player's Skia canvas: shallow (near
// the surface) fading to deep (below the first screen), plus a glint colour
// left open (no alpha or closing paren) for the light band to complete.
export const tideWaters = {
  morning: { shallow: '#22466A', mid: '#152F4B', deep: '#0A1A2C', glint: 'rgba(200,220,255' },
  day: { shallow: '#1B5566', mid: '#113A4A', deep: '#082028', glint: 'rgba(220,245,255' },
  sunset: { shallow: '#3E2E48', mid: '#231E3A', deep: '#100E22', glint: 'rgba(255,190,150' },
  night: { shallow: '#173247', mid: '#0E2233', deep: '#07131D', glint: 'rgba(255,225,200' },
} as const;

/** The four verbs a button can stand for. Every prism surface picks its colours from `verb[v]`. */
export type Verb = 'listen' | 'speak' | 'read' | 'tools';

/**
 * Per-verb colour set for the prism kit: `c1` and `c2` are the icon and sheen
 * gradient stops, `glow` is the halo that appears when the button is on, and
 * `lip` is the water base a pressed face sinks onto. `lip` is `c2` at 45%
 * mixed with `prism.lipBase` (55%), worked out here so nothing mixes colour
 * at runtime.
 */
export const verb: Record<Verb, { c1: string; c2: string; glow: string; lip: string }> = {
  listen: { c1: '#7CC8FF', c2: '#A9B8FF', glow: 'rgba(124,200,255,0.40)', lip: '#52678D' },
  speak: { c1: '#FF5468', c2: '#FF8A70', glow: 'rgba(255,84,104,0.42)', lip: '#79524D' },
  read: { c1: '#FFC857', c2: '#FFE9A8', glow: 'rgba(255,200,87,0.38)', lip: '#797D66' },
  tools: { c1: '#F4F2F8', c2: '#B9C2D6', glow: 'rgba(244,242,248,0.28)', lip: '#596B7B' },
} as const;

/**
 * Tokens for the prism kit (PrismFace, PrismButton, GlassPanel): the glass
 * fill and blur, the chromatic fringe on the rim, the sheen sweep, the press
 * sink and ripple timings, and the fixed sizes the kit's shapes come in.
 * Plain values only, read as they are, nothing computed at runtime.
 */
export const prism = {
  fill: 'rgba(255,255,255,0.08)',
  blur: { intensity: 40, tint: 'systemUltraThinMaterialDark' },
  fringe: {
    left: 'rgba(255,70,110,0.35)',
    right: 'rgba(70,170,255,0.40)',
    top: 'rgba(255,255,255,0.40)',
    bottom: 'rgba(120,255,210,0.20)',
    leftOn: 'rgba(255,70,110,0.55)',
    rightOn: 'rgba(70,170,255,0.60)',
    side: 1.5,
    line: 1,
  },
  shadow: '0 6 16 rgba(0,0,0,0.32)',
  sheen: {
    colors: ['#ff4d6d', '#ffc857', '#7cffb2', '#7cc8ff', '#b58cff', '#ff4d6d'],
    start: 210,
    opacity: 0.10,
    opacityOn: 0.30,
  },
  glow: { radius: 16 },
  lipBase: '#0B2430',
  press: {
    sinkMin: 3,
    sinkMax: 6,
    sinkReduced: 1.5,
    sinkInMs: 90,
    spring: { damping: 14, stiffness: 260, mass: 0.6 },
  },
  ripple: { rings: 3, width: 1.5, scale: 1.7, ms: 750, delays: [60, 200, 340], opacity: 0.9 },
  sizes: {
    sheetIcon: 30,
    roundSm: 36,
    round: 44,
    bigRound: 56,
    bigRoundLg: 64,
    tile: { w: 56, h: 64, r: 18 },
    pill: { h: 36, padX: 14 },
  },
  panel: { fill: 'rgba(255,255,255,0.06)', rim: 'rgba(255,255,255,0.12)', radius: 20 },
  tray: {
    pad: 5,
    rim: 'rgba(255,255,255,0.14)',
    pane: { dx: 4, dy: 5, color: 'rgba(124,200,255,0.08)' },
    pillFill: 'rgba(255,255,255,0.055)',
    // Deep enough that the white label clears 4.5:1 contrast (was a pale
    // verb-colour tint that left white text nearly unreadable).
    lit: {
      top: '#2F6FA8',
      bottom: '#1D4E7A',
      alpha: 0.90,
      rimWidth: 1,
      rim: 'rgba(124,200,255,0.65)',
      highlight: 'rgba(255,255,255,0.25)',
      glow: '0 4 14 rgba(124,200,255,0.30)',
      label: '#FFFFFF',
      icon: '#CFE9FF',
    },
  },
} as const;

/**
 * Returns a colour at the given alpha as an rgba string. Takes `#rgb`,
 * `#rgba`, `#rrggbb`, `#rrggbbaa`, `rgb(...)` or `rgba(...)` (an rgba input
 * has its alpha replaced). Used for the lit pill gradient (a verb colour
 * fading from 40% to 20%) and anywhere else that needs a verb colour at an
 * opacity it was not given. Runs on either thread and never returns NaN: an
 * unreadable colour comes back as black at that alpha.
 */
export function withAlpha(colour: string, alpha: number): string {
  'worklet';
  const a = Number.isFinite(alpha) ? Math.min(Math.max(alpha, 0), 1) : 1;
  const c = colour.trim();
  const open = c.indexOf('(');
  if (open > 0) {
    const parts = c.slice(open + 1, c.lastIndexOf(')')).split(',');
    const ch = [0, 0, 0];
    for (let i = 0; i < 3; i++) {
      const n = parseFloat(parts[i] ?? '');
      ch[i] = Number.isFinite(n) ? n : 0;
    }
    return `rgba(${ch[0]},${ch[1]},${ch[2]},${a})`;
  }
  let hex = c.charAt(0) === '#' ? c.slice(1) : c;
  if (hex.length === 3 || hex.length === 4) {
    hex = hex[0] + hex[0] + hex[1] + hex[1] + hex[2] + hex[2];
  }
  let r = parseInt(hex.slice(0, 2), 16);
  let g = parseInt(hex.slice(2, 4), 16);
  let b = parseInt(hex.slice(4, 6), 16);
  if (!Number.isFinite(r) || !Number.isFinite(g) || !Number.isFinite(b) || hex.length < 6) {
    r = 0;
    g = 0;
    b = 0;
  }
  return `rgba(${r},${g},${b},${a})`;
}

export const tide = {
  sky: tideSkies.night,                              // .d4 .sky4 gradient stops
  water: '#08131C',                                 // .d4 .water gradient stop
  waterline: 'rgba(255,158,128,0.55)',               // .d4 .water box-shadow, --cr for .ja
  lang: { ja: '#FF9E80', es: '#7FE0D4', en: '#B9C6FF' }, // .d4 --c / .d4.es --c / languages: en
  listen: verb.listen.c1,   // prism verb alias, was :root --lav
  turn: verb.read.c1,       // prism verb alias, was :root --amber
  record: verb.speak.c1,    // prism verb alias, was :root --coral
  text: '#ECE8F4',     // :root --ink
  textDim: '#B7B1C6',  // :root --ink2
  pos: {
    noun: '#6FB6E8',
    verb: '#5FD9A6',
    adjective: '#E6A6D9',
    particle: '#C9B458',
    other: '#B7B1C6',
  },
} as const;

export const Fonts = Platform.select({
  ios: { sans: 'system-ui', rounded: 'ui-rounded', mono: 'ui-monospace' },
  default: { sans: 'normal', rounded: 'normal', mono: 'monospace' },
}) as { sans: string; rounded: string; mono: string };

/** Playback speed range for the player slider. Shadowing lives in the slow end. */
export const SPEED_MIN = 0.5;
export const SPEED_MAX = 1.5;
