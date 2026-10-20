import { useEffect, useMemo, useState } from 'react';
import { type LayoutChangeEvent, StyleSheet, Text, View } from 'react-native';
import { Canvas, Circle, DashPathEffect, Group, LinearGradient, Mask, Path, Shadow, Skia, vec } from '@shopify/react-native-skia';
import Animated, { type SharedValue, useAnimatedStyle, useDerivedValue, useSharedValue } from 'react-native-reanimated';
import Svg, { Path as SvgPath, Rect } from 'react-native-svg';

import { finiteOr } from '@/components/onboarding/pass-effects';
import { fonts } from '@/constants/fonts';
import { prism, tide, verb } from '@/constants/theme';
import { useDir, useT } from '@/lib/i18n';
import { fitFontSize, sampleWordFor } from '@/lib/sample-word';

/**
 * The welcome entrance timeline (designs/welcome-10/motion/welcome-motion.html),
 * in ms on one clock. Everything on the screen derives from `clock`, which
 * runs 0 to END once and then stands still: no idle loops.
 */
export const LOOP_T = {
  bubble: 260,
  catFrom: 120,
  catFor: 300,
  nodeH: 400,
  arcTop: 600,
  arcFor: 550,
  nodeS: 1150,
  sweepFor: 500,
  arcRet: 1400,
  bump: 1950,
  bumpFor: 120,
  lap: 1952,
  /** The pills rise and go live here: the cat has finished speaking. */
  pills: 700,
  pillStagger: 40,
  pillFor: 340,
  end: 2400,
} as const;

const END = LOOP_T.end;
const NODE = 80;
/** The node's edge sits this far in from the block's edge (the mock: 10px on a 390 screen). */
const NODE_INSET = 10;
/** Where an arc starts and ends: this far from the node's centre (node radius plus a 4.8 gap). */
const ARC_GAP = 44.8;
const RING_FOR = 600;
const POP_FOR = 300;
const STACK_W = 166;
const SWEEP_W = 70;
/** The sweep window is built from slices of stepped opacity, the app has no gradient mask view. */
const SWEEP_SLICES = 7;
const LUT_N = 40;
const DOT_R = 4.5;
const STROKE = 3.5;
const MASK_STROKE = 26;
const JA = '#FF9E80';
const ARROW_TOP = '#FF8A70';
const ARROW_RET = '#A9B8FF';
/** The node glyphs' stroke, on each shape: the web does not inherit it from the Svg root. */
const GLYPH = { fill: 'none', stroke: tide.text, strokeWidth: 1.9, strokeLinecap: 'round', strokeLinejoin: 'round' } as const;

