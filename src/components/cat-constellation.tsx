import { memo, useEffect } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { Canvas, Circle, Group, Path } from '@shopify/react-native-skia';
import Animated, {
  useAnimatedStyle,
  useDerivedValue,
  useFrameCallback,
  useReducedMotion,
  useSharedValue,
  type SharedValue,
} from 'react-native-reanimated';

import { fonts } from '@/constants/fonts';
import { tide } from '@/constants/theme';
import { useDir, useT } from '@/lib/i18n';

/** The cat's outline in its own 96x118 box, closed back on the first point. */
const POINTS: readonly (readonly [number, number])[] = [
  [18, 8], [34, 30], [48, 26], [62, 30], [78, 8], [80, 50], [84, 78],
  [84, 108], [62, 118], [34, 118], [12, 108], [12, 78], [16, 50], [18, 8],
];
const BOX_W = 96;
const BOX_H = 118;
const EYES: readonly (readonly [number, number])[] = [
  [48 - 13, 52],
  [48 + 13, 52],
];
const LOOP_MS = 4500;
/** The frame shown under reduced motion: outline complete, eyes on. */
const STATIC_T = 0.7;
const STAR_COUNT = 12;

const DOTS_LOOP_MS = 1200;
const DOT_STEP_MS = 200;
const LABEL_SIZE = 17;
const LABEL_LINE = 22;

/** A finite number or the fallback. Every value below reaches Skia's native
 * prop conversion or a Reanimated style on the UI runtime, where a throw
 * aborts the app. */
function finiteOr(x: number, fallback: number) {
  'worklet';
  return Number.isFinite(x) ? x : fallback;
}

/** Loop position 0..1 for the clock, or the static frame. */
function loopT(now: number, still: boolean) {
  'worklet';
  if (still) return STATIC_T;
  const t = (finiteOr(now, 0) % LOOP_MS) / LOOP_MS;
  return finiteOr(t, STATIC_T);
}

function circleD(x: number, y: number, r: number) {
  'worklet';
  const cy = y.toFixed(2);
  const rr = r.toFixed(2);
  const d = (2 * r).toFixed(2);
  return `M${(x - r).toFixed(2)},${cy} a${rr},${rr} 0 1,0 ${d},0 a${rr},${rr} 0 1,0 -${d},0 Z`;
}

type Props = {
  /** Outline height in pt. */
  size?: number;
  /** Defaults to the translated "Loading" when not given. */
  label?: string;
  /** Inline busy state: a small cat and small dots in a row, no label. */
  compact?: boolean;
  /** Loose twinkling stars around the cat. Always off when compact. */
  stars?: boolean;
  /** Drives the animation from an existing UI-thread clock instead of
   * starting a frame callback of its own: for the pre-mounted loading
   * overlay, which must do no per-frame work while idle. */
  clock?: SharedValue<number>;
  /** Exposes the progressbar role to screen readers. Off while a pre-mounted
   * loader sits idle. Defaults to on. */
  announce?: boolean;
};

/**
 * The app's loading visual: a cat drawn star by star as a constellation,
 * its eyes lighting once the outline closes, then fading and starting over.
 * Below it a label with three dots that appear one by one and leave
 * together. All drawing runs on the UI thread from one frame clock, unless a
 * `clock` is passed in, in which case it drives from that one instead.
 */
