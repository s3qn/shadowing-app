import { Canvas, Group, LinearGradient, Path, RadialGradient, Rect, RoundedRect, Skia, vec } from '@shopify/react-native-skia';
import { useFocusEffect } from 'expo-router';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Pressable, StyleSheet, useWindowDimensions, View } from 'react-native';
import Animated, { cancelAnimation, Easing, Extrapolation, interpolate, useAnimatedStyle, useReducedMotion, useSharedValue, withRepeat, withSequence, withSpring, withTiming } from 'react-native-reanimated';

import { CatAvatar, type CatAvatarProps } from '@/components/cat/cat-avatar';
import type { CatRect } from '@/hooks/use-gaze';
import { BlinkEnabled } from '@/lib/cat-blink';
import { hapticSelection } from '@/lib/haptics';
import { useT } from '@/lib/i18n';

export type CatStageProps = Pick<CatAvatarProps, 'equipped' | 'preview'> & {
  /** Bump this to play the landing dip after an equip or a buy. */
  dipKey?: number;
  /** Cat follows the live gaze from useGaze. */
  gaze?: boolean;
  /** Reports the cat's rect in window coordinates once laid out. */
  onCatRect?: (rect: CatRect) => void;
};

/** Sky and mountains end at the waterline; the water strip runs 64px below it into the page. */
export const STAGE_H = 304;
export const WATER_H = 64;
const CAT_SIZE = 184;
const CAT_TOP = STAGE_H - (232 * CAT_SIZE) / 200;

const PAGE = '#0B1020';

// Sea rock, in px relative to the rock's top-left (260 x 48).
const ROCK_W = 260;
const ROCK_H = 48;
const ROCK_PTS: [number, number][] = [[0, 48], [5, 37], [18, 26], [36, 16], [47, 8], [73, 3], [133, 2.4], [192, 3], [213, 8], [234, 17], [250, 30], [257, 39], [260, 48]];
const FACET_TOP: [number, number][] = [[36, 16], [47, 8], [73, 3], [133, 2.4], [192, 3], [213, 8], [234, 17]];
const FACET_LEFT: [number, number][] = [[0, 48], [5, 37], [18, 26], [36, 16], [78, 20.2], [67.6, 34.6], [46.8, 48]];
const FACET_RIGHT: [number, number][] = [[213, 8], [234, 17], [250, 30], [257, 39], [260, 48], [215, 48], [226, 28]];
const CRACKS: [number, number, number][] = [[0.3, 14, -22], [0.46, 18, 12], [0.65, 10, 25]];
const MOSS_PATCHES: [number, number][] = [[95, 80], [130, 90], [165, 60]];
const MOSS_DOTS: [number, number, number][] = Array.from({ length: 14 }, (_, i) => [
  ROCK_W * (0.23 + 0.51 * ((i * 0.618) % 1)),
  3 + ((i * 5) % 11),
  1.5 + ((i * 7) % 5) * 0.6,
]);
const CREAM = '244,242,248';

// Water flow bands: [x, y in the water strip, width, alpha].
const F1: [number, number, number, number][] = [[-20, 8, 120, 0.12], [140, 16, 150, 0.16], [30, 26, 160, 0.18], [210, 38, 100, 0.1], [90, 50, 130, 0.14]];
const F2: [number, number, number, number][] = [[60, 12, 130, 0.09], [-10, 21, 110, 0.12], [170, 32, 150, 0.07], [100, 44, 90, 0.1]];
// Moon glint bars: [width, alpha], one per 7px from y 312.
const GLINT: [number, number][] = [[26, 0.55], [34, 0.42], [30, 0.32], [22, 0.24], [16, 0.17], [10, 0.13]];
const AMP_F1 = 7;
const AMP_F2 = 5;
const AMP_GLINT = 2.5;
const TAU = Math.PI * 2;

function polyPath(pts: [number, number][], dx: number, dy: number) {
  const path = Skia.Path.Make();
  pts.forEach(([x, y], i) => (i === 0 ? path.moveTo(x + dx, y + dy) : path.lineTo(x + dx, y + dy)));
  path.close();
  return path;
}

