import { memo, useState } from 'react';
import { type LayoutChangeEvent, StyleSheet, View } from 'react-native';
import { BlurMask, Canvas, Group, LinearGradient, Oval, Path, Rect, Shader, Skia, vec } from '@shopify/react-native-skia';
import { useDerivedValue, type SharedValue } from 'react-native-reanimated';

import { tide } from '@/constants/theme';
import { BAND_TOP, BOAT_H, BOAT_HULL_D, BOAT_SAIL_BACK_D, BOAT_SAIL_FRONT_D, BOAT_W } from '@/components/tide/water-surface';

/** The lowest a trough of the surface can reach, in canvas pixels. Bubbles
 * wrap back to the bottom before rising past it. */
const BAND_BOTTOM = 40;

/** The caustics fade in over this band (canvas pixels from the top), so they
 * are close to nothing along the surface and never draw a line of their own.
 * They are also clipped to the water body, so their top edge is the live
 * curve, never a fixed y. */
const CAUSTIC_FADE_FROM = 20;
const CAUSTIC_FADE_TO = 110;

/** The card glow's box in canvas pixels: its top sits just under the rest
 * line (y 20) and its blur softens every edge away. */
const GLOW_TOP = 22;
const GLOW_H = 44;

/** Thin bright veins that fade with depth, plus a few leaning light rays.
 * `size`/`p` are canvas pixels, not normalised, so the veins keep the same
 * scale on every phone. `time` is the sim's own time, already slowed to a
 * quarter rate by the caller: fast enough to read as moving water, slow
 * enough to never pull the eye off the sentence. */
const CAUSTICS_SKSL = `
uniform vec2 size;
uniform float time;
uniform vec3 tint;
uniform float intensity;

half4 main(vec2 p) {
  vec2 uv = p / size.x * 3.0;
  float a = sin(uv.x * 1.6 + time * 0.6) + sin(uv.y * 2.2 - time * 0.4);
  float b = sin(uv.y * 1.9 - time * 0.5) + sin(uv.x * 2.4 + time * 0.35);
  float c = pow(max(0.0, 1.0 - abs(a * b) * 0.35), 6.0);
  float depth = clamp(p.y / max(1.0, size.y), 0.0, 1.0);
  float fade = (1.0 - depth) * (1.0 - depth);
  float surfaceIn = smoothstep(${CAUSTIC_FADE_FROM}.0, ${CAUSTIC_FADE_TO}.0, p.y);
  float rays = pow(0.5 + 0.5 * sin(p.x * 0.045 + depth * 2.0 + time * 0.15), 3.0) * (1.0 - depth) * 0.5;
  float v = (c * fade + rays) * intensity * surfaceIn;
  return half4(tint * v, v);
}
`;

/** Compiled once, when this module loads, not once per player mount. Null
 * when the SkSL fails to compile: the caustics are then left out. */
const CAUSTICS_EFFECT = (() => {
  try {
    return Skia.RuntimeEffect.Make(CAUSTICS_SKSL);
  } catch {
    return null;
  }
})();

/** Six rising bubbles, drawn as one filled path so a single derived value
 * (not six) moves them each frame. Fixed per-bubble x fraction, rise speed
 * (px/s of the sim's own time), radius and phase: enough variety to read as
 * loose bubbles, not a grid. */
/** A finite number or the fallback. Every value below reaches Skia's native
 * prop conversion on the UI runtime, where a throw aborts the app. */
function finiteOr(x: number, fallback: number) {
  'worklet';
  return Number.isFinite(x) ? x : fallback;
}

const BUBBLES = [
  { x: 0.16, speed: 9, r: 1.3, phase: 0.4 },
  { x: 0.3, speed: 12, r: 2.1, phase: 2.6 },
  { x: 0.48, speed: 8, r: 1.1, phase: 4.4 },
  { x: 0.63, speed: 13, r: 2.4, phase: 1.2 },
  { x: 0.78, speed: 10.5, r: 1.7, phase: 5.6 },
  { x: 0.9, speed: 14, r: 2.5, phase: 3.1 },
] as const;

