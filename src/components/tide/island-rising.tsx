import { useEffect, useRef, useState } from 'react';
import { type LayoutChangeEvent, StyleSheet, View } from 'react-native';
import { useIsFocused } from 'expo-router';
import { BlurMask, Canvas, Circle, Group, LinearGradient, Path, Rect, RoundedRect, vec } from '@shopify/react-native-skia';
import { cancelAnimation, Easing, useDerivedValue, useReducedMotion, useSharedValue, withRepeat, withSpring, withTiming, type SharedValue } from 'react-native-reanimated';

import { tideWaters } from '@/constants/theme';
import { currentPeriod } from '@/lib/sky';

/** Build stages the record screen polls, in the order the server reports
 * them, plus the terminal `ready` state right before it navigates away. */
export type BuildStage = 'queued' | 'transcribing' | 'writing' | 'speaking' | 'ready' | string;

const BUILD_ORDER: readonly string[] = ['queued', 'transcribing', 'writing', 'speaking'];

/** Sand mound, rock, then the lighthouse: the last piece is held back until
 * the island is actually `ready`, so it never appears mid build. */
const PIECE_COUNT = 3;

/** How far below the water line an un-risen piece sits, in canvas px. Deep
 * enough that the water fill hides every piece fully. */
const SUBMERGE_DEPTH = 60;

const SCENE_H = 170;

/** Maps a poll stage onto the piece that should be visible, holding the
 * final piece back for `ready`. With no numeric progress from the server,
 * the stage string itself is the progress signal. */
function pieceIndexFor(stage: string): number {
  if (stage === 'ready') return PIECE_COUNT - 1;
  const i = BUILD_ORDER.indexOf(stage);
  const clamped = i < 0 ? 0 : i;
  return Math.min(PIECE_COUNT - 2, Math.floor((clamped / BUILD_ORDER.length) * (PIECE_COUNT - 1)));
}

/** One rising piece: emerges from below the water line by translating up
 * (motion) or by fading in place (reduced motion), never both. */