/** The mossy rock, drawn once. Canvas is 270x60, the rock sits at (5, 5). */
function RockSurface() {
  const g = useMemo(() => {
    const crackPath = Skia.Path.Make();
    CRACKS.forEach(([fx, len, deg]) => {
      const x = 5 + ROCK_W * fx;
      const y = 5 + ROCK_H * 0.4;
      const a = (deg * Math.PI) / 180;
      crackPath.moveTo(x, y);
      crackPath.lineTo(x + Math.sin(a) * len, y + Math.cos(a) * len);
    });
    return {
      body: polyPath(ROCK_PTS, 5, 5),
      rim: polyPath(ROCK_PTS, 5, 5 - 1.6),
      top: polyPath(FACET_TOP, 5, 5),
      left: polyPath(FACET_LEFT, 5, 5),
      right: polyPath(FACET_RIGHT, 5, 5),
      cracks: crackPath,
    };
  }, []);
  return (
    <Canvas style={{ width: 270, height: 60 }} pointerEvents="none">
      <Path path={g.rim}>
        <LinearGradient start={vec(5, 0)} end={vec(265, 0)} colors={[`rgba(${CREAM},0.22)`, `rgba(${CREAM},0.4)`, `rgba(${CREAM},0.6)`]} positions={[0, 0.6, 1]} />
      </Path>
      <Path path={g.body}>
        <LinearGradient start={vec(0, 5)} end={vec(0, 53)} colors={['#252e66', '#171e4e', '#0e1335']} positions={[0, 0.55, 1]} />
      </Path>
      <Group clip={g.body}>
        <Path path={g.top} color="rgba(130,150,215,0.15)" />
        <Path path={g.left} color="rgba(5,6,15,0.34)" />
        <Path path={g.right} color="rgba(150,170,230,0.15)" />
        <Path path={g.cracks} color="rgba(5,6,15,0.45)" style="stroke" strokeWidth={1.2} />
        {MOSS_PATCHES.map(([cx, w], i) => (
          <RoundedRect key={i} x={5 + cx - w / 2} y={5 + 3 + (i % 2) * 2} width={w} height={6} r={4} color="rgba(130,150,215,0.16)" />
        ))}
        {MOSS_DOTS.map(([x, y, w], i) => (
          <Rect key={i} x={5 + x} y={5 + y} width={w} height={1.4} color="rgba(130,150,215,0.28)" />
        ))}
        <Rect x={5} y={5 + 37.4} width={ROCK_W} height={18.5}>
          <LinearGradient start={vec(0, 5 + 37.4)} end={vec(0, 5 + 55.9)} colors={['rgba(15,21,53,0)', 'rgba(15,21,53,0.8)']} />
        </Rect>
        <Rect x={5 + 8} y={5 + 37.4} width={244} height={1.2} color="rgba(124,200,255,0.22)" />
        <Rect x={5} y={5 + 30} width={ROCK_W} height={10}>
          <LinearGradient start={vec(0, 5 + 30)} end={vec(0, 5 + 40)} colors={['rgba(124,200,255,0)', 'rgba(124,200,255,0.1)', 'rgba(124,200,255,0)']} />
        </Rect>
      </Group>
    </Canvas>
  );
}
/** The rock flipped under the waterline, faded to nothing. Static, drawn once. Canvas is 260x48. */
function RockReflection() {
  const path = useMemo(() => {
    const flipped = Skia.Path.Make();
    ROCK_PTS.forEach(([x, y], i) => (i === 0 ? flipped.moveTo(x, ROCK_H - y) : flipped.lineTo(x, ROCK_H - y)));
    flipped.close();
    return flipped;
  }, []);
  return (
    <Canvas style={{ width: ROCK_W, height: ROCK_H }} pointerEvents="none">
      <Path path={path}>
        <LinearGradient start={vec(0, 0)} end={vec(0, ROCK_H)} colors={['rgba(37,46,102,0.378)', 'rgba(14,19,53,0)']} />
      </Path>
    </Canvas>
  );
}

