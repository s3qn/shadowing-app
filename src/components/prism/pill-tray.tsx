import { type ReactNode, useMemo } from 'react';
import { type StyleProp, StyleSheet, View, type ViewStyle } from 'react-native';
import { BlurView } from 'expo-blur';
import { Canvas, LinearGradient, RoundedRect, vec } from '@shopify/react-native-skia';
import Animated, { useAnimatedStyle, type SharedValue } from 'react-native-reanimated';

import { Radius, prism, withAlpha } from '@/constants/theme';

/** Sizes and colours a pill draws itself with, shared by every call site. */
export const PILL_H = prism.sizes.pill.h;
export const PILL_PAD_X = prism.sizes.pill.padX;
export const PILL_LABEL_SIZE = 13;
export const PILL_ICON_SIZE = 17;
export const PILL_ICON_OFF = '#9E98B0';
export const PILL_ICON_ON = prism.tray.lit.icon;

export type PillTrayShellProps = {
  children?: ReactNode;
  style?: StyleProp<ViewStyle>;
  /**
   * Style for the outer wrap, which is what the pane sizes itself against.
   * A parent that stretches its children by default (`alignItems: 'stretch'`,
   * for example a column header) forces the wrap to full width unless a
   * caller overrides it here with `alignSelf: 'flex-start'`, which also
   * shrinks the pane back to a corner peek instead of a full-width strip.
   */
  wrapStyle?: StyleProp<ViewStyle>;
};

/**
 * The capsule chrome shared by the tab bar and the Home sort row: one blur
 * pass, a rim, a top inner highlight, and an offset blue pane peeking out
 * behind it. Callers lay their own pills out inside as `children`.
 */
export function PillTrayShell({ children, style, wrapStyle }: PillTrayShellProps) {
  return (
    <View style={[styles.wrap, wrapStyle]}>
      <View pointerEvents="none" style={styles.pane} />
      <View style={[styles.capsule, style]}>
        <BlurView style={StyleSheet.absoluteFill} intensity={prism.blur.intensity} tint={prism.blur.tint} />
        <View pointerEvents="none" style={styles.rim} />
        <View pointerEvents="none" style={styles.topLine} />
        {children}
      </View>
    </View>
  );
}

export type LitPillFillProps = {
  /** Pixel size of the pill this fill sits behind. */
  width: number;
  height: number;
  /** 0 to 1, driven by the caller: a slide position or a crossfade. */
  opacity: SharedValue<number>;
};

/**
 * The selected-pill background: a vertical blue-to-white gradient only. An
 * absolute-fill child sized to one pill. Drawn at a fixed size by the tab
 * bar (the widest tab's width, so switching tabs never recreates the Skia
 * canvas) and clipped down to the real width by the caller's own container,
 * which is why the rim, highlight and glow live in `LitPillRim` instead:
 * those need to track the container's real size, not this canvas's.
 */
export function LitPillFill({ width, height, opacity }: LitPillFillProps) {
  const radius = height / 2;
  const hasSize = width > 0 && height > 0;
  const fadeStyle = useAnimatedStyle(() => ({ opacity: opacity.value }));

  const gradient = useMemo(() => {
    if (!hasSize) return null;
    return (
      <Canvas style={StyleSheet.absoluteFill}>
        <RoundedRect x={0} y={0} width={width} height={height} r={radius} color="#FFFFFF" />
        <RoundedRect x={0} y={0} width={width} height={height} r={radius}>
          <LinearGradient
            start={vec(width / 2, 0)}
            end={vec(width / 2, height)}
            colors={[withAlpha(prism.tray.lit.top, prism.tray.lit.alpha), withAlpha(prism.tray.lit.bottom, prism.tray.lit.alpha)]}
          />
        </RoundedRect>
      </Canvas>
    );
  }, [hasSize, width, height, radius]);

  if (!hasSize) return null;

  return (
    <Animated.View pointerEvents="none" style={[StyleSheet.absoluteFill, fadeStyle, { borderRadius: radius, overflow: 'hidden' }]}>
      {gradient}
    </Animated.View>
  );
}

export type LitPillRimProps = {
  /** Corner radius, matched to the radius of the container this sits in. */
  radius: number;
  /** 0 to 1, driven by the caller: a slide position or a crossfade. */
  opacity: SharedValue<number>;
  /**
   * 0 to 1, driven by a long-press-and-scrub hold on the tab bar: fades in a
   * brighter ring and glow on top of the resting rim instead of a hard cut.
   * Optional so callers that never scrub (the Home sort row) are unaffected.
   */
  held?: SharedValue<number>;
};

/**
 * The selected-pill's rim, inner top highlight and outer glow: everything
 * that must sit flush with the container's own rounded corners. Sized with
 * `StyleSheet.absoluteFill` so it always matches the container it is placed
 * in (a sliding pill's animated width, or a crossfading pill's measured
 * size), unlike `LitPillFill`'s canvas, which is kept at a fixed size.
 */
export function LitPillRim({ radius, opacity, held }: LitPillRimProps) {
  const fadeStyle = useAnimatedStyle(() => ({ opacity: opacity.value }));
  const heldStyle = useAnimatedStyle(() => ({ opacity: held ? held.value : 0 }));
  return (
    <Animated.View pointerEvents="none" style={[StyleSheet.absoluteFill, fadeStyle]}>
      <View pointerEvents="none" style={[styles.litGlow, { borderRadius: radius }]} />
      <View
        pointerEvents="none"
        style={[StyleSheet.absoluteFill, { borderRadius: radius, borderWidth: prism.tray.lit.rimWidth, borderColor: prism.tray.lit.rim }]}
      />
      <View pointerEvents="none" style={[styles.litTopLine, { top: prism.tray.lit.rimWidth, left: prism.tray.lit.rimWidth, right: prism.tray.lit.rimWidth }]} />
      {held ? (
        <Animated.View pointerEvents="none" style={[StyleSheet.absoluteFill, heldStyle]}>
          <View pointerEvents="none" style={[styles.heldGlow, { borderRadius: radius }]} />
          <View
            pointerEvents="none"
            style={[StyleSheet.absoluteFill, { borderRadius: radius, borderWidth: prism.tray.lit.rimWidth, borderColor: 'rgba(124,200,255,0.95)' }]}
          />
        </Animated.View>
      ) : null}
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  wrap: { position: 'relative' },
  pane: {
    position: 'absolute',
    left: prism.tray.pane.dx,
    top: prism.tray.pane.dy,
    right: -prism.tray.pane.dx,
    bottom: -prism.tray.pane.dy,
    borderRadius: Radius.pill,
    backgroundColor: prism.tray.pane.color,
  },
  capsule: {
    flexDirection: 'row',
    overflow: 'hidden',
    borderRadius: Radius.pill,
    padding: prism.tray.pad,
  },
  rim: { ...StyleSheet.absoluteFill, borderRadius: Radius.pill, borderWidth: 1, borderColor: prism.tray.rim },
  topLine: { position: 'absolute', top: 1, left: 1, right: 1, height: 1, backgroundColor: 'rgba(255,255,255,0.16)' },
  // boxShadow may not draw on a fully transparent view.
  litGlow: { ...StyleSheet.absoluteFill, backgroundColor: 'rgba(0,0,0,0.01)', boxShadow: prism.tray.lit.glow },
  litTopLine: { position: 'absolute', height: 1, backgroundColor: prism.tray.lit.highlight },
  heldGlow: { ...StyleSheet.absoluteFill, backgroundColor: 'rgba(0,0,0,0.01)', boxShadow: '0 4 18 rgba(124,200,255,0.45)' },
});
