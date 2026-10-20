import { type ReactNode, useEffect, useMemo, useRef } from 'react';
import { type StyleProp, StyleSheet, View, type ViewStyle } from 'react-native';
import { BlurView } from 'expo-blur';
import { Canvas, LinearGradient, RoundedRect, vec } from '@shopify/react-native-skia';
import Animated, {
  interpolateColor,
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
  withSpring,
  withTiming,
  type SharedValue,
  type WithTimingConfig,
} from 'react-native-reanimated';

import { Radius, prism, withAlpha } from '@/constants/theme';

/** Sizes and colours a pill draws itself with, shared by every call site. */
export const PILL_H = prism.sizes.pill.h;
export const PILL_PAD_X = prism.sizes.pill.padX;
export const PILL_LABEL_SIZE = 13;
export const PILL_ICON_SIZE = 17;
export const PILL_ICON_OFF = '#9E98B0';
export const PILL_ICON_ON = prism.tray.lit.icon;
/** An unlit pill's own faint chip: its fill and its border. */
export const PILL_CHROME_FILL = prism.tray.pillFill;
export const PILL_CHROME_BORDER = 'rgba(255,255,255,0.05)';
/** The light slot-tab pill (wardrobe): a pale fill with a pink-to-blue fringe at the ends. */
export const LIGHT_PILL_FILL = '#F4F2FA';

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

/** Spring that slides the lit pill to a tab or option, and settles it after a cancelled scrub. */
export const PILL_SPRING = { damping: 18, overshootClamping: true };

/**
 * Placement for a `SlidingLitPill`. The first placement is instant so the pill
 * does not fly in from x = 0, and so is any placement under reduced motion;
 * after that it springs to the active item's `{ x, width }`, or eases there
 * with `timing` when given.
 */
export function useSlidingPill(active: { x: number; width: number } | undefined, opts?: { timing?: WithTimingConfig }) {
  const timing = opts?.timing;
  const reducedMotion = useReducedMotion();
  const translateX = useSharedValue(0);
  const width = useSharedValue(0);
  const placed = useRef(false);
  useEffect(() => {
    if (!active) return;
    if (reducedMotion || !placed.current) {
      translateX.value = active.x;
      width.value = active.width;
      placed.current = true;
      return;
    }
    translateX.value = timing ? withTiming(active.x, timing) : withSpring(active.x, PILL_SPRING);
    width.value = timing ? withTiming(active.width, timing) : withSpring(active.width, PILL_SPRING);
  }, [active, reducedMotion, timing, translateX, width]);
  return { translateX, width };
}

/** One item's box in the row a `SlidingLitPill` moves through. */
export type PillItemBox = { x: number; width: number };

/** The sliding pill's position and width, and one item's box: what a cover-driven style reads. */
export type PillCover = { translateX: SharedValue<number>; width: SharedValue<number>; item: PillItemBox | undefined };

/**
 * How much of an item at `x` (width `w`) a pill at `tx` (width `pw`) covers,
 * 0 to 1, and 0 until the item is measured. A label colour or an unlit chip
 * driven by this follows the pill as it travels, so a label never turns lit
 * over the empty tray or goes dim while the lit pill still sits under it.
 * Each style computes it itself instead of through a derived value, so it
 * changes in the same frame as the pill.
 */
function coverOf(tx: number, pw: number, x: number, w: number): number {
  'worklet';
  if (!(w > 0)) return 0;
  const c = (Math.min(tx + pw, x + w) - Math.max(tx, x)) / w;
  // NaN fails the comparison and reads as 0.
  return c > 0 ? Math.min(1, c) : 0;
}

/**
 * A label colour that moves from `off` to `on` with the pill's cover. `span`
 * narrows the blend around the half-covered point, for a pill whose two label
 * colours are far apart (dark ink on the light slot pill), where a grey in
 * between reads on neither side of the pill's edge.
 */
export function usePillLabelStyle(
  { translateX, width, item }: PillCover,
  off: string = PILL_ICON_OFF,
  on: string = prism.tray.lit.label,
  span: readonly [number, number] = [0, 1],
) {
  const [lo, hi] = span;
  const x = item?.x ?? 0;
  const w = item?.width ?? 0;
  return useAnimatedStyle(() => ({ color: interpolateColor(coverOf(translateX.value, width.value, x, w), [lo, hi], [off, on]) }));
}

