import { useEffect, useState } from 'react';
import { Platform, StyleSheet, useWindowDimensions } from 'react-native';
import Animated, {
  cancelAnimation,
  Easing,
  interpolate,
  runOnJS,
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
  withTiming,
} from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { fonts } from '@/constants/fonts';
import { Spacing, tide } from '@/constants/theme';
import { finish, subscribe, type MorphState } from '@/lib/card-morph';
import { useSkyStyle } from '@/lib/sky';

const MORPH_MS = 380;
const REVEAL_MS = 160;
const BACK_MS = 320;
const COVER_MS = 120;
const HEADER_TITLE_Y = Platform.select({ ios: 22, default: 28 });
const MORPH_EASING = Easing.bezier(0.2, 0.8, 0.2, 1);
const TITLE_SCALE_TARGET = 14 / 17;

/**
 * Renders the card-to-player morph above the router `Stack`. Idle, it
 * renders nothing (no view at all, so it never intercepts touches); while a
 * morph is running it covers the screen and swallows taps so a double tap or
 * a mid-flight back press does nothing.
 */
export function CardMorphOverlay() {
  const [state, setState] = useState<MorphState | null>(null);
  const reducedMotion = useReducedMotion();
  const { width: winW, height: winH } = useWindowDimensions();
  const insets = useSafeAreaInsets();
  const sky = useSkyStyle();

  const t = useSharedValue(0);
  const overlayOpacity = useSharedValue(0);
  const titleWidth = useSharedValue(0);

  useEffect(() => subscribe(setState), []);

  // No morph animation or its completion callback may outlive the overlay.
  useEffect(
    () => () => {
      cancelAnimation(t);
      cancelAnimation(overlayOpacity);
    },
    [t, overlayOpacity],
  );

  useEffect(() => {
    if (!state) return;
    if (reducedMotion) {
      // The route's own 'fade' is the whole effect; just release the lock.
      finish();
      return;
    }
    cancelAnimation(t);
    cancelAnimation(overlayOpacity);
    if (state.phase === 'open') {
      overlayOpacity.value = 1;
      t.value = withTiming(1, { duration: MORPH_MS, easing: MORPH_EASING }, (openFinished) => {
        if (!openFinished) return;
        overlayOpacity.value = withTiming(0, { duration: REVEAL_MS }, (revealFinished) => {
          if (revealFinished) runOnJS(finish)();
        });
      });
    } else {
      overlayOpacity.value = withTiming(1, { duration: COVER_MS }, (coverFinished) => {
        if (!coverFinished) return;
        t.value = withTiming(0, { duration: BACK_MS, easing: MORPH_EASING }, (backFinished) => {
          if (!backFinished) return;
          overlayOpacity.value = withTiming(0, { duration: REVEAL_MS }, (revealFinished) => {
            if (revealFinished) runOnJS(finish)();
          });
        });
      });
    }
  }, [state, reducedMotion, t, overlayOpacity]);

  const rect = state?.rect ?? { x: winW / 2, y: winH / 2, width: 0, height: 0 };
  const title = state?.title ?? '';

  const boxStyle = useAnimatedStyle(() => ({
    left: interpolate(t.value, [0, 1], [rect.x, 0]),
    top: interpolate(t.value, [0, 1], [rect.y, 0]),
    width: interpolate(t.value, [0, 1], [rect.width, winW]),
    height: interpolate(t.value, [0, 1], [rect.height, winH]),
  }));

  const cardLayerStyle = useAnimatedStyle(() => ({
    opacity: interpolate(t.value, [0, 0.2, 0.8], [0.16, 0.16, 0]),
  }));

  const borderStyle = useAnimatedStyle(() => ({
    opacity: interpolate(t.value, [0, 0.33], [1, 0]),
  }));

  const overlayStyle = useAnimatedStyle(() => ({ opacity: overlayOpacity.value }));

  const skyLayerStyle = useAnimatedStyle(() => ({
    opacity: interpolate(t.value, [0.2, 0.8], [0, 1]),
  }));

  const titleStyle = useAnimatedStyle(() => {
    const scale = interpolate(t.value, [0, 1], [1, TITLE_SCALE_TARGET]);
    const fromX = rect.x;
    const toX = winW / 2 - (titleWidth.value * TITLE_SCALE_TARGET) / 2;
    const fromY = rect.y + Spacing.md;
    const toY = insets.top + (HEADER_TITLE_Y ?? 22);
    return {
      transform: [
        { translateX: interpolate(t.value, [0, 1], [fromX, toX]) },
        { translateY: interpolate(t.value, [0, 1], [fromY, toY]) },
        { scale },
      ],
    };
  });

  if (!state || reducedMotion) return null;

  return (
    <Animated.View pointerEvents="auto" style={[StyleSheet.absoluteFill, overlayStyle]}>
      <Animated.View style={[styles.box, boxStyle]}>
        <Animated.View style={[StyleSheet.absoluteFill, styles.cardLayer, cardLayerStyle]} />
        <Animated.View style={[styles.cardBorder, borderStyle]} />
        <Animated.View style={[StyleSheet.absoluteFill, skyLayerStyle]}>
          <Animated.View style={[StyleSheet.absoluteFill, sky.from]} />
        </Animated.View>
      </Animated.View>
      <Animated.Text
        numberOfLines={1}
        onLayout={(event) => {
          titleWidth.value = event.nativeEvent.layout.width;
        }}
        style={[styles.title, titleStyle]}>
        {title}
      </Animated.Text>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  box: { position: 'absolute', overflow: 'hidden' },
  cardLayer: { backgroundColor: tide.water },
  cardBorder: {
    position: 'absolute',
    left: 0,
    right: 0,
    top: 0,
    height: 1,
    backgroundColor: tide.waterline,
  },
  title: {
    position: 'absolute',
    left: 0,
    top: 0,
    fontFamily: fonts.serifJp,
    fontSize: 17,
    fontWeight: '600',
    color: tide.text,
  },
});