export const CatConstellation = memo(function CatConstellation({
  size = 150,
  label,
  compact = false,
  stars = true,
  clock: sharedClock,
  announce = true,
}: Props) {
  const { t } = useT();
  const dir = useDir();
  const displayLabel = label ?? t('common.loading');
  const reducedMotion = useReducedMotion();
  const ownNow = useSharedValue(0);
  const now = sharedClock ?? ownNow;
  const frame = useFrameCallback((info) => {
    ownNow.value = finiteOr(info.timeSinceFirstFrame, 0);
  }, false);

  useEffect(() => {
    if (sharedClock) return;
    frame.setActive(!reducedMotion);
    if (reducedMotion) ownNow.value = 0;
    return () => frame.setActive(false);
  }, [reducedMotion, frame, ownNow, sharedClock]);

  const catSize = compact ? 44 : size;
  const showStars = stars && !compact;

  const content = (
    <>
      <CatCanvas size={catSize} stars={showStars} now={now} still={reducedMotion} />
      <View style={compact ? styles.dotsCompact : [styles.labelRow, dir.row]}>
        {compact ? null : <Text style={[styles.label, dir.rtl && styles.labelRtl]}>{displayLabel}</Text>}
        <Dots dot={compact ? 5 : 7} now={now} still={reducedMotion} lift={compact ? 0 : LABEL_LINE / 3 - 3.5} />
      </View>
    </>
  );

  return (
    <View
      accessible={announce}
      accessibilityRole={announce ? 'progressbar' : undefined}
      accessibilityLabel={announce ? displayLabel : undefined}
      style={compact ? styles.compact : styles.full}>
      {content}
    </View>
  );
});

function CatCanvas({
  size,
  stars,
  now,
  still,
}: {
  size: number;
  stars: boolean;
  now: SharedValue<number>;
  still: boolean;
}) {
  const safeSize = Number.isFinite(size) && size > 0 ? size : 150;
  const k = safeSize / BOX_H;
  const boxW = BOX_W * k;
  // Room for the stars around the cat, or just enough for the dots' radius.
  const W = Math.round(stars ? safeSize * 1.6 : boxW + 6);
  const H = Math.round(stars ? safeSize * 1.25 : safeSize + 6);
  const ox = (W - boxW) / 2;
  const oy = (H - safeSize) / 2;
  const pts = POINTS.map(([x, y]) => [ox + x * k, oy + y * k] as const);
  const eyes = EYES.map(([x, y]) => [ox + x * k, oy + y * k] as const);
  const litR = 2.2 * k;
  const unlitR = 1.4 * k;
  const strokeW = Math.max(1, 1.2 * k);

  const outlineD = useDerivedValue(() => {
    const t = loopT(now.value, still);
    const draw = Math.min(1, t / 0.55);
    const segs = (pts.length - 1) * draw;
    const n = Math.max(0, Math.min(pts.length - 1, Math.floor(segs)));
    let d = `M${pts[0][0].toFixed(2)},${pts[0][1].toFixed(2)}`;
    for (let i = 1; i <= n; i++) d += ` L${pts[i][0].toFixed(2)},${pts[i][1].toFixed(2)}`;
    if (n < pts.length - 1) {
      const f = finiteOr(segs - n, 0);
      const a = pts[n];
      const b = pts[n + 1];
      d += ` L${(a[0] + (b[0] - a[0]) * f).toFixed(2)},${(a[1] + (b[1] - a[1]) * f).toFixed(2)}`;
    }
    return d;
  });
  const fade = useDerivedValue(() => {
    const t = loopT(now.value, still);
    return finiteOr(t > 0.85 ? 1 - (t - 0.85) / 0.15 : 1, 1);
  });
  const outlineOpacity = useDerivedValue(() => 0.85 * fade.value);
  const litD = useDerivedValue(() => {
    const t = loopT(now.value, still);
    const segs = (pts.length - 1) * Math.min(1, t / 0.55);
    let d = '';
    for (let i = 0; i < pts.length; i++) if (i <= segs) d += circleD(pts[i][0], pts[i][1], litR) + ' ';
    return d || 'M0,0';
  });
  const unlitD = useDerivedValue(() => {
    const t = loopT(now.value, still);
    const segs = (pts.length - 1) * Math.min(1, t / 0.55);
    let d = '';
    for (let i = 0; i < pts.length; i++) if (i > segs) d += circleD(pts[i][0], pts[i][1], unlitR) + ' ';
    return d || 'M0,0';
  });
  const eyesOpacity = useDerivedValue(() => {
    const t = loopT(now.value, still);
    return t / 0.55 >= 1 ? fade.value : 0;
  });

  return (
    <Canvas pointerEvents="none" style={{ width: W, height: H }}>
      {stars
        ? Array.from({ length: STAR_COUNT }, (_, i) => (
            <Star
              key={i}
              x={(i * 97) % W}
              y={((i * 53) % Math.max(1, H - 20)) + 10}
              r={(i % 3) * 0.5 + 0.6}
              now={now}
            />
          ))
        : null}
      <Path
        path={outlineD}
        style="stroke"
        strokeWidth={strokeW}
        strokeJoin="round"
        strokeCap="round"
        color="rgb(201,190,255)"
        opacity={outlineOpacity}
      />
      <Path path={unlitD} color="rgba(236,232,244,0.35)" />
      <Path path={litD} color="#FFFFFF" opacity={fade} />
      <Group opacity={eyesOpacity}>
        {eyes.map(([x, y], i) => (
          <Circle key={i} cx={x} cy={y} r={3.2 * k} color="#F7C548" />
        ))}
      </Group>
    </Canvas>
  );
}

