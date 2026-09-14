/**
 * Design tokens. One palette per scheme, read through useTheme so a screen
 * never hardcodes a colour.
 */

import { Platform } from 'react-native';

const palette = {
  light: {
    bg: '#FBFAF8',
    surface: '#FFFFFF',
    surfaceAlt: '#F1EFEA',
    ink: '#16150F',
    muted: '#6C6960',
    line: '#E2DFD7',
    accent: '#1F6F5C',
    accentInk: '#FFFFFF',
    highlight: '#FFD97A',
    danger: '#A3341F',
    info: '#2F6DB5',
    warn: '#B8700F',
  },
  dark: {
    bg: '#111310',
    surface: '#1A1D19',
    surfaceAlt: '#232720',
    ink: '#F3F1EA',
    muted: '#9B9A90',
    line: '#2F332C',
    accent: '#5FD0AE',
    accentInk: '#07130F',
    highlight: '#F0B429',
    danger: '#E4735A',
    info: '#7FB3F0',
    warn: '#F0B429',
  },
} as const;

export type Palette = (typeof palette)[keyof typeof palette];
export const Colors = palette;

export const Spacing = {
  xs: 4,
  sm: 8,
  md: 12,
  lg: 16,
  xl: 24,
  xxl: 32,
} as const;

export const Radius = { sm: 8, md: 14, lg: 22, pill: 999 } as const;

export const Fonts = Platform.select({
  ios: { sans: 'system-ui', rounded: 'ui-rounded', mono: 'ui-monospace' },
  default: { sans: 'normal', rounded: 'normal', mono: 'monospace' },
}) as { sans: string; rounded: string; mono: string };

/** Playback speed range for the player slider. Shadowing lives in the slow end. */
export const SPEED_MIN = 0.5;
export const SPEED_MAX = 1.5;
