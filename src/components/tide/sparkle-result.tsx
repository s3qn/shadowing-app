import { useEffect } from 'react';
import { StyleSheet, Text } from 'react-native';
import Animated, { useAnimatedStyle, useReducedMotion, useSharedValue, withDelay, withTiming } from 'react-native-reanimated';

import { fonts } from '@/constants/fonts';
import { tide } from '@/constants/theme';
import { hapticImpact } from '@/lib/haptics';
import type { ResultTier } from '@/lib/takes';

const LABEL: Record<ResultTier, string> = {
  great: 'ぴったり!',
  good: 'いいね',
  retry: 'もう一回',
};

const TIER_COLOR: Record<ResultTier, string> = {
  great: tide.lang.ja,
  good: tide.text,
  retry: tide.textDim,
};

export type SparkleResultData = { id: number; tier: ResultTier; label?: string } | null;

type SparkleResultProps = {
  result: SparkleResultData;
};

/**
 * A sparkle and a big Japanese word that rise and fade over the sentence area
 * at the end of an Auto Echo Play step. Fires a light haptic and restarts its
 * animation whenever `result.id` changes, purely decorative: pointerEvents
 * are off, so it never steals a tap from Stop or Retry underneath.
 */
export function SparkleResult({ result }: SparkleResultProps) {
  const reducedMotion = useReducedMotion();

  const sparkleOpacity = useSharedValue(0);
  const sparkleY = useSharedValue(0);
  const wordOpacity = useSharedValue(0);
  const wordY = useSharedValue(0);

  const sparkleStyle = useAnimatedStyle(() => ({
    opacity: sparkleOpacity.value,
    transform: [{ translateY: sparkleY.value }],
  }));
  const wordStyle = useAnimatedStyle(() => ({
    opacity: wordOpacity.value,
    transform: [{ translateY: wordY.value }],
  }));

  useEffect(() => {
    if (!result) return;

    void hapticImpact();

    if (reducedMotion) {
      sparkleY.value = 0;
      wordY.value = 0;
      sparkleOpacity.value = withTiming(1, { duration: 200 }, (finished) => {
        if (finished) sparkleOpacity.value = withDelay(1100, withTiming(0, { duration: 300 }));
      });
      wordOpacity.value = withDelay(
        120,
        withTiming(1, { duration: 200 }, (finished) => {
          if (finished) wordOpacity.value = withDelay(950, withTiming(0, { duration: 300 }));
        }),
      );
      return;
    }

    sparkleOpacity.value = 0;
    sparkleY.value = 0;
    wordOpacity.value = 0;
    wordY.value = 0;

    // Total visible time is about 1.6s: an appear, a hold, then a fade.
    sparkleOpacity.value = withTiming(1, { duration: 200 }, (finished) => {
      if (finished) sparkleOpacity.value = withDelay(1100, withTiming(0, { duration: 300 }));
    });
    sparkleY.value = withTiming(-18, { duration: 1600 });

    wordOpacity.value = withDelay(
      150,
      withTiming(1, { duration: 200 }, (finished) => {
        if (finished) wordOpacity.value = withDelay(950, withTiming(0, { duration: 300 }));
      }),
    );
    wordY.value = withDelay(150, withTiming(-28, { duration: 1450 }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [result?.id]);

  if (!result) return null;

  return (
    <Animated.View style={styles.wrap} pointerEvents="none">
      <Animated.Text style={[styles.sparkle, sparkleStyle]}>✨</Animated.Text>
      <Animated.Text style={[styles.word, wordStyle, { color: TIER_COLOR[result.tier] }]}>
        {result.label ?? LABEL[result.tier]}
      </Animated.Text>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  wrap: {
    position: 'absolute',
    left: 0,
    right: 0,
    top: 0,
    bottom: 0,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
  },
  sparkle: { fontSize: 24, color: tide.turn },
  word: { fontFamily: fonts.serifJp, fontSize: 34 },
});