/** Red glow on the left half and blue on the right half of the waterline, baked as soft radial gradients. Canvas is 340x14. */
function PrismWaterline() {
  return (
    <Canvas style={{ width: 340, height: 14 }} pointerEvents="none">
      <Group transform={[{ translateY: 7 }, { scaleY: 0.07 }]}>
        <Rect x={0} y={-100} width={170} height={200}>
          <RadialGradient c={vec(170, 0)} r={165} colors={['rgba(255,70,110,0.4)', 'rgba(255,70,110,0)']} />
        </Rect>
        <Rect x={170} y={-100} width={170} height={200}>
          <RadialGradient c={vec(170, 0)} r={165} colors={['rgba(70,170,255,0.44)', 'rgba(70,170,255,0)']} />
        </Rect>
      </Group>
    </Canvas>
  );
}
const STARS: [number, number, number][] = [
  [0.08, 18, 0.8], [0.22, 34, 0.5], [0.35, 14, 0.7], [0.48, 28, 0.4], [0.63, 12, 0.8], [0.78, 30, 0.6],
  [0.9, 20, 0.7], [0.14, 60, 0.4], [0.86, 66, 0.5], [0.7, 54, 0.3], [0.3, 70, 0.35], [0.55, 50, 0.3],
];
const PEAKS: { x: number; size: number; front: boolean }[] = [
  { x: 0.02, size: 120, front: false }, { x: 0.34, size: 150, front: false }, { x: 0.7, size: 120, front: false },
  { x: -0.1, size: 100, front: true }, { x: 0.5, size: 110, front: true }, { x: 0.86, size: 100, front: true },
];

/**
 * A moonlit waterline: a night sky, dim mountains, a static moon glow behind
 * the cat, the waterline and a strip of water. Every layer is a static View
 * (gradients via backgroundImage), nothing blurred or animated except the
 * cat's landing dip and its blink.
 */
