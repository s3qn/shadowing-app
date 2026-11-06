// A label with the iOS "thinking" shimmer: a soft light band sweeps across dim letters.
// The RN <Text> stays in layout as an invisible sizer (so width, height and RTL shaping
// are the label's own); a Skia canvas fills its box and draws the same text twice from
// one paragraph, dim, then bright through a moving alpha band. Web and reduced motion
// get the plain dim label.
import { useEffect, useMemo, useState } from 'react';
import { type LayoutChangeEvent, Platform, StyleSheet, Text, type TextStyle } from 'react-native';
import { Canvas, LinearGradient, Mask, Paragraph, Rect, Skia, TextAlign, vec } from '@shopify/react-native-skia';
import Animated, {
  Easing,
  cancelAnimation,
  useAnimatedStyle,
  useDerivedValue,
  useReducedMotion,
  useSharedValue,
  withDelay,
  withRepeat,
  withSequence,
  withTiming,
} from 'react-native-reanimated';

import { tide } from '@/constants/theme';
import { useDir } from '@/lib/i18n';

type Props = { children: string; style: TextStyle; bandColor?: string };

const SWEEP_MS = 1400;
const PAUSE_MS = 500;
const BAND = 0.4;

function Plain({ children, style }: Props) {
  return <Text style={[style, { color: tide.textDim }]}>{children}</Text>;
}

function Shimmer({ children, style, bandColor = tide.text }: Props) {
  const rtl = useDir().rtl;
  const [box, setBox] = useState({ w: 0, h: 0 });
  const w = box.w;
  const h = box.h;
  const fontSize = typeof style.fontSize === 'number' ? style.fontSize : 14;
  const family = String(style.fontFamily ?? 'System');

  const p = useSharedValue(0);
  const o = useSharedValue(0);

  useEffect(() => {
    o.value = withTiming(1, { duration: 150, easing: Easing.out(Easing.quad) });
    p.value = 0;
    p.value = withRepeat(
      withSequence(
        withTiming(1, { duration: SWEEP_MS, easing: Easing.inOut(Easing.quad) }),
        withDelay(PAUSE_MS, withTiming(0, { duration: 0 })),
      ),
      -1,
    );
    return () => {
      cancelAnimation(p);
      cancelAnimation(o);
    };
  }, [p, o]);

  const fade = useAnimatedStyle(() => ({ opacity: o.value }));

  const build = (color: string) => {
    const b = Skia.ParagraphBuilder.Make({ textAlign: TextAlign.Center });
    b.pushStyle({ color: Skia.Color(color), fontSize, fontFamilies: [family] });
    b.addText(children);
    const para = b.build();
    para.layout(Math.max(w, 1));
    return para;
  };
  const dim = useMemo(() => (w > 0 ? build(tide.textDim) : null), [children, fontSize, family, w]); // eslint-disable-line react-hooks/exhaustive-deps
  const bright = useMemo(() => (w > 0 ? build(bandColor) : null), [children, fontSize, family, w, bandColor]); // eslint-disable-line react-hooks/exhaustive-deps

  const half = (w * BAND) / 2;
  const from = (rtl ? 1.2 : -0.2) * w;
  const to = (rtl ? -0.2 : 1.2) * w;
  const start = useDerivedValue(() => {
    const c = from + (to - from) * p.value;
    return vec(c - half, 0);
  });
  const end = useDerivedValue(() => {
    const c = from + (to - from) * p.value;
    return vec(c + half, 0);
  });

  // Vertically centre the paragraph in the sizer box.
  const top = dim ? Math.max(0, (h - dim.getHeight()) / 2) : 0;

  const onLayout = (e: LayoutChangeEvent) => {
    const { width, height } = e.nativeEvent.layout;
    if (Math.abs(width - w) > 0.5 || Math.abs(height - h) > 0.5) setBox({ w: width, h: height });
  };

  return (
    <Animated.View style={fade}>
      <Text style={[style, styles.sizer]} onLayout={onLayout}>
        {children}
      </Text>
      {dim && bright ? (
        <Canvas style={StyleSheet.absoluteFill} pointerEvents="none">
          <Paragraph paragraph={dim} x={0} y={top} width={w} />
          <Mask
            mode="alpha"
            mask={
              <Rect x={0} y={0} width={w} height={h}>
                <LinearGradient start={start} end={end} colors={['#00000000', '#000000FF', '#00000000']} positions={[0, 0.5, 1]} />
              </Rect>
            }>
            <Paragraph paragraph={bright} x={0} y={top} width={w} />
          </Mask>
        </Canvas>
      ) : (
        // Until the first measure, show the plain label so nothing blinks.
        <Text style={[style, styles.fill, { color: tide.textDim }]}>{children}</Text>
      )}
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  sizer: { color: 'transparent' },
  fill: { position: 'absolute', left: 0, right: 0, textAlign: 'center' },
});

const Impl = Platform.select<React.ComponentType<Props>>({ ios: Shimmer, android: Shimmer, default: Plain }) ?? Plain;

export function ShimmerText(props: Props) {
  const reduced = useReducedMotion();
  return reduced ? <Plain {...props} /> : <Impl {...props} />;
}
