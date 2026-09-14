import { type ReactNode, useEffect } from 'react';
import { type LayoutChangeEvent, Platform, StyleSheet, Text, View } from 'react-native';
import Animated, { Easing, useAnimatedStyle, useSharedValue, withTiming } from 'react-native-reanimated';

import { fonts } from '@/constants/fonts';
import { tide } from '@/constants/theme';

type Props = {
  lineIndex: number;
  lineCount: number;
  /** Seconds left in the breath, giant faded number; null hides it. */
  countdown: number | null;
  banner?: ReactNode;
  /** Sits on the waterline, bottom-anchored. */
  sentence: ReactNode;
  /** The same words again, drawn upside down under the waterline, never tappable. */
  reflection?: ReactNode;
  /** Under the reflection: English toggle, PhraseBar. */
  below?: ReactNode;
};

/**
 * The Tide player scene: a sentence on a waterline over its own reflection,
 * tide marks down the left edge and a giant faded countdown mid-screen
 * during the breath. Pure layout, no engine knowledge: the screen owns
 * playback and passes the rendered slots in.
 */
export function TideScene({ lineIndex, lineCount, countdown, banner, sentence, reflection, below }: Props) {
  const height = useSharedValue(0);
  const wl = useSharedValue(waterlineFraction(lineIndex, lineCount));

  useEffect(() => {
    wl.value = withTiming(waterlineFraction(lineIndex, lineCount), {
      duration: 800,
      easing: Easing.out(Easing.cubic),
    });
  }, [lineIndex, lineCount, wl]);

  const onLayout = (e: LayoutChangeEvent) => {
    height.value = e.nativeEvent.layout.height;
  };

  const waterStyle = useAnimatedStyle(() => ({ top: wl.value * height.value }));
  const aboveStyle = useAnimatedStyle(() => ({ bottom: height.value - wl.value * height.value }));
  const belowStyle = useAnimatedStyle(() => ({ top: wl.value * height.value }));

  return (
    <View style={styles.fill} onLayout={onLayout}>
      <View style={[StyleSheet.absoluteFill, styles.sky]}>
        {banner}
      </View>
      <Animated.View style={[styles.water, waterStyle]} />
      <Animated.View style={[styles.above, aboveStyle]}>{sentence}</Animated.View>
      <Animated.View style={[styles.below, belowStyle]}>
        <View style={styles.reflectionWrap} pointerEvents="none">
          {reflection}
          <View style={[StyleSheet.absoluteFill, styles.reflectionFade]} />
        </View>
        {below}
      </Animated.View>
      {countdown !== null ? (
        <View style={[StyleSheet.absoluteFill, styles.countdownWrap]} pointerEvents="none">
          <Text style={styles.countdown}>{countdown}</Text>
        </View>
      ) : null}
      <View style={styles.marks} pointerEvents="none">
        {Array.from({ length: lineCount }, (_, i) => lineCount - 1 - i).map((i) => (
          <View
            key={i}
            style={[
              styles.mark,
              i < lineIndex ? styles.markDone : i === lineIndex ? styles.markNow : styles.markPending,
            ]}
          />
        ))}
      </View>
    </View>
  );
}

/** design: `--wl: 62 - t*5%` (t on a 0..4 scale here becomes lineIndex / (lineCount-1)). */
function waterlineFraction(lineIndex: number, lineCount: number) {
  return 0.62 - 0.2 * (lineIndex / Math.max(1, lineCount - 1));
}

const styles = StyleSheet.create({
  fill: { flex: 1, overflow: 'hidden' },
  sky: { experimental_backgroundImage: 'linear-gradient(180deg, #070A12, #101A2A 60%, #16243A)' },
  water: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    experimental_backgroundImage: 'linear-gradient(180deg, rgba(255,158,128,0.2), #08131C 30%, #050A10)',
    borderTopWidth: 1,
    borderTopColor: tide.waterline,
  },
  above: {
    position: 'absolute',
    left: 0,
    right: 0,
    top: 0,
    justifyContent: 'flex-end',
    paddingLeft: 28,
    paddingRight: 88,
    paddingBottom: 10,
    zIndex: 3,
  },
  below: {
    position: 'absolute',
    left: 0,
    right: 0,
    paddingLeft: 28,
    paddingRight: 88,
    paddingTop: 8,
    zIndex: 2,
  },
  reflectionWrap: {
    transform: [{ scaleY: -1 }],
    opacity: 0.3,
    ...Platform.select({ android: { filter: [{ blur: 1 }] }, default: {} }),
  },
  reflectionFade: {
    experimental_backgroundImage: 'linear-gradient(0deg, transparent, #08131C 85%)',
  },
  countdownWrap: {
    alignItems: 'center',
    justifyContent: 'center',
    zIndex: 1,
  },
  countdown: {
    fontFamily: fonts.serifLight,
    fontSize: 200,
    lineHeight: 210,
    color: 'rgba(255,158,128,0.18)',
    fontVariant: ['tabular-nums'],
  },
  marks: {
    position: 'absolute',
    left: 10,
    top: '40%',
    bottom: '34%',
    flexDirection: 'column',
    justifyContent: 'space-between',
  },
  mark: { width: 14, height: 2, borderRadius: 1, backgroundColor: 'rgba(255,255,255,0.2)' },
  markPending: {},
  markDone: {
    backgroundColor: tide.lang.ja,
    boxShadow: '0 0 8px rgba(255,158,128,0.8)',
  },
  markNow: { backgroundColor: tide.text, width: 18 },
});