function Star({ x, y, r, now }: { x: number; y: number; r: number; now: SharedValue<number> }) {
  const opacity = useDerivedValue(() => finiteOr(0.3 + 0.2 * Math.sin(now.value / 900 + x), 0.3));
  return <Circle cx={x} cy={y} r={r} color="rgb(236,232,244)" opacity={opacity} />;
}

function Dots({ dot, now, still, lift }: { dot: number; now: SharedValue<number>; still: boolean; lift: number }) {
  return (
    <View style={[styles.dots, { marginBottom: lift }]}>
      {[0, 1, 2].map((i) => (
        <Dot key={i} index={i} dot={dot} now={now} still={still} />
      ))}
    </View>
  );
}

function Dot({ index, dot, now, still }: { index: number; dot: number; now: SharedValue<number>; still: boolean }) {
  const style = useAnimatedStyle(() => {
    if (still) return { opacity: 1, transform: [{ scale: 1 }] };
    const ms = finiteOr(now.value, 0) % DOTS_LOOP_MS;
    const start = index * DOT_STEP_MS;
    let opacity: number;
    if (ms < start) opacity = 0;
    else if (ms < start + DOT_STEP_MS) opacity = (ms - start) / DOT_STEP_MS;
    else if (ms < DOTS_LOOP_MS - DOT_STEP_MS) opacity = 1;
    else opacity = 1 - (ms - (DOTS_LOOP_MS - DOT_STEP_MS)) / DOT_STEP_MS;
    const growing = ms < start + DOT_STEP_MS;
    const scale = growing ? 0.6 + 0.4 * opacity : 1;
    return {
      opacity: Math.max(0, Math.min(1, finiteOr(opacity, 1))),
      transform: [{ scale: finiteOr(scale, 1) }],
    };
  });
  return (
    <Animated.View
      style={[{ width: dot, height: dot, borderRadius: dot / 2, backgroundColor: tide.lang.ja }, style]}
    />
  );
}

const styles = StyleSheet.create({
  full: { alignItems: 'center', justifyContent: 'center' },
  compact: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  labelRow: { flexDirection: 'row', alignItems: 'flex-end', height: LABEL_LINE },
  label: {
    fontFamily: fonts.uiMedium,
    fontWeight: '500',
    fontSize: LABEL_SIZE,
    lineHeight: LABEL_LINE,
    color: tide.text,
    marginRight: 8,
  },
  // The dots follow the word, so Hebrew puts them on its left.
  labelRtl: { marginRight: 0, marginLeft: 8 },
  dots: { flexDirection: 'row', gap: 6 },
  dotsCompact: { flexDirection: 'row', alignItems: 'center' },
});
