import {
  Blur,
  Canvas,
  Circle,
  DashPathEffect,
  Fill,
  Group,
  Paint,
  Path,
  RadialGradient,
  Skia,
} from '@shopify/react-native-skia';
import { useEffect, useRef, useState } from 'react';
import { Pressable, StyleSheet, Text, View, useWindowDimensions } from 'react-native';
import Animated, {
  Easing,
  FadeOut,
  cancelAnimation,
  useAnimatedStyle,
  useDerivedValue,
  useReducedMotion,
  useSharedValue,
  withRepeat,
  withTiming,
} from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { type GuideKind, GuideBubble } from '@/components/onboarding/guide-bubble';
import { fonts } from '@/constants/fonts';

import bubbles from '../../../assets/images/guide/guide-bubbles.json';

/** A lit area in window coordinates. `radius` defaults to a pill (h / 2). `aside`: lit and tappable, but no say in the bubble's place. */
/** `hitInset`: the touch gap is this much smaller a side than the lit area, so a neighbour inside the glow stays blocked. */
export type GuideHole = { x: number; y: number; width: number; height: number; radius?: number; aside?: boolean; hitInset?: number };

export type GuideLayerProps = {
  /** 0, 1 or 2 lit areas, already inflated to what should show. */
  holes: GuideHole[];
  /** Extra lit areas that are for reading only: no touch gap and no say in the bubble's place. */
  seeThrough?: GuideHole[];
  /** Where the H04 tap hint sits. Omit for no hint. `scale` shrinks its rings (default 1), for a small control with a label beside it. */
  hint?: { x: number; y: number; scale?: number };
  /** The hint has been used: the mid ring dips once and the group fades. */
  stopped?: boolean;
  /** One bubble, or the moment's pages in order: a tap outside the holes turns to the next. */
  bubble: { kind: GuideKind; text: string | string[]; top?: number };
  /**
   * The page that says what to tap, the last page by default. Before it the holes are not lit
   * (no rim, no hint, a faint hole) and a tap anywhere, a hole included, turns the page.
   */
  litPage?: number;
  /** Shows on every page of the bubble. */
  chip?: { text: string; place: 'below' | 'above' };
  /** Dim strength, 0.45 by default. */
  dimOpacity?: number;
  /** When set, one full-screen press target sits over the dim. Fires on the bubble's last page only. */
  tapAnywhere?: () => void;
  /** A tap outside the holes while they stay touchable, on the bubble's last page (the add sheet closes). */
  onTapOutside?: () => void;
  /** False fades the dim out and hides the hint and bubble (the real run is on screen). */
  enabled?: boolean;
};

const SLACK = 60;
const RIM_GROW = 3;
const LOOP_MS = 2400;
const SPIN_MS = 12000;
const FADE_MS = 240;
const MOVE = { duration: 350, easing: Easing.inOut(Easing.cubic) };
const GLOW_R = 48;
const OUTER_R = 34;
const MID_R = 23;
const BUBBLE_SIDE = 60;
/** The "next:" chip's height: 12 pt text, 4 pt padding a side, a 1 pt border. */
const CHIP_H = 26;
/** What a 'below' chip takes under its bubble: its 4 pt gap and its height. A bubble parked at the bottom leaves this much room. */
export const GUIDE_CHIP_ROOM = 4 + CHIP_H;
/** The chip's least gap above the home indicator (or the bottom edge where there is none). */
const CHIP_EDGE = 8;
/** The outgoing page's fade while the next page's bubble rises in (GuideBubble's own 260 ms entrance). */
const PAGE_OUT_MS = 160;
/** The rim and hint fading in on the page that says what to tap. */
const LIT_MS = 220;
/** How much of the dim a hole keeps before its page: it shows at about 35 % of its lit strength. */
const UNLIT_DIM = 0.65;

/** The bubble's height as GuideLayer draws it: 60 pt narrower than the screen, at the art's aspect. */
export function guideBubbleHeight(kind: GuideKind, screenW: number): number {
  const bw = Math.max(0, screenW - BUBBLE_SIDE);
  const spec = bubbles[kind];
  return (bw * spec.size[1]) / spec.size[0];
}

/** A finite value in [0, 1], or 0. */
function unit(v: number): number {
  'worklet';
  return Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : 0;
}

/** A finite value, or 0. */
function num(v: number): number {
  'worklet';
  return Number.isFinite(v) ? v : 0;
}