export function clamp01(x: number) {
  'worklet';
  return x < 0 ? 0 : x > 1 ? 1 : x;
}
export function outCubic(t: number) {
  'worklet';
  const u = 1 - clamp01(t);
  return 1 - u * u * u;
}
function inOutCubic(t: number) {
  'worklet';
  const u = clamp01(t);
  return u < 0.5 ? 4 * u * u * u : 1 - Math.pow(-2 * u + 2, 3) / 2;
}
/** The mock's POP (cubic-bezier(.34,1.56,.64,1)): overshoots to about 1.1 and settles. */
export function backOut(t: number) {
  'worklet';
  const u = clamp01(t) - 1;
  const c1 = 1.70158;
  return 1 + (c1 + 1) * u * u * u + c1 * u * u;
}
/** The mock's SPRING (cubic-bezier(.3,1.4,.5,1)): a softer overshoot, about 1.07. */
export function springOut(t: number) {
  'worklet';
  const u = clamp01(t) - 1;
  const c1 = 1.2;
  return 1 + (c1 + 1) * u * u * u + c1 * u * u;
}
function sineInOut(t: number) {
  'worklet';
  return (1 - Math.cos(Math.PI * clamp01(t))) / 2;
}
/** A node's pop: hidden, then scale .8 to 1 with the POP overshoot and opacity 0 to 1. */
function pop(ms: number, from: number) {
  'worklet';
  const p = clamp01((ms - from) / POP_FOR);
  const e = backOut(p);
  return { opacity: clamp01(e), scale: 0.8 + 0.2 * e };
}
/** A ring: 50 % at the node's size, spreading to 1.5x and gone over 600 ms. */
function ring(ms: number, from: number) {
  'worklet';
  if (ms < from || ms >= from + RING_FOR) return { opacity: 0, scale: 1 };
  const e = outCubic((ms - from) / RING_FOR);
  return { opacity: 0.5 * (1 - e), scale: 1 + 0.5 * e };
}
/** The dot's place on the loop at `ms`: which arc (0 top, 1 return), how far along it, how bright. */
function dotAt(ms: number) {
  'worklet';
  const t = LOOP_T;
  if (ms < t.arcTop) return { arc: 0, u: 0, opacity: 0 };
  if (ms < t.nodeS) return { arc: 0, u: inOutCubic((ms - t.arcTop) / t.arcFor), opacity: 1 };
  if (ms < t.arcRet) return { arc: 0, u: 1, opacity: 1 };
  if (ms < t.bump) return { arc: 1, u: inOutCubic((ms - t.arcRet) / t.arcFor), opacity: 1 };
  if (ms < t.lap) return { arc: 0, u: 0, opacity: 0 };
  // One more lap at .6, 450 ms split evenly: the two arcs are the same length.
  const half = (t.end - t.lap) / 2;
  if (ms < t.lap + half) return { arc: 0, u: (ms - t.lap) / half, opacity: 0.6 };
  if (ms < t.end) return { arc: 1, u: (ms - t.lap - half) / half, opacity: 0.6 };
  return { arc: 1, u: 1, opacity: 0 };
}

type Geometry = {
  cx: number;
  cy: number;
  rx: number;
  ry: number;
  top: ReturnType<typeof Skia.Path.Make>;
  ret: ReturnType<typeof Skia.Path.Make>;
  arrow: ReturnType<typeof Skia.Path.Make>;
  topEnd: { x: number; y: number; deg: number };
  retEnd: { x: number; y: number; deg: number };
  /** The arcs resampled at even steps of length, for the travelling dot. */
  topX: number[];
  topY: number[];
  retX: number[];
  retY: number[];
};

/** A point on the ellipse at parametric angle `t` (radians, clockwise from +x, y down). */
function at(g: { cx: number; cy: number; rx: number; ry: number }, t: number) {
  return { x: g.cx + g.rx * Math.cos(t), y: g.cy + g.ry * Math.sin(t) };
}

/** Resamples one arc at `LUT_N` points evenly spaced by length, so the dot keeps one speed. */
function sampleArc(g: { cx: number; cy: number; rx: number; ry: number }, from: number, sweep: number) {
  const n = 96;
  const pts = Array.from({ length: n + 1 }, (_, i) => at(g, from + (sweep * i) / n));
  const len = [0];
  for (let i = 1; i <= n; i++) len.push(len[i - 1] + Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y));
  const total = len[n];
  const xs: number[] = [];
  const ys: number[] = [];
  let j = 0;
  for (let k = 0; k < LUT_N; k++) {
    const target = (total * k) / (LUT_N - 1);
    while (j < n - 1 && len[j + 1] < target) j++;
    const span = len[j + 1] - len[j];
    const f = span > 0 ? (target - len[j]) / span : 0;
    xs.push(pts[j].x + (pts[j + 1].x - pts[j].x) * f);
    ys.push(pts[j].y + (pts[j + 1].y - pts[j].y) * f);
  }
  return { xs, ys };
}

/**
 * The loop for a block of `w` by `h`: one ellipse centred on the word stack,
 * through both node centres, with the arcs trimmed where they leave the nodes.
 * The mock (390 wide, 240 tall) gives rx 145, ry 100, and the arcs start and
 * end 44.8 from a node's centre. The height is what the screen leaves, so a
 * small phone gets a flatter ellipse rather than overlap.
 */
