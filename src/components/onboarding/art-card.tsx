import { type ReactNode } from 'react';
import { StyleSheet, View, useWindowDimensions } from 'react-native';

import { withAlpha } from '@/constants/theme';

/** The artifact's `.art` is 222pt tall in a 606pt phone body. On a real
 * screen that share of the window keeps the same proportions, with a cap so
 * a tall phone does not stretch it. */
const HEIGHT_RATIO = 0.34;
const HEIGHT_MIN = 200;
const HEIGHT_MAX = 300;
const RADIUS = 28;
const BORDER = 'rgba(236,232,244,0.12)';

/** The centre glow, three stacked circles standing in for the artifact's
 * `radial-gradient(circle at 50% 55%, tint 0%, transparent 70%)`: their
 * alphas add up to the tint in the middle and fall off towards the rim. */
const GLOW_RINGS = [
  { size: 1, alpha: 0.035 },
  { size: 0.68, alpha: 0.035 },
  { size: 0.4, alpha: 0.035 },
];

export type ArtCardProps = {
  /** The pass colour: tints the glow behind the art. */
  colour: string;
  /** Overrides the responsive height, for a step that needs a set stage. */
  height?: number;
  children?: ReactNode;
};

/**
 * The panel the onboarding art sits in: a large rounded rectangle with a
 * hairline border and a soft tinted glow behind its middle. Children are
 * centred, and a child on `StyleSheet.absoluteFill` can place its own parts
 * by percentage inside the card.
 */
export function ArtCard({ colour, height, children }: ArtCardProps) {
  const { height: windowHeight } = useWindowDimensions();
  const h = height ?? Math.round(Math.min(HEIGHT_MAX, Math.max(HEIGHT_MIN, windowHeight * HEIGHT_RATIO)));

  return (
    <View style={[styles.card, { height: h }]}>
      <View pointerEvents="none" style={styles.glowWrap}>
        {GLOW_RINGS.map((ring) => {
          const d = Math.round(h * ring.size);
          return (
            <View
              key={ring.size}
              style={[
                styles.glow,
                { width: d, height: d, borderRadius: d / 2, marginLeft: -d / 2, marginTop: -d / 2, backgroundColor: withAlpha(colour, ring.alpha) },
              ]}
            />
          );
        })}
      </View>
      {children}
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    alignSelf: 'stretch',
    borderRadius: RADIUS,
    borderWidth: 1,
    borderColor: BORDER,
    overflow: 'hidden',
    alignItems: 'center',
    justifyContent: 'center',
  },
  glowWrap: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0 },
  glow: { position: 'absolute', left: '50%', top: '55%' },
});
