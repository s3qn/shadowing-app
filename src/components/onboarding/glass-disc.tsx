import { type ReactNode } from 'react';
import { StyleSheet, View } from 'react-native';
import { BlurView } from 'expo-blur';
import { Canvas, Circle, RadialGradient, vec } from '@shopify/react-native-skia';

import { prism, withAlpha } from '@/constants/theme';

export type GlassDiscProps = {
  /** The art size (`A`): the Lottie body part's own width and height. The
   * disc itself is drawn larger, at `1.5 * size`, so the glass rim shows
   * around the art. */
  size: number;
  /** The pass colour: tints the inner sheen and the outer glow. */
  colour: string;
  children?: ReactNode;
};

/**
 * The onboarding passes' shared disc: a blurred glass circle tinted with the
 * pass colour, chromatic fringe on the left and right rim, and a glow behind
 * it. `children` (the Lottie body part, or nothing yet) sits centred on top.
 *
 * The light on top comes from the radial gradient, which is off-centre
 * towards the upper left. There is no separate highlight bar on the rim: a
 * straight one gets clipped by the round edge down to a short hard dash at
 * the crown, which reads as an artifact over the art rather than as glass.
 */
export function GlassDisc({ size, colour, children }: GlassDiscProps) {
  const d = size * 1.5;
  const radius = d / 2;

  return (
    <View style={{ width: d, height: d, boxShadow: `0 0 30 ${withAlpha(colour, 0.3)}` }}>
      <View style={[styles.inner, { width: d, height: d, borderRadius: radius }]}>
        <BlurView style={StyleSheet.absoluteFill} intensity={prism.blur.intensity} tint={prism.blur.tint} />
        <Canvas style={StyleSheet.absoluteFill}>
          <Circle cx={radius} cy={radius} r={radius}>
            <RadialGradient
              c={vec(0.35 * d, 0.3 * d)}
              r={0.7 * d}
              colors={['rgba(255,255,255,0.14)', withAlpha(colour, 0.16)]}
            />
          </Circle>
        </Canvas>
        <View
          pointerEvents="none"
          style={[
            StyleSheet.absoluteFill,
            {
              borderRadius: radius,
              borderLeftWidth: 2,
              borderLeftColor: prism.fringe.leftOn,
              borderRightWidth: 2,
              borderRightColor: prism.fringe.rightOn,
            },
          ]}
        />
        <View style={styles.content}>{children}</View>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  inner: { overflow: 'hidden' },
  content: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, alignItems: 'center', justifyContent: 'center' },
});