export type WaterPalette = {
  shallow: string;
  mid: string;
  deep: string;
  /** An open rgba() prefix, completed with an alpha and closing paren. */
  glint: string;
};

type Props = {
  /** Canvas height in px: one screen tall (`sceneH + 20`), not content tall. */
  height: number;
  /** Open curve for the surface alone: stroked for the light band, and
   * closed down to the canvas's own bottom here for the body fill, so the
   * water's top edge is the live curve everywhere, never a flat shelf. */
  lineD: SharedValue<string>;
  boatX: SharedValue<number>;
  boatY: SharedValue<number>;
  boatAngle: SharedValue<number>;
  palette: WaterPalette;
  /** The sim's own time, seconds since focus: drives the caustics shader
   * and the bubbles, both read at a slowed rate. Frozen under reduced
   * motion, so both go still on their own. */
  time: SharedValue<number>;
  /** Surface height at the centre, relative to rest: the glow under the
   * active card rides on it. */
  centreY: SharedValue<number>;
  /** Caustic brightness for the current period: 0.07 night, 0.14 day, 0.10
   * morning and sunset. */
  intensity: number;
  /** No bubbles under reduced motion; the caustics stay, just still. */
  reducedMotion: boolean;
  /** Width to draw at before the first layout, so the water shows on the
   * first frame. The layout event replaces it. */
  initialWidth?: number;
};

/**
 * The Tide player's water, drawn once per screen with Skia: a depth
 * gradient shared by the body and the surface fill so there is no seam at
 * the waterline, a soft light band that follows the live swell, the paper
 * boat's hull and sails (painted before the fill so the fill still hides
 * its lower half), thin caustic veins and leaning light rays under the
 * surface, a handful of rising bubbles, and a wide soft glow on the water
 * right under the active card so the card reads as floating. `pointerEvents` is
 * left to the wrapping `View` in `tide-scene.tsx`: this canvas never claims
 * a touch.
 */