export function CatStage({ equipped, preview, dipKey = 0, gaze, onCatRect }: CatStageProps) {
  const catRef = useRef<View>(null);
  const { width } = useWindowDimensions();
  const { t } = useT();
  const [petKey, setPetKey] = useState(0);
  const reduced = useReducedMotion();
  const dip = useSharedValue(1);
  useEffect(() => {
    if (dipKey === 0 || reduced) return;
    cancelAnimation(dip);
    dip.value = withSequence(withTiming(0.98, { duration: 70 }), withSpring(1, { damping: 18, stiffness: 180 }));
  }, [dipKey, reduced, dip]);
  const dipStyle = useAnimatedStyle(() => ({ transform: [{ scale: Number.isFinite(dip.value) ? dip.value : 1 }] }));

  // One slow clock drives the whole water flow. It only runs while the screen is focused and motion is allowed.
  const clock = useSharedValue(0);
  useFocusEffect(
    useCallback(() => {
      if (!reduced) clock.value = withRepeat(withTiming(1, { duration: 36000, easing: Easing.linear }), -1, false);
      return () => {
        cancelAnimation(clock);
        clock.value = 0;
      };
    }, [reduced, clock]),
  );
  const f1Style = useAnimatedStyle(() => {
    const c = Number.isFinite(clock.value) ? clock.value : 0;
    return { transform: [{ translateX: AMP_F1 * Math.sin(TAU * (c * 4)) }] };
  });
  const f2Style = useAnimatedStyle(() => {
    const c = Number.isFinite(clock.value) ? clock.value : 0;
    return { transform: [{ translateX: -AMP_F2 * Math.sin(TAU * (c * 3 + 0.3)) }] };
  });
  const glintStyle = useAnimatedStyle(() => {
    const c = Number.isFinite(clock.value) ? clock.value : 0;
    return { transform: [{ translateX: AMP_GLINT * Math.sin(TAU * (c * 6)) }] };
  });
  const ring1Style = useAnimatedStyle(() => {
    const c = Number.isFinite(clock.value) ? clock.value : 0;
    const p = (c * 5) % 1;
    return {
      opacity: reduced ? 0.1 : interpolate(p, [0, 0.2, 1], [0, 0.2, 0], Extrapolation.CLAMP),
      transform: [{ scale: reduced ? 1 : interpolate(p, [0, 1], [0.92, 1.12], Extrapolation.CLAMP) }],
    };
  });
  const ring2Style = useAnimatedStyle(() => {
    const c = Number.isFinite(clock.value) ? clock.value : 0;
    const p = (c * 5 + 0.5) % 1;
    return {
      opacity: reduced ? 0 : interpolate(p, [0, 0.2, 1], [0, 0.2, 0], Extrapolation.CLAMP),
      transform: [{ scale: interpolate(p, [0, 1], [0.92, 1.12], Extrapolation.CLAMP) }],
    };
  });
  const RL = width / 2 - 165;
  const moonX = width * 0.56 + 32;
  return (
    <View style={{ width, height: STAGE_H + WATER_H }} pointerEvents="box-none">
      <View style={[styles.sky, { height: STAGE_H, experimental_backgroundImage: 'linear-gradient(180deg, #080b1c 0%, #131a40 55%, #262c63 100%)' }]} />
      {STARS.map(([x, y, a], i) => (
        <View key={i} style={[styles.star, { left: x * width, top: y, opacity: a }]} />
      ))}
      <View style={[styles.glow, { left: (width - 380) / 2, top: CAT_TOP - 60, experimental_backgroundImage: 'radial-gradient(circle, rgba(244,242,248,0.12) 0%, rgba(124,200,255,0.08) 38%, transparent 70%)' }]} />
      <View style={[styles.backlight, { left: width / 2 + 46 - 130, top: 45, width: 260, height: 280, experimental_backgroundImage: 'radial-gradient(ellipse closest-side, rgba(90,170,255,0.42) 0%, transparent 100%)' }]} pointerEvents="none" />
      <View style={[styles.backlight, { left: width / 2 - 50 - 120, top: 60, width: 240, height: 260, experimental_backgroundImage: 'radial-gradient(ellipse closest-side, rgba(255,84,110,0.2) 0%, transparent 100%)' }]} pointerEvents="none" />
      <View style={[styles.halo, { left: width * 0.56 - 36, top: STAGE_H - 232, experimental_backgroundImage: 'radial-gradient(circle, rgba(255,214,120,0.18) 0%, rgba(255,200,87,0.06) 50%, transparent 70%)' }]} />
      <View style={[styles.moon, { left: width * 0.56, top: STAGE_H - 196, experimental_backgroundImage: 'radial-gradient(circle at 38% 34%, #fffdf2, #f1e3b3 65%, #d9c488)' }]} />
      <View style={[styles.hills, { top: STAGE_H - 74 }]}>
        {PEAKS.map((p, i) => (
          <View
            key={i}
            style={{
              position: 'absolute',
              left: p.x * width,
              top: p.front ? 44 : 30,
              width: p.size * 0.7,
              height: p.size * 0.7,
              backgroundColor: p.front ? '#10163a' : '#151b44',
              opacity: p.front ? 0.85 : 0.55,
              borderRadius: 6,
              transform: [{ rotate: '45deg' }],
            }}
          />
        ))}
      </View>
      <View style={[styles.backlight, { left: width / 2 - 260, top: 272, width: 520, height: 60, experimental_backgroundImage: 'radial-gradient(ellipse closest-side, rgba(190,205,255,0.1) 0%, transparent 100%)' }]} pointerEvents="none" />
      <View style={[styles.water, { top: STAGE_H, experimental_backgroundImage: `linear-gradient(180deg, #1b2350, #0f1535 55%, ${PAGE})` }]} />
      <View style={[styles.line, { top: STAGE_H - 1, experimental_backgroundImage: 'linear-gradient(90deg, transparent, rgba(244,242,248,0.85), transparent)' }]} />
      <View style={[styles.reflection, { left: RL + 20, top: 318, experimental_backgroundImage: 'linear-gradient(180deg, rgba(15,21,53,0.5), rgba(15,21,53,0))' }]} />
      <View style={{ position: 'absolute', left: RL, top: 311 }} pointerEvents="none">
        <RockReflection />
      </View>
      <View style={{ position: 'absolute', left: width / 2 - 170, top: 297 }} pointerEvents="none">
        <PrismWaterline />
      </View>
      <View style={[styles.backlight, { left: width / 2 - 85, top: 303, width: 170, height: 1.5, experimental_backgroundImage: 'linear-gradient(90deg, transparent, rgba(255,255,255,0.88), transparent)' }]} pointerEvents="none" />
      <View style={[styles.flowClip, { top: STAGE_H }]} pointerEvents="none">
        <Animated.View style={[styles.flowGroup, { left: -AMP_F1, width: width + 2 * AMP_F1 }, f1Style]}>
          {F1.map(([x, y, w, a], i) => (
            <View key={i} style={[styles.band, { left: x * (width / 390), top: y, width: w, backgroundColor: `rgba(124,200,255,${a})` }]} />
          ))}
        </Animated.View>
        <Animated.View style={[styles.flowGroup, { left: -AMP_F2, width: width + 2 * AMP_F2 }, f2Style]}>
          {F2.map(([x, y, w, a], i) => (
            <View key={i} style={[styles.band, { left: x * (width / 390), top: y, width: w, backgroundColor: `rgba(${CREAM},${a})` }]} />
          ))}
        </Animated.View>
        <Animated.View style={[styles.flowGroup, { left: 0, width }, glintStyle]}>
          {GLINT.map(([w, a], i) => (
            <View key={i} style={[styles.band, { left: moonX - w / 2, top: 312 - STAGE_H + i * 7, width: w, backgroundColor: `rgba(${CREAM},${a})` }]} />
          ))}
        </Animated.View>
      </View>
      <View style={{ position: 'absolute', left: RL - 5, top: 263 }} pointerEvents="none">
        <RockSurface />
      </View>
      <View style={[styles.contact, { left: width / 2 - 60, top: 263.5, experimental_backgroundImage: 'radial-gradient(ellipse, rgba(5,6,15,0.55) 0%, rgba(5,6,15,0) 70%)' }]} pointerEvents="none" />
      <View style={[styles.foam, { left: RL + 20, top: 317, width: 47 }]} pointerEvents="none" />
      <View style={[styles.foam, { left: RL + 180, top: 317, width: 62 }]} pointerEvents="none" />
      <View style={[styles.foam, { left: RL - 13, top: 317, width: 286, backgroundColor: 'transparent', experimental_backgroundImage: 'linear-gradient(90deg, rgba(124,200,255,0), rgba(124,200,255,0.3), rgba(124,200,255,0))' }]} pointerEvents="none" />
      <Animated.View style={[styles.ring, { left: RL + 5, top: 304 }, ring1Style]} pointerEvents="none" />
      <Animated.View style={[styles.ring, { left: RL + 5, top: 304 }, ring2Style]} pointerEvents="none" />
      <View style={[styles.backlight, { left: 0, top: 0, width, height: STAGE_H + WATER_H, experimental_backgroundImage: 'radial-gradient(ellipse 75% 70% at 50% 62%, transparent 45%, rgba(4,6,16,0.4) 100%)' }]} pointerEvents="none" />
      <Animated.View
        ref={catRef}
        onLayout={() => catRef.current?.measureInWindow((x, y, w, h) => onCatRect?.({ x, y, width: w, height: h }))}
        style={[styles.cat, { left: (width - CAT_SIZE) / 2, top: CAT_TOP, transformOrigin: '50% 100%' }, dipStyle]}>
        <BlinkEnabled.Provider value>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={t('wardrobe.pet')}
            onPress={() => {
              void hapticSelection();
              setPetKey((k) => k + 1);
            }}>
            <CatAvatar size={CAT_SIZE} equipped={equipped} preview={preview} petKey={petKey} gaze={gaze} />
          </Pressable>
        </BlinkEnabled.Provider>
      </Animated.View>
    </View>
  );
}

