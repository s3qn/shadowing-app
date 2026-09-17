import { Defs, LinearGradient, Stop } from 'react-native-svg';

import { verb as verbTokens, type Verb } from '@/constants/theme';

/**
 * The gradient defs an icon needs to paint itself in a verb's colours.
 * Render this as the first child of the icon's `<Svg>` root, then use
 * `verbPaint(verb)` as the stroke or fill.
 *
 * `gradientUnits="userSpaceOnUse"` in the 24 viewBox is required: the
 * default objectBoundingBox units collapse on a straight stroke (a vertical
 * `M12 12v9` has a zero-width box and would not draw).
 */
export function VerbGradient({ verb }: { verb: Verb }) {
  const { c1, c2 } = verbTokens[verb];
  return (
    <Defs>
      <LinearGradient id={`prism-${verb}`} gradientUnits="userSpaceOnUse" x1={0} y1={0} x2={24} y2={24}>
        <Stop offset={0} stopColor={c1} />
        <Stop offset={1} stopColor={c2} />
      </LinearGradient>
    </Defs>
  );
}

/** The `url(#id)` reference an icon's `stroke` or `fill` uses to paint with `VerbGradient`. */
export function verbPaint(verb: Verb): string {
  return `url(#prism-${verb})`;
}