function geometry(w: number, h: number): Geometry {
  const cx = w / 2;
  const cy = h / 2;
  const rx = Math.max(60, w / 2 - NODE_INSET - NODE / 2);
  const ry = Math.max(50, Math.min(100, (h - 40) / 2));
  // The parametric angle from the node's centre where the arc clears the gap, by bisection.
  let lo = 0;
  let hi = Math.PI / 2;
  for (let i = 0; i < 40; i++) {
    const mid = (lo + hi) / 2;
    const d = Math.hypot(rx * (1 - Math.cos(mid)), ry * Math.sin(mid));
    if (d < ARC_GAP) lo = mid;
    else hi = mid;
  }
  const phi = (lo + hi) / 2;
  const sweep = Math.PI - 2 * phi;
  const oval = Skia.XYWHRect(cx - rx, cy - ry, 2 * rx, 2 * ry);
  const deg = (r: number) => (r * 180) / Math.PI;
  const top = Skia.Path.Make();
  top.addArc(oval, deg(Math.PI + phi), deg(sweep));
  const ret = Skia.Path.Make();
  ret.addArc(oval, deg(phi), deg(sweep));
  // The mock's marker (M1 1L8 5L1 9z, refX 6, refY 5) at the stroke's marker scale of 1.75.
  const arrow = Skia.Path.Make();
  arrow.moveTo(-8.75, -7);
  arrow.lineTo(3.5, 0);
  arrow.lineTo(-8.75, 7);
  arrow.close();
  const end = (t: number) => {
    const p = at({ cx, cy, rx, ry }, t);
    return { x: p.x, y: p.y, deg: deg(Math.atan2(ry * Math.cos(t), -rx * Math.sin(t))) };
  };
  const t1 = sampleArc({ cx, cy, rx, ry }, Math.PI + phi, sweep);
  const t2 = sampleArc({ cx, cy, rx, ry }, phi, sweep);
  return {
    cx,
    cy,
    rx,
    ry,
    top,
    ret,
    arrow,
    topEnd: end(2 * Math.PI - phi),
    retEnd: end(Math.PI - phi),
    topX: t1.xs,
    topY: t1.ys,
    retX: t2.xs,
    retY: t2.ys,
  };
}

/** One of the two nodes: an 80 pt Prism Edge disc that pops in, with the ring that spreads from it. */
function Node({
  clock,
  from,
  bump,
  colour,
  lip,
  glow,
  ringColour,
  left,
  top,
  children,
}: {
  clock: SharedValue<number>;
  from: number;
  bump: boolean;
  colour: [string, string];
  lip: string;
  glow: string;
  ringColour: string;
  left: number;
  top: number;
  children: React.ReactNode;
}) {
  const discStyle = useAnimatedStyle(() => {
    const ms = finiteOr(clock.value, END);
    const p = pop(ms, from);
    let scale = p.scale;
    // The hear node takes the dot's arrival: 1 to 1.06 and back over 120 ms.
    if (bump && ms >= LOOP_T.bump && ms < LOOP_T.bump + LOOP_T.bumpFor) {
      const q = (ms - LOOP_T.bump) / LOOP_T.bumpFor;
      scale *= 1 + 0.06 * (q < 0.5 ? outCubic(q * 2) : 1 - outCubic((q - 0.5) * 2));
    }
    return { opacity: finiteOr(p.opacity, 1), transform: [{ scale: finiteOr(scale, 1) }] };
  });
  const ringStyle = useAnimatedStyle(() => {
    const r = ring(finiteOr(clock.value, END), from);
    return { opacity: finiteOr(r.opacity, 0), transform: [{ scale: finiteOr(r.scale, 1) }] };
  });
  return (
    <>
      <Animated.View pointerEvents="none" style={[styles.ring, { left, top, borderColor: ringColour }, ringStyle]} />
      <Animated.View
        style={[styles.node, { left, top, boxShadow: `0 4 0 ${lip}, 0 0 22 ${glow}` }, discStyle]}
        accessible={false}>
        <Canvas style={StyleSheet.absoluteFill}>
          <Circle cx={NODE / 2} cy={NODE / 2} r={NODE / 2}>
            <LinearGradient start={vec(0, 0)} end={vec(0, NODE)} colors={colour} />
          </Circle>
        </Canvas>
        <View pointerEvents="none" style={styles.fringe} />
        {/* A positioned box: on the web a bare svg would paint under the absolute canvas. */}
        <View style={styles.glyph}>{children}</View>
      </Animated.View>
    </>
  );
}

