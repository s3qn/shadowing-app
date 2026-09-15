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

export const tide = {
  sky: tideSkies.night,                              // .d4 .sky4 gradient stops
  water: '#08131C',                                 // .d4 .water gradient stop
  waterline: 'rgba(255,158,128,0.55)',               // .d4 .water box-shadow, --cr for .ja
  lang: { ja: '#FF9E80', es: '#7FE0D4' },            // .d4 --c / .d4.es --c
  listen: '#B9A8F0',   // :root --lav
  turn: '#F4C86A',     // :root --amber
  record: '#FF8F7A',   // :root --coral
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