function ease(k: number): number {
  'worklet';
  return k * k * (3 - 2 * k);
}

/** H04 press dip: 1 at 0 and 40 %, 0.88 from 50 to 58 %, 1 at 100 %, ease-in-out. */
function dip(q: number): number {
  'worklet';
  if (q <= 0.4) return 1;
  if (q < 0.5) return 1 - 0.12 * ease((q - 0.4) / 0.1);
  if (q <= 0.58) return 0.88;
  return 0.88 + 0.12 * ease((q - 0.58) / 0.42);
}

/** The first `n` of two rounded rects (x, y, w, h, r each) as one path, moved by `off` and grown by `grow`. */
function holePath(v: number[], off: number, grow: number, n = 2) {
  'worklet';
  const p = Skia.Path.Make();
  for (let i = 0; i < Math.min(2, n); i++) {
    const x = num(v[i * 5]);
    const y = num(v[i * 5 + 1]);
    const w = num(v[i * 5 + 2]);
    const h = num(v[i * 5 + 3]);
    if (w <= 0 || h <= 0) continue;
    const r = Math.max(0, Math.min(num(v[i * 5 + 4]) + grow, (w + 2 * grow) / 2, (h + 2 * grow) / 2));
    p.addRRect(Skia.RRectXY(Skia.XYWHRect(x - grow + off, y - grow + off, w + 2 * grow, h + 2 * grow), r, r));
  }
  return p;
}

function flatten(holes: GuideHole[]): number[] {
  const out: number[] = [];
  for (let i = 0; i < 2; i++) {
    const h = holes[i];
    if (!h) {
      out.push(0, 0, 0, 0, 0);
      continue;
    }
    const w = Number.isFinite(h.width) ? Math.max(0, h.width) : 0;
    const ht = Number.isFinite(h.height) ? Math.max(0, h.height) : 0;
    out.push(
      Number.isFinite(h.x) ? h.x : 0,
      Number.isFinite(h.y) ? h.y : 0,
      w,
      ht,
      h.radius !== undefined && Number.isFinite(h.radius) ? h.radius : ht / 2,
    );
  }
  return out;
}

/**
 * Transparent touch sinks over the whole layer except the holes' own boxes (one
 * full-screen sink with none). The layer is cut into horizontal bands at every
 * hole edge and each band is sunk outside its holes, so the space between two
 * holes (the Easy chip and the dock's Shadow) is blocked too. The last band runs
 * to the layer's bottom edge, the home indicator included.
 */
export function guideBlockers(holes: GuideHole[], onTap?: () => void) {
  const sink = (k: string, style: object) =>
    onTap ? (
      <Pressable key={k} style={[styles.sink, style]} onPress={onTap} />
    ) : (
      <View key={k} style={[styles.sink, style]} onStartShouldSetResponder={() => true} />
    );
  const lit = holes
    .map((h) => {
      const k = h.hitInset !== undefined && Number.isFinite(h.hitInset) ? Math.max(0, h.hitInset) : 0;
      return { x: h.x + k, y: h.y + k, width: h.width - 2 * k, height: h.height - 2 * k };
    })
    .filter((h) => [h.x, h.y, h.width, h.height].every(Number.isFinite) && h.width > 0 && h.height > 0);
  if (lit.length === 0) return sink('all', { top: 0, left: 0, right: 0, bottom: 0 });
  const edges = [...new Set([Math.min(0, ...lit.map((h) => h.y)), ...lit.flatMap((h) => [h.y, h.y + h.height])])].sort((a, b) => a - b);
  const out = [];
  for (let i = 0; i < edges.length; i++) {
    const y0 = edges[i];
    const y1 = edges[i + 1];
    const band = y1 === undefined ? { top: y0, bottom: 0 } : { top: y0, height: y1 - y0 };
    const spans = lit
      .filter((h) => y1 !== undefined && h.y < y1 && h.y + h.height > y0)
      .map((h) => [h.x, h.x + h.width])
      .sort((a, b) => a[0] - b[0]);
    let from = Math.min(0, ...spans.map((s) => s[0]));
    for (const [a, b] of spans) {
      if (a > from) out.push(sink(`${i}-${from}`, { ...band, left: from, width: a - from }));
      from = Math.max(from, b);
    }
    out.push(sink(`${i}-end`, { ...band, left: from, right: 0 }));
  }
  return <>{out}</>;
}

