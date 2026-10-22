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
  FadeIn,
  FadeOut,
  cancelAnimation,
  useAnimatedStyle,
  useDerivedValue,
  useReducedMotion,
  useSharedValue,
  withRepeat,
  withSequence,
  withSpring,
  withTiming,
} from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { type GuideKind, GuideBubble } from '@/components/onboarding/guide-bubble';
import { GuidePointer, POINTER_BOB, POINTER_H } from '@/components/onboarding/guide-pointer';
import { fonts } from '@/constants/fonts';
import { prism, tide } from '@/constants/theme';
import { hapticSelection } from '@/lib/haptics';
import { useT } from '@/lib/i18n';

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
  /** Dim strength, 0.75 by default. */
  dimOpacity?: number;
  /** When set, one full-screen press target sits over the dim. Fires on the bubble's last page only. */
  tapAnywhere?: () => void;
  /** A tap outside the holes while they stay touchable, on the bubble's last page (the beta note ends). */
  onTapOutside?: () => void;
  /** False fades the dim out and hides the hint and bubble (the real run is on screen). */
  enabled?: boolean;
  /** The late exit: a "Skip the intro" pill under the bubble after three misses or 20 s on the action page. */
  onSkip?: () => void;
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
/** The "Tap anywhere to go on" chip and the skip pill: 14 and 13 pt text, 6 pt padding a side, a 1 pt border. */
const AUX_H = 32;
/** The outgoing page's fade while the next page's bubble rises in (GuideBubble's own 260 ms entrance). */
const PAGE_OUT_MS = 160;
/** The rim and hint fading in on the page that says what to tap. */
const LIT_MS = 220;
/** How much of the dim a hole keeps before its page: it shows at about 35 % of its lit strength. */
const UNLIT_DIM = 0.65;
/** The pointer's tip rests this far outside the rim, on the bubble's side (r3-v05: 12 pt above the ring). */
const POINTER_GAP = 12;
/** The miss ladder: a tap nothing answers on the action page, or the same idle time, climbs a rung. */
const MISS_IDLE_MS = [6000, 14000, 20000];
/** The "Tap here" label's stay after the first rung; from the second it stays. */
const LABEL_STAY_MS = 2200;
const LABEL_IN_MS = 160;
const LABEL_H = 36;
/** The label sits this far past the hole or the grown outer ring, whichever reaches further. */
const LABEL_GAP = 10;
/** A side needs this much room for the label; with less on both sides it goes past the pointer instead. */
const LABEL_ROOM = 120;
/** The rings grow to this from the second rung (less where the screen edge is closer than the grown ring). */
const MISS_RING = 1.4;
/** Free-spot search: the step between candidate rows, and how far the label, pointer and skip pill keep from what is lit. */
const SPOT_STEP = 4;
const SPOT_PAD = 4;
/** The share of the screen height that counts as its bottom or top band for the skip pill. */
const SKIP_BAND = 0.25;

type Rect = { x: number; y: number; w: number; h: number };
const hits = (a: Rect, b: Rect) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
const pad = (r: Rect, by: number): Rect => ({ x: r.x - by, y: r.y - by, w: r.w + 2 * by, h: r.h + 2 * by });

/** The first of `xs` x `ys` where a w x h box fits inside `bounds` and clear of every obstacle, lowest `score` first (`ys` order breaks ties). */
function freeSpot(w: number, h: number, bounds: Rect, obstacles: Rect[], xs: number[], ys: number[], score?: (r: Rect) => number): Rect | null {
  let best: Rect | null = null;
  let bestScore = Infinity;
  for (const y of ys) {
    for (const x0 of xs) {
      const x = Math.min(Math.max(x0, bounds.x), bounds.x + bounds.w - w);
      const r = { x, y, w, h };
      if (y < bounds.y || y + h > bounds.y + bounds.h || obstacles.some((o) => hits(r, o))) continue;
      const sc = score ? score(r) : 0;
      if (sc < bestScore) {
        best = r;
        bestScore = sc;
      }
      if (!score) return r;
    }
  }
  return best;
}
const range = (from: number, to: number) => {
  const out: number[] = [];
  const dir = to >= from ? 1 : -1;
  for (let v = from; dir > 0 ? v <= to : v >= to; v += dir * SPOT_STEP) out.push(v);
  return out;
};
/** The mid ring and the rim bounce to this on a miss. */
const BOUNCE = 0.18;

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

