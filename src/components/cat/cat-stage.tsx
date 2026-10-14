import { useEffect, useState } from 'react';
import { Pressable, StyleSheet, useWindowDimensions, View } from 'react-native';
import Animated, { cancelAnimation, useAnimatedStyle, useReducedMotion, useSharedValue, withSequence, withSpring, withTiming } from 'react-native-reanimated';

import { CatAvatar, type CatAvatarProps } from '@/components/cat/cat-avatar';
import { BlinkEnabled } from '@/lib/cat-blink';
import { hapticSelection } from '@/lib/haptics';
import { useT } from '@/lib/i18n';

export type CatStageProps = Pick<CatAvatarProps, 'equipped' | 'preview'> & {
  /** Bump this to play the landing dip after an equip or a buy. */
  dipKey?: number;
};

/** Sky and mountains end at the waterline; the water strip runs 32px below it into the page. */
export const STAGE_H = 304;
export const WATER_H = 32;
const CAT_SIZE = 184;
const CAT_TOP = STAGE_H - (232 * CAT_SIZE) / 200;

const PAGE = '#0B1020';
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
export function CatStage({ equipped, preview, dipKey = 0 }: CatStageProps) {
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
  return (
    <View style={{ width, height: STAGE_H + WATER_H }} pointerEvents="box-none">
      <View style={[styles.sky, { height: STAGE_H, experimental_backgroundImage: 'linear-gradient(180deg, #080b1c 0%, #131a40 55%, #262c63 100%)' }]} />
      {STARS.map(([x, y, a], i) => (
        <View key={i} style={[styles.star, { left: x * width, top: y, opacity: a }]} />
      ))}
      <View style={[styles.glow, { left: (width - 380) / 2, top: CAT_TOP - 60, experimental_backgroundImage: 'radial-gradient(circle, rgba(244,242,248,0.22) 0%, rgba(124,200,255,0.12) 38%, transparent 70%)' }]} />
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
      <View style={[styles.water, { top: STAGE_H, experimental_backgroundImage: `linear-gradient(180deg, #1b2350, #0f1535 55%, ${PAGE})` }]} />
      <View style={[styles.line, { top: STAGE_H - 1, experimental_backgroundImage: 'linear-gradient(90deg, transparent, rgba(244,242,248,0.85), transparent)' }]} />
      <Animated.View style={[styles.cat, { left: (width - CAT_SIZE) / 2, top: CAT_TOP, transformOrigin: '50% 100%' }, dipStyle]}>
        <BlinkEnabled.Provider value>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={t('wardrobe.pet')}
            onPress={() => {
              void hapticSelection();
              setPetKey((k) => k + 1);
            }}>
            <CatAvatar size={CAT_SIZE} equipped={equipped} preview={preview} petKey={petKey} />
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
  halo: { position: 'absolute', width: 136, height: 136, borderRadius: 68 },
  moon: { position: 'absolute', width: 64, height: 64, borderRadius: 32 },
  hills: { position: 'absolute', left: 0, right: 0, height: 74, overflow: 'hidden' },
  water: { position: 'absolute', left: 0, right: 0, height: WATER_H },
  line: { position: 'absolute', left: 30, right: 30, height: 1.5 },
  cat: { position: 'absolute', width: CAT_SIZE, height: (240 * CAT_SIZE) / 200 },
});