/**
 * The guide overlay: a dim with rounded holes around what to tap, a rim, the
 * H04 tap hint, a Kageneko bubble, an optional "next:" chip. While enabled it
 * swallows every touch outside its holes (no exit while the guide runs); the
 * dim, rim and hint themselves ignore touches.
 */
export function GuideLayer(p: GuideLayerProps) {
  const reduced = useReducedMotion();
  const { width: W, height: H } = useWindowDimensions();
  const insets = useSafeAreaInsets();
  const enabled = p.enabled !== false;

  // The bubble's pages. The page is kept against the first text, so a new moment starts on page 1
  // while a hole that moves within the moment (Practice's 5, then Practice now) keeps the page.
  const texts = Array.isArray(p.bubble.text) ? p.bubble.text : [p.bubble.text];
  const first = texts[0] ?? '';
  const [paged, setPaged] = useState({ key: first, page: 0 });
  const page = paged.key === first ? Math.min(paged.page, texts.length - 1) : 0;
  const last = page >= texts.length - 1;
  const text = texts[page] ?? first;
  const turn = () => setPaged({ key: first, page: page + 1 });
  const litAt = p.litPage !== undefined && Number.isFinite(p.litPage) ? Math.max(0, Math.min(p.litPage, texts.length - 1)) : texts.length - 1;
  const lit = page >= litAt;
  // The holes' share of the two slots: a see-through card keeps its full light on every page.
  const targets = Math.min(2, p.holes.length);

  // 1 once the page that says what to tap is up. A moment that opens on it is lit at once.
  const litV = useSharedValue(lit ? 1 : 0);
  useEffect(() => {
    litV.value = reduced ? (lit ? 1 : 0) : withTiming(lit ? 1 : 0, { duration: LIT_MS, easing: Easing.out(Easing.quad) });
    return () => cancelAnimation(litV);
  }, [lit, reduced, litV]);

  const flat = flatten([...p.holes, ...(p.seeThrough ?? [])].slice(0, 2));
  const key = flat.join(',');
  const hv = useSharedValue<number[]>(flat);
  const placedHoles = useRef(false);
  useEffect(() => {
    const target = key.split(',').map(Number);
    // The first placement lands under the dim's own fade-in, so it snaps.
    if (!placedHoles.current || reduced) {
      hv.value = target;
      placedHoles.current = true;
      return;
    }
    // A hole that appears grows out of its own centre and one that goes
    // shrinks into it, instead of flying in from (0, 0) or cutting out.
    const from = hv.value.slice(0, 10);
    for (let i = 0; i < 2; i++) {
      const o = i * 5;
      const had = from[o + 2] > 0 && from[o + 3] > 0;
      const has = target[o + 2] > 0 && target[o + 3] > 0;
      if (!had && has) from.splice(o, 5, target[o] + target[o + 2] / 2, target[o + 1] + target[o + 3] / 2, 0, 0, 0);
      else if (had && !has) target.splice(o, 5, from[o] + from[o + 2] / 2, from[o + 1] + from[o + 3] / 2, 0, 0, 0);
    }
    hv.value = from;
    hv.value = withTiming(target, MOVE);
  }, [key, reduced, hv]);

  const hx = p.hint?.x;
  const hy = p.hint?.y;
  const haveHint = hx !== undefined && hy !== undefined && Number.isFinite(hx) && Number.isFinite(hy);
  const hs = p.hint?.scale;
  const ringK = hs !== undefined && Number.isFinite(hs) && hs > 0 ? hs : 1;
  const cx = useSharedValue(0);
  const cy = useSharedValue(0);
  const placedHint = useRef(false);
  useEffect(() => {
    if (!haveHint) {
      placedHint.current = false;
      return;
    }
    if (!placedHint.current || reduced) {
      cx.value = hx;
      cy.value = hy;
      placedHint.current = true;
      return;
    }
    cx.value = withTiming(hx, MOVE);
    cy.value = withTiming(hy, MOVE);
  }, [haveHint, hx, hy, reduced, cx, cy]);

  const fade = useSharedValue(0);
  useEffect(() => {
    fade.value = withTiming(enabled ? 1 : 0, { duration: FADE_MS, easing: Easing.out(Easing.quad) });
    return () => cancelAnimation(fade);
  }, [enabled, fade]);
  const dimStyle = useAnimatedStyle(() => ({ opacity: num(fade.value) }));
  const rimStyle = useAnimatedStyle(() => ({ opacity: num(fade.value) * unit(litV.value) }));

  // The loops restart when the moment changes (the hole key) or the hint is
  // re-armed. `live` is the 200 ms fade after a tap, `stopDip` the one dip.
  const progress = useSharedValue(0);
  const spin = useSharedValue(0);
  const rmPulse = useSharedValue(0);
  const live = useSharedValue(1);
  const stopDip = useSharedValue(0);
  const stopped = !!p.stopped;
  useEffect(() => {
    if (!enabled || stopped || !haveHint) return;
    live.value = 1;
    stopDip.value = 0;
    if (reduced) {
      rmPulse.value = 0;
      rmPulse.value = withRepeat(withTiming(1, { duration: LOOP_MS / 2, easing: Easing.inOut(Easing.ease) }), -1, true);
      return () => cancelAnimation(rmPulse);
    }
    progress.value = 0;
    progress.value = withRepeat(withTiming(1, { duration: LOOP_MS, easing: Easing.linear }), -1, false);
    spin.value = 0;
    spin.value = withRepeat(withTiming(1, { duration: SPIN_MS, easing: Easing.linear }), -1, false);
    return () => {
      cancelAnimation(progress);
      cancelAnimation(spin);
    };
  }, [enabled, stopped, haveHint, reduced, key, progress, spin, rmPulse, live, stopDip]);

  useEffect(() => {
    if (!stopped) return;
    cancelAnimation(progress);
    cancelAnimation(rmPulse);
    progress.value = 0;
    stopDip.value = withTiming(1, { duration: 120, easing: Easing.inOut(Easing.ease) });
    live.value = withTiming(0, { duration: 200, easing: Easing.out(Easing.quad) });
    return () => {
      cancelAnimation(stopDip);
      cancelAnimation(live);
    };
  }, [stopped, progress, rmPulse, stopDip, live]);

  const dimPath = useDerivedValue(() => holePath(hv.value, SLACK, 0));
  const rimPath = useDerivedValue(() => holePath(hv.value, 0, RIM_GROW));
  const targetPath = useDerivedValue(() => holePath(hv.value, SLACK, 0, targets));
  const unlitOp = useDerivedValue(() => UNLIT_DIM * (1 - unit(litV.value)));
  const centre = useDerivedValue(() => ({ x: num(cx.value), y: num(cy.value) }));
  const hintOp = useDerivedValue(() => {
    const base = reduced ? 0.55 + 0.45 * unit(rmPulse.value) : 1;
    return base * num(fade.value) * num(live.value) * unit(litV.value);
  });
  const glowOp = useDerivedValue(() => (reduced ? 0.4 : 0.3 - 0.1 * Math.cos(2 * Math.PI * unit(progress.value))));
  const spinXf = useDerivedValue(() => [
    { translateX: num(cx.value) },
    { translateY: num(cy.value) },
    { rotate: reduced ? 0 : 2 * Math.PI * unit(spin.value) },
  ]);
  const midXf = useDerivedValue(() => {
    const s = stopped ? 1 - 0.12 * unit(stopDip.value) : reduced ? 1 : dip(unit(progress.value));
    return [{ translateX: num(cx.value) }, { translateY: num(cy.value) }, { scale: s }];
  });

  // The bubble: 60 pt narrower than the screen, on the side away from the hole.
  const bw = Math.max(0, W - BUBBLE_SIDE);
  const bh = guideBubbleHeight(p.bubble.kind, W);
  const lead = p.holes.filter((h) => !h.aside).reduce<GuideHole | null>((a, b) => (!a || b.y < a.y ? b : a), null);
  const bubbleLeft = lead && lead.x > W / 2 ? 50 : 10;
  const bubbleTop = p.bubble.top ?? (lead ? (lead.y > 400 ? lead.y - bh - 24 : lead.y + lead.height + 22) : 300);
  const chipLeft = bubbleLeft + 0.46 * bw;
  // The chip never leaves the screen: a bubble parked at the bottom keeps it clear of the home indicator and the bottom edge.
  const chipTop = Math.min(p.chip?.place === 'above' ? bubbleTop - 34 : bubbleTop + bh + 4, H - insets.bottom - CHIP_H - CHIP_EDGE);
  const dimA = p.dimOpacity !== undefined && Number.isFinite(p.dimOpacity) ? p.dimOpacity : 0.45;

  return (
    <View style={[StyleSheet.absoluteFill, styles.top]} pointerEvents="box-none">
      <Animated.View style={[styles.dim, dimStyle]} pointerEvents="none">
        <Canvas style={StyleSheet.absoluteFill}>
          <Group layer={<Paint><Blur blur={6} /></Paint>}>
            <Group clip={dimPath} invertClip>
              <Fill color={`rgba(4,7,14,${dimA})`} />
            </Group>
            <Group clip={targetPath} opacity={unlitOp}>
              <Fill color={`rgba(4,7,14,${dimA})`} />
            </Group>
          </Group>
        </Canvas>
      </Animated.View>
      {p.holes.length > 0 ? (
        <Animated.View style={[StyleSheet.absoluteFill, rimStyle]} pointerEvents="none">
          <Canvas style={StyleSheet.absoluteFill}>
            <Path path={rimPath} style="stroke" strokeWidth={1.5} color="rgba(124,200,255,0.6)" />
          </Canvas>
        </Animated.View>
      ) : null}
      {haveHint ? (
        <View style={StyleSheet.absoluteFill} pointerEvents="none">
          <Canvas style={StyleSheet.absoluteFill}>
            <Group opacity={hintOp}>
              <Group opacity={glowOp}>
                <Circle c={centre} r={GLOW_R * ringK}>
                  <RadialGradient
                    c={centre}
                    r={GLOW_R * ringK}
                    colors={['rgba(160,220,255,0.5)', 'rgba(160,220,255,0)']}
                    positions={[0, 0.7]}
                  />
                </Circle>
              </Group>
              <Group transform={spinXf}>
                <Circle c={{ x: 0, y: 0 }} r={OUTER_R * ringK} style="stroke" strokeWidth={1.5} color="rgba(160,220,255,0.55)">
                  <DashPathEffect intervals={[4, 4]} />
                </Circle>
              </Group>
              <Group transform={midXf}>
                <Circle c={{ x: 0, y: 0 }} r={MID_R * ringK} style="stroke" strokeWidth={2} color="rgba(210,240,255,0.9)" />
              </Group>
            </Group>
          </Canvas>
        </View>
      ) : null}
      {p.tapAnywhere ? <Pressable style={StyleSheet.absoluteFill} onPress={last ? p.tapAnywhere : turn} /> : null}
      {/* Before the page that says what to tap there is no touch gap: the lit control waits for its line. */}
      {enabled && !p.tapAnywhere ? guideBlockers(lit ? p.holes : [], last ? p.onTapOutside : turn) : null}
      {/* The bubble and chip fade out with the dim instead of leaving in one frame. A page turn
          crossfades: the old page fades over PAGE_OUT_MS while the new one rises in. */}
      <Animated.View style={[StyleSheet.absoluteFill, dimStyle]} pointerEvents="none">
        <Animated.View
          key={text}
          exiting={reduced ? undefined : FadeOut.duration(PAGE_OUT_MS)}
          style={[styles.bubble, { top: bubbleTop, left: bubbleLeft, width: bw }]}
          pointerEvents="none">
          <GuideBubble kind={p.bubble.kind} text={text} width={bw} more={!last} />
        </Animated.View>
        {p.chip ? (
          <View style={[styles.chip, { top: chipTop, left: chipLeft }]} pointerEvents="none">
            <Text style={styles.chipText}>{p.chip.text}</Text>
          </View>
        ) : null}
      </Animated.View>
    </View>
  );
}

const styles = StyleSheet.create({
  dim: { position: 'absolute', left: -SLACK, top: -SLACK, right: -SLACK, bottom: -SLACK },
  // Over every sibling, Android's elevated glass included, so no control pokes through the sinks.
  // `dim` reaches SLACK past every edge so the blurred clip never shows a seam; hidden keeps that bleed from widening the web page.
  top: { zIndex: 1000, elevation: 1000, overflow: 'hidden' },
  sink: { position: 'absolute' },
  bubble: { position: 'absolute' },
  chip: {
    position: 'absolute',
    paddingVertical: 4,
    paddingHorizontal: 10,
    borderRadius: 999,
    borderWidth: 1,
    borderStyle: 'dashed',
    borderColor: 'rgba(124,200,255,0.6)',
    backgroundColor: 'rgba(40,70,110,0.85)',
  },
  chipText: { fontFamily: fonts.uiMedium, fontSize: 12, color: '#CFE3FF' },
});