export const WaterCanvas = memo(function WaterCanvas({
  height,
  lineD,
  boatX,
  boatY,
  boatAngle,
  palette,
  time,
  centreY,
  intensity,
  reducedMotion,
  initialWidth = 0,
}: Props) {
  const [width, setWidth] = useState(() => (Number.isFinite(initialWidth) && initialWidth > 0 ? initialWidth : 0));

  const onLayout = (e: LayoutChangeEvent) => {
    setWidth(e.nativeEvent.layout.width);
  };

  // Boat: translate its 26x16 local box into place, then rotate that box
  // about its own centre, matching the two-step transform the drag target
  // in water-surface.tsx used to apply as CSS (translateY then a
  // centre-anchored rotate).
  const boatPlace = useDerivedValue(() => [
    { translateX: finiteOr(boatX.value, BOAT_W) - BOAT_W / 2 },
    { translateY: finiteOr(boatY.value, 0) + 20 - BOAT_H * 0.6 },
  ]);
  const boatSpin = useDerivedValue(() => [{ rotate: finiteOr(boatAngle.value, 0) }]);

  // The body's own fill: the live curve as its top edge, closed straight
  // down to the canvas's true bottom (not the light band's 40px cap), so
  // the gradient starts exactly on the surface everywhere. One shape, no
  // flat rect underneath it to poke out above a dip or gap under a rise.
  const bodyPathD = useDerivedValue(() => {
    const w = finiteOr(width, 0).toFixed(2);
    const h = finiteOr(height, 0).toFixed(2);
    const line = typeof lineD.value === 'string' && lineD.value.startsWith('M') ? lineD.value : 'M0,20';
    return `${line} L${w},${h} L0,${h} Z`;
  });

  // The glow follows the swell under the card at a little less than its full
  // height, so it reads as light on the water rather than a painted patch.
  const glowPlace = useDerivedValue(() => {
    const y = centreY.value;
    return [{ translateY: Number.isFinite(y) ? 0.8 * y : 0 }];
  });

  const gradientColors: string[] = [palette.shallow, palette.mid, palette.deep];
  const gradientPositions: number[] = [0, 0.35, 1];

  // Plain arrays, not Skia point host objects: the native uniform reader
  // takes an array as is, with no property probing.
  const causticsUniforms = useDerivedValue(() => ({
    size: [Math.max(1, finiteOr(width, 1)), Math.max(1, finiteOr(height, 1))],
    time: finiteOr(time.value, 0) * 0.25,
    tint: [0.63, 0.9, 0.94],
    intensity,
  }), [width, height, intensity]);

  // One path draws all six bubbles, so a single derived value moves them
  // instead of six. Off entirely under reduced motion: the caller never
  // mounts this group then.
  const bubblesPath = useDerivedValue(() => {
    const travel = Math.max(0, 0.9 * height - BAND_BOTTOM);
    const t = finiteOr(time.value, 0);
    let d = '';
    for (let i = 0; i < BUBBLES.length; i++) {
      const bubble = BUBBLES[i];
      const cx = finiteOr(bubble.x * width + 6 * Math.sin(t * 0.6 + bubble.phase), 0);
      const rise = finiteOr((bubble.speed * t + bubble.phase * 20) % Math.max(1, travel), 0);
      const cy = finiteOr(0.9 * height - rise, 0);
      const r = bubble.r;
      d += `M ${(cx - r).toFixed(2)} ${cy.toFixed(2)} a ${r} ${r} 0 1 0 ${2 * r} 0 a ${r} ${r} 0 1 0 ${-2 * r} 0 `;
    }
    return d;
  }, [width, height]);

  return (
    <View style={[styles.wrap, { height }]} onLayout={onLayout} pointerEvents="none">
      {width > 0 && height > 0 ? (
        <Canvas style={{ width, height }}>
          <Group transform={boatPlace}>
            <Group transform={boatSpin} origin={vec(BOAT_W / 2, BOAT_H / 2)}>
              <Path path={BOAT_HULL_D} color={tide.text} />
              <Path path={BOAT_SAIL_FRONT_D} color={tide.lang.ja} />
              <Path path={BOAT_SAIL_BACK_D} color={tide.text} opacity={0.85} />
            </Group>
          </Group>
          <Path path={bodyPathD}>
            <LinearGradient
              start={vec(0, 40)}
              end={vec(0, height)}
              colors={gradientColors}
              positions={gradientPositions}
            />
          </Path>
          <Group transform={glowPlace}>
            <Oval
              x={width * 0.12}
              y={GLOW_TOP}
              width={width * 0.76}
              height={GLOW_H}
              color={`${palette.glint},0.13)`}>
              <BlurMask blur={18} style="normal" />
            </Oval>
          </Group>
          <Group transform={[{ translateY: 5 }]}>
            <Path path={lineD} style="stroke" strokeWidth={10} color={`${palette.glint},0.16)`}>
              <BlurMask blur={6} style="normal" />
            </Path>
          </Group>
          <Path path={lineD} style="stroke" strokeWidth={3} color={`${palette.glint},0.35)`}>
            <BlurMask blur={2} style="normal" />
          </Path>
          <Path path={lineD} style="stroke" strokeWidth={1} color={`${palette.glint},0.8)`} />
          {/* Caustics and bubbles live inside the water body's own path, so
             their top edge is the live surface curve wherever it moves. */}
          <Group clip={bodyPathD}>
            {CAUSTICS_EFFECT ? (
              <Rect x={0} y={0} width={width} height={height}>
                <Shader source={CAUSTICS_EFFECT} uniforms={causticsUniforms} />
              </Rect>
            ) : null}
            {reducedMotion ? null : <Path path={bubblesPath} color="rgba(255,255,255,0.25)" />}
          </Group>
        </Canvas>
      ) : null}
    </View>
  );
});

const styles = StyleSheet.create({
  wrap: {
    position: 'absolute',
    top: BAND_TOP,
    left: 0,
    right: 0,
  },
});
