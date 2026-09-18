import { useEffect } from 'react';
import { Canvas, Circle, LinearGradient, Path, Skia, vec } from '@shopify/react-native-skia';
import {
  Easing,
  cancelAnimation,
  useDerivedValue,
  useReducedMotion,
  useSharedValue,
  withDelay,
  withRepeat,
  withSequence,
  withTiming,
} from 'react-native-reanimated';

import { verb } from '@/constants/theme';

// A curl from the bottom left to a tip at the top right, drawn in a 120x140
// box and scaled 1.5 once here so every consumer works in on-screen pixels
// (180x210). Matches the approved mock; the tip lands at (126,87).
const RAW_D =
  'M28 132 C 26 96, 64 94, 70 76 C 76 58, 62 44, 76 34 C 88 26, 106 34, 104 50 C 102 64, 86 66, 84 58';
const RAW_PATH = Skia.Path.MakeFromSVGString(RAW_D);
const TAIL_PATH = RAW_PATH ? RAW_PATH.copy().transform(Skia.Matrix().scale(1.5, 1.5)) : null;

const WIDTH = 180;
const HEIGHT = 210;
const TIP = vec(126, 87);
const RING_DELAYS = [0, 700, 1400];

/** A finite number or the fallback: a NaN reaching Skia's native prop
 * conversion on the UI thread throws and exits Expo Go with no red box. */
function finiteOr(x: number, fallback: number) {
  'worklet';
  return Number.isFinite(x) ? x : fallback;
}

/**
 * The Echo Tail mark: a stroked curl with a three-colour gradient, one tail
 * curling from listen (blue) through read (amber) to speak (red). Draws in
 * over 1400ms, holds, then fades and repeats; three echo rings leave the tip
 * on their own independent, overlapping schedule. Reduced motion: fully
 * drawn, still, no rings. Renders nothing if the SVG failed to parse, rather
 * than crash.
 */
export function TailMark() {
  const reducedMotion = useReducedMotion();

  const end = useSharedValue(reducedMotion ? 1 : 0);
  const opacity = useSharedValue(1);
  const ring0 = useSharedValue(0);
  const ring1 = useSharedValue(0);
  const ring2 = useSharedValue(0);
  const rings = [ring0, ring1, ring2];

  useEffect(() => {
    if (reducedMotion) {
      end.value = 1;
      opacity.value = 1;
      return;
    }

    end.value = withRepeat(
      withSequence(
        withTiming(1, { duration: 1400, easing: Easing.inOut(Easing.cubic) }),
        withTiming(1, { duration: 900 }),
        withTiming(0, { duration: 0 }),
      ),
      -1,
      false,
    );
    opacity.value = withRepeat(
      withSequence(
        withTiming(1, { duration: 2000 }),
        withTiming(0, { duration: 300 }),
        withTiming(1, { duration: 0 }),
      ),
      -1,
      false,
    );
    rings.forEach((ring, i) => {
      ring.value = withDelay(
        RING_DELAYS[i],
        withRepeat(
          withSequence(
            withTiming(1, { duration: 1400, easing: Easing.out(Easing.cubic) }),
            withTiming(1, { duration: 700 }),
            withTiming(0, { duration: 0 }),
          ),
          -1,
          false,
        ),
      );
    });

    return () => {
      cancelAnimation(end);
      cancelAnimation(opacity);
      rings.forEach((ring) => cancelAnimation(ring));
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reducedMotion]);

  const pathEnd = useDerivedValue(() => finiteOr(end.value, 1));
  const pathOpacity = useDerivedValue(() => finiteOr(opacity.value, 1));
  const ring0Radius = useDerivedValue(() => finiteOr(6 + ring0.value * 34, 6));
  const ring0Opacity = useDerivedValue(() => finiteOr(0.9 * (1 - ring0.value), 0));
  const ring1Radius = useDerivedValue(() => finiteOr(6 + ring1.value * 34, 6));
  const ring1Opacity = useDerivedValue(() => finiteOr(0.9 * (1 - ring1.value), 0));
  const ring2Radius = useDerivedValue(() => finiteOr(6 + ring2.value * 34, 6));
  const ring2Opacity = useDerivedValue(() => finiteOr(0.9 * (1 - ring2.value), 0));
  const ringRadii = [ring0Radius, ring1Radius, ring2Radius];
  const ringOpacities = [ring0Opacity, ring1Opacity, ring2Opacity];

  if (!TAIL_PATH) return null;

  return (
    <Canvas style={{ width: WIDTH, height: HEIGHT }}>
      <Path
        path={TAIL_PATH}
        style="stroke"
        strokeWidth={5}
        strokeCap="round"
        strokeJoin="round"
        end={reducedMotion ? 1 : pathEnd}
        opacity={reducedMotion ? 1 : pathOpacity}>
        <LinearGradient
          start={vec(42, 198)}
          end={vec(156, 51)}
          colors={[verb.speak.c1, verb.read.c1, verb.listen.c1]}
        />
      </Path>
      {reducedMotion
        ? null
        : ringRadii.map((r, i) => (
            <Circle
              key={i}
              cx={TIP.x}
              cy={TIP.y}
              r={r}
              style="stroke"
              strokeWidth={1.6}
              color={verb.listen.c1}
              opacity={ringOpacities[i]}
            />
          ))}
    </Canvas>
  );
}