/** Slots `from` to `n` of two rounded rects (x, y, w, h, r each) as one path, moved by `off` and grown by `grow`. */
function holePath(v: number[], off: number, grow: number, n = 2, from = 0) {
  'worklet';
  const p = Skia.Path.Make();
  for (let i = from; i < Math.min(2, n); i++) {
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
 * H04 tap hint with the prism pointer, a Kageneko bubble, an optional "next:"
 * chip. While enabled it swallows every touch outside its holes; on the action
 * page a swallowed tap (or idle time) climbs the miss ladder: the target bounces
 * with a "Tap here" label, then the rings grow, then a "Skip the intro" pill
 * appears. The dim, rim and hint themselves ignore touches.
 */
export function GuideLayer(p: GuideLayerProps) {
  const reduced = useReducedMotion();
  const { t, rtl } = useT();
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
  /** The lead hole: the pointer, the miss label and the bounce belong to it. */
  const target = p.holes[0];

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
    const to = key.split(',').map(Number);
    // The first placement lands under the dim's own fade-in, so it snaps.
    if (!placedHoles.current || reduced) {
      hv.value = to;
      placedHoles.current = true;
      return;
    }
    // A hole that appears grows out of its own centre and one that goes
    // shrinks into it, instead of flying in from (0, 0) or cutting out.
    const from = hv.value.slice(0, 10);
    for (let i = 0; i < 2; i++) {
      const o = i * 5;
      const had = from[o + 2] > 0 && from[o + 3] > 0;
      const has = to[o + 2] > 0 && to[o + 3] > 0;
      if (!had && has) from.splice(o, 5, to[o] + to[o + 2] / 2, to[o + 1] + to[o + 3] / 2, 0, 0, 0);
      else if (had && !has) to.splice(o, 5, from[o] + from[o + 2] / 2, from[o + 1] + from[o + 3] / 2, 0, 0, 0);
    }
    hv.value = from;
    hv.value = withTiming(to, MOVE);
  }, [key, reduced, hv]);

  const hx = p.hint?.x;
  const hy = p.hint?.y;
  const haveHint = hx !== undefined && hy !== undefined && Number.isFinite(hx) && Number.isFinite(hy);
  const hs = p.hint?.scale;
  const ringK = hs !== undefined && Number.isFinite(hs) && hs > 0 ? hs : 1;
  // The grown ring never reaches past the screen edge: with the target near a corner the growth stops where the ring touches it.
  const edge = haveHint ? Math.min(hx, W - hx, hy, H - hy) - 2 : Infinity;
  const missRing = Math.min(MISS_RING, Math.max(1, edge / (OUTER_R * ringK)));
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

  // The miss ladder lives on the action page: the lit target, the last page, no tap-anywhere.
  // Idle time climbs it on its own; a swallowed tap climbs it only where no handler answers
  // (the beta note answers a tap outside by ending).
  const armed = enabled && lit && last && !p.tapAnywhere && p.holes.length > 0;
  // The rung is kept against the hole key and the page, so a new moment or page starts at 0.
  const stamp = `${key}|${page}`;
  const [rung, setRung] = useState({ stamp, misses: 0 });
  const misses = rung.stamp === stamp ? rung.misses : 0;
  const climb = (to: (m: number) => number) => setRung((r) => ({ stamp, misses: Math.min(MISS_IDLE_MS.length, to(r.stamp === stamp ? r.misses : 0)) }));
  useEffect(() => {
    if (!armed) return;
    const ids = MISS_IDLE_MS.map((ms, i) => setTimeout(() => climb((m) => Math.max(m, i + 1)), ms));
    return () => ids.forEach(clearTimeout);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [armed, stamp]);
  const miss = () => climb((m) => m + 1);
  // The first rung's label leaves after its stay; `expired` names the stamp whose label has gone.
  const [expired, setExpired] = useState('');
  const labelOn = misses >= 2 || (misses === 1 && expired !== stamp);
  const bounce = useSharedValue(0);
  const grow = useSharedValue(0);
  useEffect(() => {
    if (misses === 0) return;
    void hapticSelection();
    if (!reduced) {
      bounce.value = 0;
      bounce.value = withSequence(withTiming(1, { duration: 120, easing: Easing.out(Easing.quad) }), withSpring(0, { damping: 12, stiffness: 300 }));
    }
    if (misses >= 2) return;
    const id = setTimeout(() => setExpired(stamp), LABEL_STAY_MS);
    return () => clearTimeout(id);
  }, [misses, stamp, reduced, bounce]);
  useEffect(() => {
    grow.value = reduced ? (misses >= 2 ? 1 : 0) : withTiming(misses >= 2 ? 1 : 0, MOVE);
  }, [misses, reduced, grow]);

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

  // The bubble: 60 pt narrower than the screen, on the side away from the hole.
  const bw = Math.max(0, W - BUBBLE_SIDE);
  const bh = guideBubbleHeight(p.bubble.kind, W);
  const lead = p.holes.filter((h) => !h.aside).reduce<GuideHole | null>((a, b) => (!a || b.y < a.y ? b : a), null);
  const bubbleLeft = lead && lead.x > W / 2 ? 50 : 10;
  const bubbleTop = p.bubble.top ?? (lead ? (lead.y > 400 ? lead.y - bh - 24 : lead.y + lead.height + 22) : 300);
  const chipLeft = bubbleLeft + 0.46 * bw;
  // The chip never leaves the screen: a bubble parked at the bottom keeps it clear of the home indicator and the bottom edge.
  const chipTop = Math.min(p.chip?.place === 'above' ? bubbleTop - 34 : bubbleTop + bh + 4, H - insets.bottom - CHIP_H - CHIP_EDGE);
  const dimA = p.dimOpacity !== undefined && Number.isFinite(p.dimOpacity) ? p.dimOpacity : 0.75;
  // The pointer sits between the bubble and its target: it points down unless the bubble is wholly below the hole.
  const pointDown = !target || bubbleTop < target.y + target.height;
  // The "Tap anywhere" chip and the skip pill: under the bubble when that is clear of the bottom edge and
  // the target, else above it (and above an 'above' chip).
  const auxTop = (gap: number) => {
    const under = bubbleTop + bh + gap;
    const limit = Math.min(H - insets.bottom - CHIP_EDGE, target && target.y >= bubbleTop + bh ? target.y - RIM_GROW - gap : Infinity);
    if (p.chip?.place !== 'below' && under + AUX_H <= limit) return under;
    return (p.chip?.place === 'above' ? chipTop : bubbleTop) - gap - AUX_H;
  };

  const dimPath = useDerivedValue(() => holePath(hv.value, SLACK, 0));
  const rimLead = useDerivedValue(() => holePath(hv.value, 0, RIM_GROW, 1));
  const rimRest = useDerivedValue(() => holePath(hv.value, 0, RIM_GROW, 2, 1));
  const targetPath = useDerivedValue(() => holePath(hv.value, SLACK, 0, targets));
  const unlitOp = useDerivedValue(() => UNLIT_DIM * (1 - unit(litV.value)));
  const centre = useDerivedValue(() => ({ x: num(cx.value), y: num(cy.value) }));
  const hintOp = useDerivedValue(() => {
    const base = reduced ? 0.55 + 0.45 * unit(rmPulse.value) : 1;
    return base * num(fade.value) * num(live.value) * unit(litV.value);
  });
  const glowOp = useDerivedValue(() => (reduced ? 0.4 : 0.3 - 0.1 * Math.cos(2 * Math.PI * unit(progress.value))));
  const glowR = useDerivedValue(() => GLOW_R * ringK * (1 + (missRing - 1) * unit(grow.value)));
  const spinXf = useDerivedValue(() => [
    { translateX: num(cx.value) },
    { translateY: num(cy.value) },
    { rotate: reduced ? 0 : 2 * Math.PI * unit(spin.value) },
    { scale: 1 + (missRing - 1) * unit(grow.value) },
  ]);
  const midXf = useDerivedValue(() => {
    const s = stopped ? 1 - 0.12 * unit(stopDip.value) : reduced ? 1 : dip(unit(progress.value));
    const k = (1 + BOUNCE * unit(bounce.value)) * (1 + (missRing - 1) * unit(grow.value));
    return [{ translateX: num(cx.value) }, { translateY: num(cy.value) }, { scale: s * k }];
  });
  // The lead hole's rim bounces about its own centre; a second hole's rim stays put.
  const rimXf = useDerivedValue(() => {
    const v = hv.value;
    const x = num(v[0]) + num(v[2]) / 2;
    const y = num(v[1]) + num(v[3]) / 2;
    const s = 1 + BOUNCE * unit(bounce.value);
    return [{ translateX: x }, { translateY: y }, { scale: s }, { translateX: -x }, { translateY: -y }];
  });
  // A hole much bigger than the ring (the topic grid, a card) is not the target: the tip rests past the ring instead.
  const aimRing = haveHint && !!target && (target.width > 2 * OUTER_R * ringK + 24 || target.height > 2 * OUTER_R * ringK + 24);
  const tip = useDerivedValue(() => {
    const v = hv.value;
    const y = num(v[1]);
    const h = num(v[3]);
    const reach = OUTER_R * ringK * (1 + (missRing - 1) * unit(grow.value));
    if (aimRing) return { x: num(cx.value), y: pointDown ? num(cy.value) - reach - POINTER_GAP : num(cy.value) + reach + POINTER_GAP };
    return { x: num(cx.value), y: pointDown ? y - RIM_GROW - POINTER_GAP : y + h + RIM_GROW + POINTER_GAP };
  });
  const pointer = haveHint && !!target && !p.tapAnywhere;

  // Free spots: the label, the pointer and the skip pill each sit clear of every lit hole, the grown ring,
  // the bubble, the chips and each other.
  const holeBoxes: Rect[] = [...p.holes, ...(p.seeThrough ?? [])]
    .filter((h) => [h.x, h.y, h.width, h.height].every(Number.isFinite) && h.width > 0 && h.height > 0)
    .map((h) => pad({ x: h.x, y: h.y, w: h.width, h: h.height }, RIM_GROW + SPOT_PAD));
  const reachMax = OUTER_R * ringK * missRing;
  const ringBox: Rect | null = haveHint ? pad({ x: hx, y: hy, w: 0, h: 0 }, reachMax + SPOT_PAD) : null;
  const pointerBox: Rect | null =
    haveHint && target && !p.tapAnywhere
      ? (() => {
          const tipY = aimRing ? (pointDown ? hy - reachMax - POINTER_GAP : hy + reachMax + POINTER_GAP) : pointDown ? target.y - RIM_GROW - POINTER_GAP : target.y + target.height + RIM_GROW + POINTER_GAP;
          const len = POINTER_H + POINTER_BOB;
          return pad({ x: hx - 26, y: pointDown ? tipY - len : tipY, w: 52, h: len }, SPOT_PAD);
        })()
      : null;
  const bubbleBox = pad({ x: bubbleLeft, y: bubbleTop, w: bw, h: bh }, SPOT_PAD);
  const chipBox: Rect | null = p.chip ? pad({ x: chipLeft, y: chipTop, w: p.chip.text.length * 7 + 22, h: CHIP_H }, SPOT_PAD) : null;
  const goOnBox: Rect | null = !last ? pad({ x: bubbleLeft, y: auxTop(4), w: t('guide.goOn').length * 8 + 26, h: AUX_H }, SPOT_PAD) : null;
  const fixed = [...holeBoxes, bubbleBox, ...(ringBox ? [ringBox] : []), ...(pointerBox ? [pointerBox] : []), ...(chipBox ? [chipBox] : []), ...(goOnBox ? [goOnBox] : [])];
  const bounds: Rect = { x: CHIP_EDGE, y: insets.top + SPOT_PAD, w: Math.max(0, W - 2 * CHIP_EDGE), h: Math.max(0, H - insets.bottom - CHIP_EDGE - insets.top - SPOT_PAD) };
  const allY = range(bounds.y, bounds.y + bounds.h);

  // The "Tap here" label: past the hole and the grown outer ring on the side with more room, level with
  // the hint; with no room on either side it goes past the pointer, centred on it.
  let label: { top: number; left: number; right: number; align: 'flex-start' | 'flex-end' | 'center' } | null = null;
  const labelW = Math.min(bounds.w, t('guide.tapHere').length * 10 + 32);
  const labelSpot =
    target && haveHint && labelOn
      ? freeSpot(labelW, LABEL_H, bounds, fixed, [hx + reachMax + LABEL_GAP, hx - reachMax - LABEL_GAP - labelW, hx - labelW / 2, bounds.x, bounds.x + bounds.w], allY, (r) => Math.hypot(r.x + r.w / 2 - hx, r.y + r.h / 2 - hy))
      : null;
  if (labelSpot) label = { top: labelSpot.y, left: labelSpot.x, right: W - labelSpot.x - labelSpot.w, align: 'center' };
  else if (target && haveHint) {
    const reach = reachMax;
    const rightEdge = Math.max(target.x + target.width, hx + reach) + LABEL_GAP;
    const leftEdge = Math.min(target.x, hx - reach) - LABEL_GAP;
    const roomR = W - CHIP_EDGE - rightEdge;
    const roomL = leftEdge - CHIP_EDGE;
    const top = hy - LABEL_H / 2;
    if (roomR >= LABEL_ROOM && roomR >= roomL) label = { top, left: rightEdge, right: CHIP_EDGE, align: 'flex-start' };
    else if (roomL >= LABEL_ROOM) label = { top, left: CHIP_EDGE, right: W - leftEdge, align: 'flex-end' };
    else {
      const past = RIM_GROW + POINTER_GAP + POINTER_H + POINTER_BOB + LABEL_GAP;
      label = { top: pointDown ? target.y - past - LABEL_H : target.y + target.height + past, left: CHIP_EDGE, right: CHIP_EDGE, align: 'center' };
    }
  }
  const skip = armed && misses >= MISS_IDLE_MS.length && p.onSkip ? p.onSkip : null;
  // The skip pill: the bottom band first, then the top band, then anywhere; clear of the label too.
  const skipW = Math.min(bounds.w, t('guide.skip').length * 8 + 34);
  const bandH = H * SKIP_BAND;
  const skipYs = [...range(bounds.y + bounds.h - AUX_H, H - bandH), ...range(bounds.y, bandH), ...range(bounds.y + bounds.h - AUX_H, bounds.y)];
  const skipSpot = skip
    ? freeSpot(skipW, AUX_H, bounds, [...fixed, ...(label && labelOn ? [pad({ x: label.left, y: label.top, w: labelW, h: LABEL_H }, SPOT_PAD)] : [])], [(W - skipW) / 2, bounds.x, bounds.x + bounds.w], skipYs)
    : null;

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
            <Group transform={rimXf}>
              <Path path={rimLead} style="stroke" strokeWidth={1.5} color="rgba(124,200,255,0.6)" />
            </Group>
            <Path path={rimRest} style="stroke" strokeWidth={1.5} color="rgba(124,200,255,0.6)" />
          </Canvas>
        </Animated.View>
      ) : null}
      {haveHint ? (
        <View style={StyleSheet.absoluteFill} pointerEvents="none">
          <Canvas style={StyleSheet.absoluteFill}>
            <Group opacity={hintOp}>
              <Group opacity={glowOp}>
                <Circle c={centre} r={glowR}>
                  <RadialGradient
                    c={centre}
                    r={glowR}
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
              {pointer ? <GuidePointer tip={tip} down={pointDown} rtl={rtl} reduced={reduced} active={enabled && lit && !stopped} playKey={key} /> : null}
            </Group>
          </Canvas>
        </View>
      ) : null}
      {p.tapAnywhere ? <Pressable style={StyleSheet.absoluteFill} onPress={last ? p.tapAnywhere : turn} /> : null}
      {/* Before the page that says what to tap there is no touch gap: the lit control waits for its line.
          On the action page a tap nothing answers is a miss. */}
      {enabled && !p.tapAnywhere ? guideBlockers(lit ? p.holes : [], last ? (p.onTapOutside ?? (armed ? miss : undefined)) : turn) : null}
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
          <View style={[styles.chip, styles.chipAt, { top: chipTop, left: chipLeft }]} pointerEvents="none">
            <Text style={styles.chipText}>{p.chip.text}</Text>
          </View>
        ) : null}
        {!last ? (
          <View style={[styles.auxRow, { top: auxTop(4), left: bubbleLeft, width: bw, alignItems: rtl ? 'flex-end' : 'flex-start' }]} pointerEvents="none">
            <View style={styles.chip}>
              <Text style={styles.goOnText}>{t('guide.goOn')}</Text>
            </View>
          </View>
        ) : null}
        {label && labelOn ? (
          <Animated.View
            entering={reduced ? undefined : FadeIn.duration(LABEL_IN_MS)}
            exiting={reduced ? undefined : FadeOut.duration(LABEL_IN_MS)}
            style={[styles.labelRow, { top: label.top, left: label.left, right: label.right, alignItems: label.align }]}
            pointerEvents="none">
            <View style={styles.tapHere}>
              <Text style={[styles.tapHereText, misses >= 2 && styles.tapHereBig]} numberOfLines={1}>
                {t('guide.tapHere')}
              </Text>
            </View>
          </Animated.View>
        ) : null}
      </Animated.View>
      {/* After the sinks, so the pill wins the touch. */}
      {skip ? (
        <Animated.View
          entering={reduced ? undefined : FadeIn.duration(LABEL_IN_MS)}
          style={[styles.auxRow, styles.centre, skipSpot ? { top: skipSpot.y, left: skipSpot.x, width: skipSpot.w } : { top: auxTop(6), left: bubbleLeft, width: bw }]}
          pointerEvents="box-none">
          <Pressable onPress={skip} style={({ pressed }) => [styles.skipPill, pressed && styles.pressed]} accessibilityRole="button">
            <Text style={styles.skipText}>{t('guide.skip')}</Text>
          </Pressable>
        </Animated.View>
      ) : null}
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
  chipAt: { position: 'absolute' },
  chip: {
    paddingVertical: 4,
    paddingHorizontal: 10,
    borderRadius: 999,
    borderWidth: 1,
    borderStyle: 'dashed',
    borderColor: 'rgba(124,200,255,0.6)',
    backgroundColor: 'rgba(40,70,110,0.85)',
  },
  chipText: { fontFamily: fonts.uiMedium, fontSize: 12, color: '#CFE3FF' },
  goOnText: { fontFamily: fonts.uiMedium, fontSize: 14, color: '#CFE3FF' },
  auxRow: { position: 'absolute', height: AUX_H, justifyContent: 'center' },
  centre: { alignItems: 'center' },
  labelRow: { position: 'absolute', height: LABEL_H },
  // The miss label: a 36 pt pill on prism.tray.lit.top at 0.9 with the rim's blue.
  tapHere: {
    height: LABEL_H,
    paddingHorizontal: 14,
    borderRadius: LABEL_H / 2,
    borderWidth: 1,
    borderColor: 'rgba(124,200,255,0.65)',
    backgroundColor: `${prism.tray.lit.top}E6`,
    justifyContent: 'center',
  },
  tapHereText: { fontFamily: fonts.uiMedium, fontSize: 16, color: '#FFFFFF' },
  tapHereBig: { fontSize: 18 },
  // The late exit, in the chip's dashed style.
  skipPill: {
    paddingVertical: 6,
    paddingHorizontal: 14,
    borderRadius: 999,
    borderWidth: 1,
    borderStyle: 'dashed',
    borderColor: 'rgba(124,200,255,0.6)',
    backgroundColor: 'rgba(40,70,110,0.85)',
  },
  pressed: { opacity: 0.7 },
  skipText: { fontFamily: fonts.uiMedium, fontSize: 13, color: tide.textDim },
});