function useRise(target: boolean, reducedMotion: boolean) {
  const rise = useSharedValue(0);
  useEffect(() => {
    const to = target ? 1 : 0;
    rise.value = reducedMotion
      ? withTiming(to, { duration: 350, easing: Easing.out(Easing.cubic) })
      : withSpring(to, { damping: 15, stiffness: 110 });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [target, reducedMotion]);
  return rise;
}

type Props = {
  stage: BuildStage;
};

/**
 * Small build progress scene for the record screen: dark Tide water at the
 * bottom, an island rising out of it piece by piece as the build advances.
 * Pauses when the screen loses focus. Under reduced motion the pieces fade
 * in at rest instead of rising, and the splash rings never draw.
 */
export function IslandRising({ stage }: Props) {
  const [width, setWidth] = useState(0);
  const isFocused = useIsFocused();
  const reducedMotion = useReducedMotion();
  const period = currentPeriod(new Date());
  const palette = tideWaters[period];

  const pieceIndex = pieceIndexFor(stage);
  const rise0 = useRise(pieceIndex >= 0, reducedMotion);
  const rise1 = useRise(pieceIndex >= 1, reducedMotion);
  const rise2 = useRise(pieceIndex >= 2, reducedMotion);
  const glow = useSharedValue(0);
  const splash = useSharedValue(0);
  const bob = useSharedValue(0);

  const prevIndexRef = useRef(-1);
  useEffect(() => {
    if (pieceIndex > prevIndexRef.current && !reducedMotion) {
      splash.value = 0;
      splash.value = withTiming(1, { duration: 700, easing: Easing.out(Easing.cubic) });
    }
    prevIndexRef.current = pieceIndex;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pieceIndex, reducedMotion]);

  useEffect(() => {
    glow.value = withTiming(pieceIndex >= PIECE_COUNT - 1 ? 1 : 0, { duration: 500 });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pieceIndex]);

  // Gentle bobbing on a slow swell. Off entirely under reduced motion, and
  // paused whenever the screen is not focused.
  useEffect(() => {
    if (reducedMotion || !isFocused) {
      cancelAnimation(bob);
      bob.value = withTiming(0, { duration: 300 });
      return;
    }
    bob.value = withRepeat(withTiming(1, { duration: 2200, easing: Easing.inOut(Easing.sin) }), -1, true);
    return () => {
      cancelAnimation(bob);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reducedMotion, isFocused]);

  const bobPlace = useDerivedValue(() => [{ translateY: -3 + bob.value * 6 }]);

  function useSubmergeOffset(rise: SharedValue<number>) {
    return useDerivedValue(() => {
      const v = Number.isFinite(rise.value) ? rise.value : 0;
      return reducedMotion ? 0 : (1 - v) * SUBMERGE_DEPTH;
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [reducedMotion]);
  }
  function useFadeOpacity(rise: SharedValue<number>) {
    return useDerivedValue(() => {
      const v = Number.isFinite(rise.value) ? rise.value : 0;
      return reducedMotion ? v : 1;
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [reducedMotion]);
  }

  const mound0 = useSubmergeOffset(rise0);
  const mound0Opacity = useFadeOpacity(rise0);
  const rock1 = useSubmergeOffset(rise1);
  const rock1Opacity = useFadeOpacity(rise1);
  const tower2 = useSubmergeOffset(rise2);
  const tower2Opacity = useFadeOpacity(rise2);

  const mound0Place = useDerivedValue(() => [{ translateY: mound0.value }]);
  const rock1Place = useDerivedValue(() => [{ translateY: rock1.value }]);
  const tower2Place = useDerivedValue(() => [{ translateY: tower2.value }]);

  const splashRingR = useDerivedValue(() => {
    const t = Number.isFinite(splash.value) ? splash.value : 0;
    return 6 + t * 26;
  });
  const splashRingOpacity = useDerivedValue(() => {
    const t = Number.isFinite(splash.value) ? splash.value : 0;
    return Math.max(0, 0.45 * (1 - t));
  });

  const glowRadius = useDerivedValue(() => 3 + glow.value * 6);
  const glowOpacity = useDerivedValue(() => 0.25 + glow.value * 0.6);

  const onLayout = (e: LayoutChangeEvent) => setWidth(e.nativeEvent.layout.width);

  const waterTop = SCENE_H * 0.62;
  const cx = width / 2;

  return (
    <View style={styles.wrap} onLayout={onLayout}>
      {width > 0 ? (
        <Canvas style={{ width, height: SCENE_H }}>
          <Group transform={bobPlace}>
            <Group transform={mound0Place}>
              <RoundedRect
                x={cx - 48}
                y={waterTop - 16}
                width={96}
                height={30}
                r={15}
                color="#C9A868"
                opacity={mound0Opacity}
              />
            </Group>
            <Group transform={rock1Place}>
              <RoundedRect
                x={cx - 20}
                y={waterTop - 30}
                width={40}
                height={26}
                r={10}
                color="#7D7A88"
                opacity={rock1Opacity}
              />
            </Group>
            <Group transform={tower2Place}>
              <RoundedRect
                x={cx - 7}
                y={waterTop - 52}
                width={14}
                height={44}
                r={4}
                color="#E8E2D6"
                opacity={tower2Opacity}
              />
              <RoundedRect
                x={cx - 9}
                y={waterTop - 60}
                width={18}
                height={10}
                r={3}
                color="#B0463E"
                opacity={tower2Opacity}
              />
              <Circle cx={cx} cy={waterTop - 63} r={glowRadius} color="#F4C86A" opacity={glowOpacity}>
                <BlurMask blur={6} style="normal" />
              </Circle>
            </Group>
            <Circle cx={cx} cy={waterTop} r={splashRingR} color="rgba(230,245,255,1)" opacity={splashRingOpacity} style="stroke" strokeWidth={2} />
          </Group>

          <Rect x={0} y={waterTop} width={width} height={SCENE_H - waterTop}>
            <LinearGradient
              start={vec(0, waterTop)}
              end={vec(0, SCENE_H)}
              colors={[palette.shallow, palette.mid, palette.deep]}
              positions={[0, 0.4, 1]}
            />
          </Rect>
          <Path
            path={`M0,${waterTop} L${width.toFixed(2)},${waterTop}`}
            style="stroke"
            strokeWidth={1.5}
            color={`${palette.glint},0.5)`}
          />
        </Canvas>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: {
    width: '100%',
    height: SCENE_H,
  },
});