/** The opacity of an item's lit-only part (the tab bar's lit icon): its cover. */
export function usePillLitStyle({ translateX, width, item }: PillCover) {
  const x = item?.x ?? 0;
  const w = item?.width ?? 0;
  return useAnimatedStyle(() => ({ opacity: coverOf(translateX.value, width.value, x, w) }));
}

/**
 * An unlit pill's chip (fill and border), fading out as the pill covers it.
 * Animates the pill's own colours, so the pill needs a constant 1 px border
 * and its size never changes when it turns on.
 */
export function usePillChromeStyle({ translateX, width, item }: PillCover) {
  const x = item?.x ?? 0;
  const w = item?.width ?? 0;
  return useAnimatedStyle(() => {
    const c = coverOf(translateX.value, width.value, x, w);
    return {
      backgroundColor: interpolateColor(c, [0, 1], [PILL_CHROME_FILL, 'rgba(255,255,255,0)']),
      borderColor: interpolateColor(c, [0, 1], [PILL_CHROME_BORDER, 'rgba(255,255,255,0)']),
    };
  });
}

const AnimatedView = Animated.createAnimatedComponent(View);

export type SlidingLitPillProps = {
  translateX: SharedValue<number>;
  width: SharedValue<number>;
  /** Width of the fill's fixed canvas: the widest item measured so far (growing only). */
  fillWidth: number;
  /** Scrub hold, 0 to 1: grows the pill a little and brightens the rim. */
  held?: SharedValue<number>;
  /** `light`: the wardrobe slot tabs' pale fringed pill, no rim. Default: the blue lit pill. */
  look?: 'lit' | 'light';
};

/**
 * The one lit pill that slides under a row of items. Render it first inside
 * the row (which has no padding) so `translateX` counts from the row's edge.
 * The fill's Canvas is drawn at `fillWidth` and held there, so switching items
 * never resizes it (a resize recreates the Skia canvas and the gradient gaps
 * for a frame); this container clips it down to the current width. The rim is
 * sized to the container instead, so its right end stays round.
 */
export function SlidingLitPill({ translateX, width, fillWidth, held, look = 'lit' }: SlidingLitPillProps) {
  const opacity = useSharedValue(1);
  const style = useAnimatedStyle(() => ({
    transform: [{ translateX: translateX.value }, { scale: 1 + (held ? held.value : 0) * 0.06 }],
    width: width.value,
  }));
  return (
    <AnimatedView pointerEvents="none" style={[styles.slidingPill, style]}>
      <View style={[styles.litFillBox, { width: fillWidth, height: PILL_H }]}>
        {look === 'light' ? <LightPillFill width={fillWidth} /> : <LitPillFill width={fillWidth} height={PILL_H} opacity={opacity} />}
      </View>
      {look === 'light' ? null : <LitPillRim radius={PILL_H / 2} opacity={opacity} held={held} />}
    </AnimatedView>
  );
}

/** The light pill's canvas at a fixed width, clipped by the sliding container like `LitPillFill`. */
function LightPillFill({ width }: { width: number }) {
  if (!(width > 0)) return null;
  return (
    <Canvas style={StyleSheet.absoluteFill}>
      <RoundedRect x={0} y={0} width={width} height={PILL_H} r={PILL_H / 2} color={LIGHT_PILL_FILL} />
      <RoundedRect x={0} y={0} width={width} height={PILL_H} r={PILL_H / 2}>
        <LinearGradient
          start={vec(0, 0)}
          end={vec(width, 0)}
          colors={[prism.fringe.leftOn, LIGHT_PILL_FILL, LIGHT_PILL_FILL, prism.fringe.rightOn]}
          positions={[0, 0.2, 0.8, 1]}
        />
      </RoundedRect>
    </Canvas>
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
  slidingPill: { position: 'absolute', left: 0, top: 0, bottom: 0, borderRadius: PILL_H / 2, overflow: 'hidden' },
  litFillBox: { position: 'absolute', left: 0, top: 0 },
  litGlow: { ...StyleSheet.absoluteFill, backgroundColor: 'rgba(0,0,0,0.01)', boxShadow: prism.tray.lit.glow },
  litTopLine: { position: 'absolute', height: 1, backgroundColor: prism.tray.lit.highlight },
  heldGlow: { ...StyleSheet.absoluteFill, backgroundColor: 'rgba(0,0,0,0.01)', boxShadow: '0 4 18 rgba(124,200,255,0.45)' },
});
