/**
 * The streak chip's flame: variant B of research/streak-chip, a prism flame of
 * gradient strokes (coral to sky) drawn with Skia on a 22 x 22 grid. It grows
 * with the streak: a faint outline at 0 days, an eye at 1, an inner flame from 7
 * and a white core plus a spark from 30.
 */
import { Canvas, Group, LinearGradient, Path, Skia, vec, type SkPath } from '@shopify/react-native-skia';
import { StyleSheet } from 'react-native';

const SIZE = 22;
const CORAL = '#FF5468';
const SKY = '#7CC8FF';

const OUTER = 'M11 3 C15 8 17 11 17 14.5 A6 6 0 0 1 5 14.5 C5 12 6.5 10.5 8 9';
const INNER = 'M11 10 C13.2 12.5 14 13.7 14 15 A3 3 0 0 1 8 15 C8 13.8 9.3 12.5 11 10Z';
const EYE = 'M11 14.5v.1';
const CORE = 'M11 15.5v.1';
const SPARK = 'M17 5v3M15.5 6.5h3';

const cache = new Map<string, SkPath | null>();
function path(d: string): SkPath | null {
  if (!cache.has(d)) cache.set(d, Skia.Path.MakeFromSVGString(d));
  return cache.get(d) ?? null;
}

/** The mock's gradient runs bottom-left to top-right across each path's own box. */
function Prism({ d, width, opacity }: { d: string; width: number; opacity?: number }) {
  const p = path(d);
  if (!p) return null;
  const b = p.getBounds();
  return (
    <Path path={p} style="stroke" strokeWidth={width} strokeCap="round" strokeJoin="round" opacity={opacity}>
      <LinearGradient start={vec(b.x, b.y + b.height)} end={vec(b.x + b.width, b.y)} colors={[CORAL, SKY]} />
    </Path>
  );
}

function Dot({ d, width, color }: { d: string; width: number; color: string }) {
  const p = path(d);
  return p ? <Path path={p} style="stroke" strokeWidth={width} strokeCap="round" color={color} /> : null;
}

export function StreakFlame({ streak }: { streak: number }) {
  const lit = streak >= 1;
  const inner = streak >= 7;
  const big = streak >= 30;
  return (
    <Canvas style={styles.canvas}>
      <Group opacity={lit ? 1 : 0.4}>
        <Prism d={OUTER} width={2} />
        {inner ? <Prism d={INNER} width={1.6} /> : null}
        {lit && !inner ? <Dot d={EYE} width={2.4} color="#FF8A98" /> : null}
        {big ? <Dot d={CORE} width={2.4} color="#FFFFFF" /> : null}
        {big ? <Dot d={SPARK} width={1.4} color={SKY} /> : null}
      </Group>
    </Canvas>
  );
}

const styles = StyleSheet.create({
  canvas: { width: SIZE, height: SIZE },
});