const styles = StyleSheet.create({
  sky: { position: 'absolute', left: 0, right: 0, top: 0 },
  star: { position: 'absolute', width: 2, height: 2, borderRadius: 1, backgroundColor: '#F4F2F8' },
  glow: { position: 'absolute', width: 380, height: 380, borderRadius: 190 },
  backlight: { position: 'absolute' },
  halo: { position: 'absolute', width: 136, height: 136, borderRadius: 68 },
  moon: { position: 'absolute', width: 64, height: 64, borderRadius: 32 },
  hills: { position: 'absolute', left: 0, right: 0, height: 74, overflow: 'hidden' },
  water: { position: 'absolute', left: 0, right: 0, height: WATER_H },
  line: { position: 'absolute', left: 30, right: 30, height: 1.5 },
  reflection: { position: 'absolute', width: 220, height: 14, borderTopLeftRadius: 7, borderTopRightRadius: 7 },
  flowClip: { position: 'absolute', left: 0, right: 0, height: WATER_H, overflow: 'hidden' },
  flowGroup: { position: 'absolute', left: -7, top: 0, height: WATER_H },
  band: { position: 'absolute', height: 1.2, borderRadius: 1 },
  contact: { position: 'absolute', width: 120, height: 9 },
  foam: { position: 'absolute', height: 1.2, backgroundColor: 'rgba(124,200,255,0.3)' },
  ring: { position: 'absolute', width: 250, height: 26, borderRadius: 13, borderWidth: 1, borderColor: 'rgba(124,200,255,1)', opacity: 0 },
  cat: { position: 'absolute', width: CAT_SIZE, height: (240 * CAT_SIZE) / 200 },
});
