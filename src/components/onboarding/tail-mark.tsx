import { Canvas, LinearGradient, Path, Skia, vec } from '@shopify/react-native-skia';
import { type SharedValue, useDerivedValue } from 'react-native-reanimated';

import { verb } from '@/constants/theme';

// A curl from the bottom left to a tip at the top right, drawn in a 120x140
// box and scaled 1.5 once here so every consumer works in on-screen pixels
// (180x210). Matches the approved mock; the tip lands at (126,87).
const RAW_D =
  'M28 132 C 26 96, 64 94, 70 76 C 76 58, 62 44, 76 34 C 88 26, 106 34, 104 50 C 102 64, 86 66, 84 58';
let tailCache: ReturnType<typeof Skia.Path.MakeFromSVGString> | undefined;
/** Built on first use, not at import, so the web static export never calls Skia at module scope. */
export function getTailPath() {
  if (tailCache === undefined) {
    try {
      const raw = Skia.Path.MakeFromSVGString(RAW_D);
      tailCache = raw ? raw.copy().transform(Skia.Matrix().scale(1.5, 1.5)) : null;
    } catch {
      tailCache = null;
    }
  }
  return tailCache;
}

/** The canvas the curl is drawn in, in on-screen points. */
export const TAIL_BOX = { w: 180, h: 210 } as const;
/** Where the curl ends inside `TAIL_BOX`: the tip the rings and the idle bead land on. */
export const TAIL_TIP = { x: 126, y: 87 } as const;

/** A finite number or the fallback: a NaN reaching Skia's native prop
 * conversion on the UI thread throws and exits Expo Go with no red box. */
function finiteOr(x: number, fallback: number) {
  'worklet';
  return Number.isFinite(x) ? x : fallback;
}

/**
 * The Echo Tail mark: a stroked curl with a three-colour gradient, one tail
 * curling from listen (blue) through read (amber) to speak (red). It owns no
 * timer: `start` and `end` (0..1 along the curl) and `opacity` come from the
 * caller's clock, so the welcome hero draws it behind the head, un-draws it
 * on exit and holds it still under reduced motion with the same Path.
 * Renders nothing if the SVG failed to parse, rather than crash.
 */
export function TailMark({ start, end, opacity }: { start: SharedValue<number>; end: SharedValue<number>; opacity: SharedValue<number> }) {
  const pathStart = useDerivedValue(() => finiteOr(start.value, 0));
  const pathEnd = useDerivedValue(() => finiteOr(end.value, 1));
  const pathOpacity = useDerivedValue(() => finiteOr(opacity.value, 1));

  const TAIL_PATH = getTailPath();
  if (!TAIL_PATH) return null;

  return (
    <Canvas style={{ width: TAIL_BOX.w, height: TAIL_BOX.h }}>
      <Path
        path={TAIL_PATH}
        style="stroke"
        strokeWidth={5}
        strokeCap="round"
        strokeJoin="round"
        start={pathStart}
        end={pathEnd}
        opacity={pathOpacity}>
        <LinearGradient
          start={vec(42, 198)}
          end={vec(156, 51)}
          colors={[verb.speak.c1, verb.read.c1, verb.listen.c1]}
        />
      </Path>
    </Canvas>
  );
}
