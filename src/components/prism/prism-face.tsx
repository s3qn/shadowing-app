import { type ReactNode, useMemo, useState } from 'react';
import { type LayoutChangeEvent, type StyleProp, StyleSheet, Text, View, type ViewStyle } from 'react-native';
import { BlurView } from 'expo-blur';
import { Canvas, Circle, RoundedRect, SweepGradient, vec } from '@shopify/react-native-skia';
import Animated, { interpolateColor, useAnimatedStyle, useSharedValue, type SharedValue } from 'react-native-reanimated';

import { fonts } from '@/constants/fonts';
import { prism, tide, verb as verbTokens, withAlpha, type Verb } from '@/constants/theme';

/** The label and value glow, off and on: the same look the toolbar tiles use,
 * kept here so a tile that renders its label and value through the kit
 * (rather than as its own children, like the toolbar does) still gets it. */
const GLOW_ALPHA_OFF = 0.55;
const GLOW_ALPHA_ON = 0.85;
const GLOW_RADIUS_OFF = 6;
const GLOW_RADIUS_ON = 8;

/** Built once so the Skia gradient gets the same array on every render. */
const SHEEN_COLORS = [...prism.sheen.colors];

export type PrismShape = 'round' | 'tile' | 'pill';

/**
 * Resolves a face's pixel size and corner radius for a shape and its
 * overrides. A pill's width stays `undefined` (it is content-sized);
 * `PrismButton` measures the rendered face instead of guessing it.
 */
export function prismFaceSize(
  shape: PrismShape,
  size?: number,
  width?: number,
  height?: number,
): { width?: number; height: number; radius: number } {
  if (shape === 'round') {
    const d = size ?? prism.sizes.round;
    return { width: d, height: d, radius: d / 2 };
  }
  if (shape === 'tile') {
    return { width: width ?? prism.sizes.tile.w, height: height ?? prism.sizes.tile.h, radius: prism.sizes.tile.r };
  }
  return { width, height: height ?? prism.sizes.pill.h, radius: 999 };
}

export type PrismFaceProps = {
  shape: PrismShape;
  /** Round diameter. Defaults to `prism.sizes.round`. */
  size?: number;
  /** Tile or pill width. Pill ignores this and sizes to its children. */
  width?: number;
  /** Tile or pill height override. */
  height?: number;
  verb: Verb;
  /** 0 off, 1 on. The caller animates this; PrismFace only reads it. */
  onT: SharedValue<number>;
  /** 0 normal, 1 disabled: zeroes the glow and the sheen, independent of `onT`.
   * The caller animates this too. Defaults to a fixed 0 (never disabled). */
  dimT?: SharedValue<number>;
  /** Drops the blur and the drop shadow (the glow stays): for a face already inside a GlassPanel. */
  flat?: boolean;
  /** Tile: under the icon. Pill: after the icon. Round ignores it. Turns the verb colour (white on a pill) when on. */
  label?: string;
  /** Tile only, under the label. A string or number gets the value style; any other node renders as given. */
  value?: ReactNode;
  style?: StyleProp<ViewStyle>;
  /** The icon. */
  children?: ReactNode;
};