/**
 * The welcome loop: hear it (headphones, blue) and say it back (mic, coral)
 * joined by one dotted ellipse around the sample word. Draws itself in on
 * `clock` (ms, 0 to `LOOP_T.end`): the hear node pops with a ring, the top
 * arc draws with a travelling dot, the say node pops with a ring and one
 * highlight sweep across the word, the return arc draws back, and the dot
 * takes one more faint lap. Then nothing moves. In Hebrew the loop mirrors:
 * hear stays on the side reading starts from.
 *
 * Checked `TailMark` first: its curl is a fixed path on an endless repeat,
 * so this is its own Skia canvas rather than a mode on it.
 */
export function EchoLoop({ clock, language }: { clock: SharedValue<number>; language?: string }) {
  const { t } = useT();
  const dir = useDir();
  const sample = sampleWordFor(language);
  const wordRtl = !!sample.rtl;
  const rtl = dir.rtl;
  const sweepRtl = dir.rtl || wordRtl;
  const [box, setBox] = useState({ w: 0, h: 0 });
  const onLayout = (e: LayoutChangeEvent) => {
    const { width, height } = e.nativeEvent.layout;
    setBox((b) => (b.w === width && b.h === height ? b : { w: width, h: height }));
  };
  const geo = useMemo(() => (box.w > 0 && box.h > 0 ? geometry(box.w, box.h) : null), [box.w, box.h]);

  // The dot reads the arcs' samples from shared values: a worklet reads only shared values and primitives.
  const topX = useSharedValue<number[]>([]);
  const topY = useSharedValue<number[]>([]);
  const retX = useSharedValue<number[]>([]);
  const retY = useSharedValue<number[]>([]);
  useEffect(() => {
    if (!geo) return;
    topX.value = geo.topX;
    topY.value = geo.topY;
    retX.value = geo.retX;
    retY.value = geo.retY;
  }, [geo, topX, topY, retX, retY]);

  const trimTop = useDerivedValue(() => inOutCubic((finiteOr(clock.value, END) - LOOP_T.arcTop) / LOOP_T.arcFor));
  const trimRet = useDerivedValue(() => inOutCubic((finiteOr(clock.value, END) - LOOP_T.arcRet) / LOOP_T.arcFor));
  // The arcs sit at .75 while they draw, then brighten to 1 over the last 360 ms (the mock's 80 % keyframe).
  const arcOpacity = useDerivedValue(() => {
    const ms = finiteOr(clock.value, END);
    const brighten = LOOP_T.arcTop + (END - LOOP_T.arcTop) * 0.8;
    return ms < brighten ? 0.75 : 0.75 + 0.25 * clamp01((ms - brighten) / (END - brighten));
  });
  const dotX = useDerivedValue(() => {
    const d = dotAt(finiteOr(clock.value, END));
    const xs = d.arc === 0 ? topX.value : retX.value;
    const n = xs.length;
    if (n < 2) return 0;
    const f = clamp01(d.u) * (n - 1);
    const i = Math.min(n - 2, Math.floor(f));
    return finiteOr(xs[i] + (xs[i + 1] - xs[i]) * (f - i), 0);
  });
  const dotY = useDerivedValue(() => {
    const d = dotAt(finiteOr(clock.value, END));
    const ys = d.arc === 0 ? topY.value : retY.value;
    const n = ys.length;
    if (n < 2) return 0;
    const f = clamp01(d.u) * (n - 1);
    const i = Math.min(n - 2, Math.floor(f));
    return finiteOr(ys[i] + (ys[i + 1] - ys[i]) * (f - i), 0);
  });
  const dotOpacity = useDerivedValue(() => {
    const n = topX.value.length;
    return n < 2 ? 0 : finiteOr(dotAt(finiteOr(clock.value, END)).opacity, 0);
  });

  // The highlight sweep: a 70 pt window crosses the word once while the say node pops. The word itself never moves.
  const sweepWindow = useAnimatedStyle(() => {
    const ms = finiteOr(clock.value, END);
    const on = ms >= LOOP_T.nodeS && ms < LOOP_T.nodeS + LOOP_T.sweepFor;
    const p = sineInOut((ms - LOOP_T.nodeS) / LOOP_T.sweepFor);
    const x = -SWEEP_W + (STACK_W + SWEEP_W) * p;
    return { opacity: on ? 1 : 0, transform: [{ translateX: finiteOr(sweepRtl ? STACK_W - SWEEP_W - x : x, 0) }] };
  });
  const sweepText = useAnimatedStyle(() => {
    const ms = finiteOr(clock.value, END);
    const p = sineInOut((ms - LOOP_T.nodeS) / LOOP_T.sweepFor);
    const x = -SWEEP_W + (STACK_W + SWEEP_W) * p;
    return { transform: [{ translateX: finiteOr(-(sweepRtl ? STACK_W - SWEEP_W - x : x), 0) }] };
  });

  const hearLeft = rtl ? box.w - NODE_INSET - NODE : NODE_INSET;
  const sayLeft = rtl ? NODE_INSET : box.w - NODE_INSET - NODE;
  const nodeTop = geo ? geo.cy - NODE / 2 : 0;
  const word = sample.word;
  const size = fitFontSize(word, STACK_W);
  const wordStyle = { fontSize: size, lineHeight: Math.round(size * 1.1), writingDirection: wordRtl ? ('rtl' as const) : ('ltr' as const) };

  return (
    <View style={styles.block} onLayout={onLayout}>
      {geo ? (
        <Canvas style={StyleSheet.absoluteFill} pointerEvents="none">
          <Group transform={rtl ? [{ translateX: box.w }, { scaleX: -1 }] : undefined}>
            <Group opacity={arcOpacity}>
              <Mask mode="luminance" mask={<Path path={geo.top} style="stroke" strokeWidth={MASK_STROKE} strokeCap="round" color="white" end={trimTop} />}>
                <Path path={geo.top} style="stroke" strokeWidth={STROKE} strokeCap="round">
                  <LinearGradient start={vec(geo.cx - geo.rx, 0)} end={vec(geo.cx + geo.rx, 0)} colors={[verb.listen.c1, verb.speak.c1]} />
                  <DashPathEffect intervals={[1, 8]} />
                </Path>
                <Group transform={[{ translateX: geo.topEnd.x }, { translateY: geo.topEnd.y }, { rotate: (geo.topEnd.deg * Math.PI) / 180 }]}>
                  <Path path={geo.arrow} color={ARROW_TOP} />
                </Group>
              </Mask>
              <Mask mode="luminance" mask={<Path path={geo.ret} style="stroke" strokeWidth={MASK_STROKE} strokeCap="round" color="white" end={trimRet} />}>
                <Path path={geo.ret} style="stroke" strokeWidth={STROKE} strokeCap="round">
                  <LinearGradient start={vec(geo.cx + geo.rx, 0)} end={vec(geo.cx - geo.rx, 0)} colors={[ARROW_TOP, ARROW_RET]} />
                  <DashPathEffect intervals={[1, 8]} />
                </Path>
                <Group transform={[{ translateX: geo.retEnd.x }, { translateY: geo.retEnd.y }, { rotate: (geo.retEnd.deg * Math.PI) / 180 }]}>
                  <Path path={geo.arrow} color={ARROW_RET} />
                </Group>
              </Mask>
            </Group>
            <Circle cx={dotX} cy={dotY} r={DOT_R} color="white" opacity={dotOpacity}>
              <Shadow dx={0} dy={0} blur={2.5} color="rgba(255,255,255,0.9)" />
            </Circle>
          </Group>
        </Canvas>
      ) : null}
      {geo ? (
        <>
          <Node
            clock={clock}
            from={LOOP_T.nodeH}
            bump
            colour={['#3d86c4', '#1D4E7A']}
            lip={verb.listen.lip}
            glow="rgba(124,200,255,0.45)"
            ringColour={verb.listen.c1}
            left={hearLeft}
            top={nodeTop}>
            <Svg width={40} height={40} viewBox="0 0 24 24">
              <SvgPath d="M4 14v-2a8 8 0 0116 0v2" {...GLYPH} />
              <Rect x={3} y={14} width={4.5} height={7} rx={2} {...GLYPH} />
              <Rect x={16.5} y={14} width={4.5} height={7} rx={2} {...GLYPH} />
            </Svg>
          </Node>
          <Node
            clock={clock}
            from={LOOP_T.nodeS}
            bump={false}
            colour={['#d8405c', '#8e2a45']}
            lip={verb.speak.lip}
            glow="rgba(255,84,104,0.45)"
            ringColour={ARROW_TOP}
            left={sayLeft}
            top={nodeTop}>
            <Svg width={40} height={40} viewBox="0 0 24 24">
              <Rect x={9} y={3} width={6} height={12} rx={3} {...GLYPH} />
              <SvgPath d="M5.5 11.5a6.5 6.5 0 0013 0M12 18v3" {...GLYPH} />
            </Svg>
          </Node>
        </>
      ) : null}
      <View style={styles.stack} pointerEvents="none">
        <View style={styles.wordBox}>
          <Text style={[styles.word, wordStyle]} numberOfLines={1}>{word}</Text>
          <Animated.View style={[styles.sweep, sweepWindow]}>
            {Array.from({ length: SWEEP_SLICES }, (_, i) => {
              const slice = SWEEP_W / SWEEP_SLICES;
              // A triangle mask: clear at the edges, solid in the middle.
              const mid = (i + 0.5) / SWEEP_SLICES;
              const alpha = 1 - Math.abs(mid - 0.5) * 2;
              return (
                <View key={i} style={[styles.slice, { left: i * slice, width: slice + 0.5, opacity: alpha }]}>
                  <Animated.Text numberOfLines={1} style={[styles.word, wordStyle, styles.sweepWord, { left: -i * slice }, sweepText]}>{word}</Animated.Text>
                </View>
              );
            })}
          </Animated.View>
        </View>
        {sample.reading ? <Text style={styles.reading}>{sample.reading}</Text> : null}
        <Text style={[styles.gloss, dir.writing]}>{t('intro.sample.gloss')}</Text>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  block: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  node: {
    position: 'absolute',
    width: NODE,
    height: NODE,
    borderRadius: NODE / 2,
    alignItems: 'center',
    justifyContent: 'center',
    overflow: 'visible',
  },
  fringe: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    borderRadius: NODE / 2,
    borderWidth: 1.5,
    borderTopColor: prism.fringe.top,
    borderRightColor: prism.fringe.rightOn,
    borderBottomColor: prism.fringe.bottom,
    borderLeftColor: prism.fringe.leftOn,
  },
  ring: { position: 'absolute', width: NODE, height: NODE, borderRadius: NODE / 2, borderWidth: 2 },
  glyph: { position: 'absolute', top: 0, left: 0, width: NODE, height: NODE, alignItems: 'center', justifyContent: 'center' },
  stack: { width: STACK_W, alignItems: 'center' },
  wordBox: { width: STACK_W, overflow: 'visible' },
  word: {
    fontFamily: fonts.serifJp,
    fontSize: 30,
    fontWeight: '700',
    lineHeight: 33,
    color: JA,
    textAlign: 'center',
    width: STACK_W,
    textShadowColor: 'rgba(255,158,128,0.45)',
    textShadowOffset: { width: 0, height: 0 },
    textShadowRadius: 18,
  },
  sweep: { position: 'absolute', top: 0, bottom: 0, left: 0, width: SWEEP_W },
  slice: { position: 'absolute', top: 0, bottom: 0, overflow: 'hidden' },
  sweepWord: { position: 'absolute', top: 0, color: tide.text, textShadowRadius: 0 },
  reading: { fontFamily: fonts.ui, fontSize: 14, lineHeight: 17, letterSpacing: 0.56, color: tide.text, marginTop: 4 },
  gloss: { fontFamily: fonts.ui, fontSize: 12.5, lineHeight: 15, color: tide.textDim, marginTop: 2, textAlign: 'center' },
});
