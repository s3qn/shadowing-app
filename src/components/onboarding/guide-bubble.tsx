import { Image } from 'expo-image';
import { useEffect } from 'react';
import { StyleSheet, Text, View, useWindowDimensions } from 'react-native';
import Animated, {
  Easing,
  type SharedValue,
  cancelAnimation,
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
  withRepeat,
  withTiming,
} from 'react-native-reanimated';

import { fonts } from '@/constants/fonts';
import { tide } from '@/constants/theme';
import { useDir } from '@/lib/i18n';

import bubbles from '../../../assets/images/guide/guide-bubbles.json';

const ART = {
  welcome: require('../../../assets/images/guide/guide-welcome.png'),
  listen: require('../../../assets/images/guide/guide-listen.png'),
  record: require('../../../assets/images/guide/guide-record.png'),
  proud: require('../../../assets/images/guide/guide-proud.png'),
  levelup: require('../../../assets/images/guide/guide-levelup.png'),
} as const;

export type GuideKind = keyof typeof ART;

/** The welcome step drives the art from its own clock: the bubble rises on
 * its own while the cat nudges, so the picture is drawn as two layers. */
export type GuideMotion = {
  /** 0 hidden to 1 settled: the bubble's fade and 12 pt rise. */
  bubble: SharedValue<number>;
  /** The cat's scale, about its feet. */
  catScale: SharedValue<number>;
  /** The cat's lift in pt (negative is up). */
  catY: SharedValue<number>;
  /** Where the picture splits into the cat (before it) and the bubble, as a fraction of its width. */
  split: number;
};

const SIDE = 14;
/** The "more to say" dots: 4 pt each, 3 pt apart, pulsing 0.4 to 1 over 900 ms each way. */
const DOT = 4;
const DOT_GAP = 3;
const CUE_MS = 900;

/**
 * Kageneko with an empty speech bubble, the words laid into the bubble's text
 * rectangle (fractions of the picture, from guide-bubbles.json). The art is
 * never mirrored: in Hebrew only the text aligns to the right.
 */
export function GuideBubble({
  kind,
  text,
  fontSize = 15,
  width,
  more = false,
  motion,
}: {
  kind: GuideKind;
  text: string;
  fontSize?: number;
  /** Bubble width; defaults to the screen minus 14pt a side. */
  width?: number;
  /** More lines follow: three pulsing dots in the text's trailing bottom corner say "tap to go on". */
  more?: boolean;
  /** Drive the entrance from outside (the welcome step); by default the whole picture rises in over 260 ms. */
  motion?: GuideMotion;
}) {
  const dir = useDir();
  const { width: screenW } = useWindowDimensions();
  const spec = bubbles[kind];
  const w = Math.max(0, width ?? screenW - 2 * SIDE);
  const h = (w * spec.size[1]) / spec.size[0];
  const [l, t, r, b] = spec.text;
  const lineHeight = Math.round(fontSize * 1.35);
  // Whole lines only: the line height cannot shrink, so a line past the rect would be drawn and cut.
  const lines = Math.max(1, Math.floor(((b - t) * h) / lineHeight));

  const own = useSharedValue(0);
  const one = useSharedValue(1);
  const zero = useSharedValue(0);
  useEffect(() => {
    if (motion) return;
    own.value = withTiming(1, { duration: 260, easing: Easing.out(Easing.cubic) });
  }, [own, motion]);
  const bubbleV = motion ? motion.bubble : own;
  const catScale = motion ? motion.catScale : one;
  const catY = motion ? motion.catY : zero;
  const style = useAnimatedStyle(() => {
    const v = Number.isFinite(bubbleV.value) ? bubbleV.value : 1;
    return { opacity: v, transform: [{ translateY: (1 - v) * 12 }] };
  });
  const catStyle = useAnimatedStyle(() => ({
    transform: [
      { translateY: Number.isFinite(catY.value) ? catY.value : 0 },
      { scale: Number.isFinite(catScale.value) ? catScale.value : 1 },
    ],
  }));

  const words = (offX: number) => (
    <View style={[styles.rect, { left: l * w - offX, top: t * h, width: (r - l) * w, height: (b - t) * h }]}>
      <Text
        style={[styles.text, { fontSize, lineHeight }, dir.text]}
        numberOfLines={lines}
        adjustsFontSizeToFit
        minimumFontScale={Math.min(1, 12 / fontSize)}>
        {text}
      </Text>
    </View>
  );
  const cue = more ? <MoreCue top={b * h - DOT / 2} side={dir.rtl ? { left: l * w } : { right: (1 - r) * w }} /> : null;

  if (!motion) {
    return (
      <Animated.View style={[{ width: w, height: h }, style]}>
        <Image source={ART[kind]} style={StyleSheet.absoluteFill} contentFit="fill" />
        {words(0)}
        {cue}
      </Animated.View>
    );
  }
  const split = motion.split * w;
  // The cat scales about the point the mock uses, 45 % of the whole picture, at its feet.
  const origin = `${Math.round((0.45 / motion.split) * 100)}% 100%`;
  return (
    <View style={{ width: w, height: h }}>
      <Animated.View style={[styles.layer, { left: 0, width: split, height: h, transformOrigin: origin }, catStyle]}>
        <Image source={ART[kind]} style={{ position: 'absolute', left: 0, top: 0, width: w, height: h }} contentFit="fill" />
      </Animated.View>
      <Animated.View style={[styles.layer, { left: split, width: w - split, height: h }, style]}>
        <Image source={ART[kind]} style={{ position: 'absolute', left: -split, top: 0, width: w, height: h }} contentFit="fill" />
        {words(split)}
      </Animated.View>
      {cue}
    </View>
  );
}

function MoreCue({ top, side }: { top: number; side: { left: number } | { right: number } }) {
  const reduced = useReducedMotion();
  const pulse = useSharedValue(reduced ? 0.7 : 0.4);
  useEffect(() => {
    if (reduced) return;
    pulse.value = withRepeat(withTiming(1, { duration: CUE_MS, easing: Easing.inOut(Easing.ease) }), -1, true);
    return () => cancelAnimation(pulse);
  }, [reduced, pulse]);
  const style = useAnimatedStyle(() => ({ opacity: Number.isFinite(pulse.value) ? pulse.value : 1 }));
  return (
    <Animated.View style={[styles.cue, { top }, side, style]} pointerEvents="none">
      <View style={styles.dot} />
      <View style={styles.dot} />
      <View style={styles.dot} />
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  cue: { position: 'absolute', flexDirection: 'row', gap: DOT_GAP },
  dot: { width: DOT, height: DOT, borderRadius: DOT / 2, backgroundColor: tide.text },
  layer: { position: 'absolute', top: 0, overflow: 'hidden' },
  rect: { position: 'absolute', justifyContent: 'center' },
  text: { maxHeight: '100%', fontFamily: fonts.uiMedium, color: tide.text },
});