/** Reads `onT` as a number in 0..1. A NaN on the UI thread would exit Expo Go silently. */
function safeT(v: number): number {
  'worklet';
  if (!Number.isFinite(v)) return 0;
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

/**
 * The static glass look shared by every prism shape: a blur pane, a faint
 * fill, a rainbow sheen painted once by Skia, and a chromatic fringe on the
 * rim that strengthens when `onT` reaches 1. Carries no press behaviour;
 * `PrismButton` adds the drop and the ripples on top of this.
 */
export function PrismFace({ shape, size, width, height, verb, onT, dimT, flat, label, value, style, children }: PrismFaceProps) {
  const colours = verbTokens[verb];
  // A face used outside PrismButton (the lab's static discs) never passes
  // `dimT`, so this fallback stays at 0 and never dims anything.
  const noDim = useSharedValue(0);
  const dim = dimT ?? noDim;
  const dims = prismFaceSize(shape, size, width, height);
  const { radius } = dims;

  // Round and tile know their pixel size up front, so the sheen canvas can
  // use it straight away. A pill is content-sized: wait for its own layout.
  const [canvasSize, setCanvasSize] = useState<{ width: number; height: number }>({
    width: dims.width ?? 0,
    height: dims.height,
  });
  const handleLayout = (e: LayoutChangeEvent) => {
    if (dims.width !== undefined) return;
    const { width: lw, height: lh } = e.nativeEvent.layout;
    setCanvasSize({ width: lw, height: lh });
  };

  const sheenStyle = useAnimatedStyle(() => ({
    opacity: (prism.sheen.opacity + (prism.sheen.opacityOn - prism.sheen.opacity) * safeT(onT.value)) * (1 - safeT(dim.value)),
  }));
  const fringeOnStyle = useAnimatedStyle(() => ({ opacity: safeT(onT.value) }));
  const glowStyle = useAnimatedStyle(() => ({ opacity: safeT(onT.value) * (1 - safeT(dim.value)) }));

  const labelOff = shape === 'pill' ? tide.text : tide.textDim;
  const labelOn = shape === 'pill' ? prism.tray.lit.label : colours.c1;
  const glowOff = withAlpha(colours.c1, GLOW_ALPHA_OFF);
  const glowOn = withAlpha(colours.c1, GLOW_ALPHA_ON);
  // Riding the same onT this already reads for the colour crossfade: no
  // extra per-frame animated style, just two more fields on this one.
  const labelColourStyle = useAnimatedStyle(() => {
    const t = safeT(onT.value);
    return {
      color: interpolateColor(t, [0, 1], [labelOff, labelOn]),
      textShadowColor: interpolateColor(t, [0, 1], [glowOff, glowOn]),
      textShadowRadius: GLOW_RADIUS_OFF + (GLOW_RADIUS_ON - GLOW_RADIUS_OFF) * t,
    };
  });

  const shapeStyle: ViewStyle =
    shape === 'pill'
      ? { minWidth: dims.width, height: dims.height, borderRadius: radius }
      : { width: dims.width, height: dims.height, borderRadius: radius };

  // Round and tile content fills a fixed box. A pill's content stays in flow
  // so the pill takes its width from the icon and label.
  const contentStyle: StyleProp<ViewStyle> =
    shape === 'tile'
      ? [StyleSheet.absoluteFill, styles.contentColumn]
      : shape === 'pill'
        ? [styles.contentRow, { flexGrow: 1, paddingHorizontal: prism.sizes.pill.padX }]
        : [StyleSheet.absoluteFill, styles.contentCenter];

  const cw = dims.width ?? canvasSize.width;
  const ch = dims.width !== undefined ? dims.height : canvasSize.height;
  const rectR = Math.max(0, Math.min(radius, cw / 2, ch / 2));
  const hasCanvas = cw > 0 && ch > 0;

  // The sheen never changes for a given shape and size, so the Canvas subtree
  // is built once per size and Skia is not asked to repaint on parent renders.
  const sheen = useMemo(
    () => (
      <Canvas style={StyleSheet.absoluteFill}>
        {shape === 'round' ? (
          <Circle cx={cw / 2} cy={ch / 2} r={cw / 2}>
            <SweepGradient c={vec(cw / 2, ch / 2)} start={prism.sheen.start} end={prism.sheen.start + 360} colors={SHEEN_COLORS} />
          </Circle>
        ) : (
          <RoundedRect x={0} y={0} width={cw} height={ch} r={rectR}>
            <SweepGradient c={vec(cw / 2, ch / 2)} start={prism.sheen.start} end={prism.sheen.start + 360} colors={SHEEN_COLORS} />
          </RoundedRect>
        )}
      </Canvas>
    ),
    [shape, cw, ch, rectR],
  );

  // The shadow and glow sit under the clip, sized to the face itself, so a
  // caller stretching the wrapper does not stretch them.
  const haloBox: ViewStyle = { position: 'absolute', top: 0, left: 0, width: cw, height: ch, borderRadius: radius };

  const labelNode =
    label !== undefined && shape !== 'round' ? (
      <Animated.Text numberOfLines={1} style={[shape === 'pill' ? styles.pillLabel : styles.tileLabel, labelColourStyle]}>
        {label}
      </Animated.Text>
    ) : null;
  const valueNode =
    value === undefined || value === null || shape !== 'tile' ? null : typeof value === 'string' || typeof value === 'number' ? (
      <Text numberOfLines={1} style={[styles.tileValue, { textShadowColor: glowOff }]}>
        {value}
      </Text>
    ) : (
      value
    );

  return (
    <View style={style}>
      {hasCanvas && !flat ? <View pointerEvents="none" style={[haloBox, styles.haloFill, { boxShadow: prism.shadow }]} /> : null}
      {hasCanvas ? (
        <Animated.View
          pointerEvents="none"
          style={[haloBox, styles.haloFill, { boxShadow: `0 0 ${prism.glow.radius} ${colours.glow}` }, glowStyle]}
        />
      ) : null}
      <View onLayout={handleLayout} style={[styles.clip, shapeStyle]}>
        {!flat ? (
          <BlurView style={StyleSheet.absoluteFill} intensity={prism.blur.intensity} tint={prism.blur.tint} />
        ) : null}
        <View style={[StyleSheet.absoluteFill, { backgroundColor: prism.fill }]} />
        {hasCanvas ? (
          <Animated.View pointerEvents="none" style={[StyleSheet.absoluteFill, sheenStyle]}>
            {sheen}
          </Animated.View>
        ) : null}
        <View pointerEvents="none" style={[StyleSheet.absoluteFill, { borderRadius: radius }, styles.fringeBorders, styles.fringeOff]} />
        <Animated.View
          pointerEvents="none"
          style={[StyleSheet.absoluteFill, { borderRadius: radius }, styles.fringeBorders, styles.fringeOn, fringeOnStyle]}
        />
        <View style={contentStyle}>
          {children}
          {labelNode}
          {valueNode}
        </View>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  clip: { overflow: 'hidden' },
  contentCenter: { alignItems: 'center', justifyContent: 'center' },
  contentColumn: { alignItems: 'center', justifyContent: 'center', flexDirection: 'column', gap: 2 },
  contentRow: { alignItems: 'center', justifyContent: 'center', flexDirection: 'row', gap: 6 },
  // boxShadow may not draw on a fully transparent view.
  haloFill: { backgroundColor: 'rgba(0,0,0,0.01)' },
  tileLabel: {
    fontFamily: fonts.uiMedium,
    fontWeight: '500',
    fontSize: 10,
    textShadowOffset: { width: 0, height: 0 },
    textShadowRadius: GLOW_RADIUS_OFF,
  },
  tileValue: {
    fontFamily: fonts.ui,
    fontSize: 9,
    color: tide.text,
    fontVariant: ['tabular-nums'],
    textShadowOffset: { width: 0, height: 0 },
    textShadowRadius: GLOW_RADIUS_OFF,
  },
  pillLabel: {
    fontFamily: fonts.ui,
    fontWeight: '600',
    fontSize: 13,
    textShadowOffset: { width: 0, height: 0 },
    textShadowRadius: GLOW_RADIUS_OFF,
  },
  fringeBorders: {
    borderLeftWidth: prism.fringe.side,
    borderRightWidth: prism.fringe.side,
    borderTopWidth: prism.fringe.line,
    borderBottomWidth: prism.fringe.line,
  },
  fringeOff: {
    borderLeftColor: prism.fringe.left,
    borderRightColor: prism.fringe.right,
    borderTopColor: prism.fringe.top,
    borderBottomColor: prism.fringe.bottom,
  },
  fringeOn: {
    borderLeftColor: prism.fringe.leftOn,
    borderRightColor: prism.fringe.rightOn,
    borderTopColor: prism.fringe.top,
    borderBottomColor: prism.fringe.bottom,
  },
});
