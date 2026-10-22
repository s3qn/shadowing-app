/**
 * The streak gem: the round-8 hybrid ladder (designs/bl80-streak/lockup/
 * round8-hybrid, params.md and build8.py hold the exact values). A hexagonal
 * crystal with six translucent facets and a lit table, the real 🔥 inside,
 * and the day count as a numeral with a dark outline just under the gem. Grey
 * and dim at 0 days. Ten lit tiers (streakTier in practice-card): T1 is the
 * amber H3 as picked, then copper, jade, sapphire, amethyst, ruby, gold,
 * prismatic, celestial and mythic, each adding its extras (ring, halo, rays,
 * wings, crown, pillar, angel ring, orbit sparks, prism sheen, white-hot core).
 *
 * Everything is laid out in the mock's 100x96 design space and scaled by
 * `size`, the gem's width (64 in the mock). Two Skia canvases (the under layer
 * with the extras and the frame, the over layer with the facets and numeral)
 * sit around the emoji and bleed past the box for the glows and wings; the
 * sides are clipped at `clipSides` like the mock's card, the top may bleed.
 * One shared value drives the one motion loop a tier has: the ember breath
 * up to T4, then the tier's own loop from T5 (halo breath, rays, sheen,
 * orbit, core pulse). A second value plays the tier's one-shot entrance.
 */

import { useEffect, useMemo } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { cancelAnimation, Easing, useDerivedValue, useReducedMotion, useSharedValue, withRepeat, withTiming, type SharedValue } from 'react-native-reanimated';
import { Blur, Canvas, Circle, FillType, Group, LinearGradient, Mask, Oval, Path, RadialGradient, Rect, Skia, Text as SkText, useTypeface, vec, type SkPath, type SkTypeface, type Vector } from '@shopify/react-native-skia';

const W = 100;
const H = 96;
/** Bleed around the box so the halos, rays, wings and crowns are not clipped by the canvas. */
const PAD = 48;
const GEM_W = 64;
/** The gem's box in the lockup and its centre. */
const GL = 18;
const GT = -4;
const GW = 64;
const GH = 72;
const CX = 50;
const CYG = GT + GH / 2;
/** The flame: 50pt box at (25, 9) with a blurred ember disc under it. */
const FLAME = 50;
const FLAME_X = 25;
const FLAME_Y = 9;
const EMBER = 0.35;
const DARK = '#2A1004';
/** The feather hinge: 12 either side of the centre, 10 under it. */
const HINGE_DX = 12;
const HINGE_Y = CYG + 10;
/** Orbit sparks hide once their centre is below this line (the numeral's room). */
const ORBIT_FLOOR = 60;

type Pt = [number, number];
type Box = [number, number, number, number];
/** A CSS linear-gradient: angle in degrees, colours and their stops. */
type Grad = { deg: number; colors: string[]; positions?: number[] };
const g = (deg: number, colors: string[], positions?: number[]): Grad => ({ deg, colors, positions });

/** The mock's hex: a `w` x `h` box, pointed top and bottom, sides at `yk` and `1 - yk`, scaled by `s` about its centre. */
function hexPts(l: number, t: number, w: number, h: number, s: number, yk: number): Pt[] {
  const cx = l + w / 2;
  const cy = t + h / 2;
  const raw: Pt[] = [[w / 2, 0], [w, yk * h], [w, (1 - yk) * h], [w / 2, h], [0, (1 - yk) * h], [0, yk * h]];
  return raw.map(([x, y]) => [cx + (x - w / 2) * s, cy + (y - h / 2) * s]);
}

function polygon(pts: Pt[]): SkPath {
  const p = Skia.Path.Make();
  pts.forEach(([x, y], i) => (i === 0 ? p.moveTo(x, y) : p.lineTo(x, y)));
  p.close();
  return p;
}

/** The mock's four-point star (SH4), `s` wide, centred on (cx, cy). */
function starPath(cx: number, cy: number, s: number): SkPath {
  const l = cx - s / 2;
  const t = cy - s / 2;
  const unit: Pt[] = [[0.5, 0], [0.6, 0.4], [1, 0.5], [0.6, 0.6], [0.5, 1], [0.4, 0.6], [0, 0.5], [0.4, 0.4]];
  return polygon(unit.map(([x, y]) => [l + x * s, t + y * s]));
}

/** End points of a CSS `linear-gradient(<deg>, ...)` over a box: through the centre, long enough to reach the corners. */
function cssAngle(l: number, t: number, w: number, h: number, deg: number): { start: Vector; end: Vector } {
  const a = (deg * Math.PI) / 180;
  const dx = Math.sin(a);
  const dy = -Math.cos(a);
  const len = Math.abs(w * dx) + Math.abs(h * dy);
  const cx = l + w / 2;
  const cy = t + h / 2;
  return { start: vec(cx - (dx * len) / 2, cy - (dy * len) / 2), end: vec(cx + (dx * len) / 2, cy + (dy * len) / 2) };
}

/** The mock's hex ring: `r` thick inside the `w` x `h` box at (l, t), as an even-odd path. */
function ringPath(l: number, t: number, w: number, h: number, r: number): SkPath {
  const p = polygon(hexPts(l, t, w, h, 1, 0.25));
  p.addPath(polygon(hexPts(l, t, w, h, 1 - (2 * r) / w, 0.25)));
  p.setFillType(FillType.EvenOdd);
  return p;
}

/** The mock's repeating conic rays: `n` wedges, each `wf` of its slot wide, from 0.28R out to R around (CX, cy). */
function raysPath(n: number, R: number, cy: number, wf: number): SkPath {
  const p = Skia.Path.Make();
  const seg = (2 * Math.PI) / n;
  const half = (seg * wf) / 2;
  const pt = (a: number, r: number): Pt => [CX + r * Math.sin(a), cy - r * Math.cos(a)];
  for (let i = 0; i < n; i++) {
    const c = i * seg;
    const pts: Pt[] = [pt(c - half, 0.28 * R), pt(c + half, 0.28 * R), pt(c + half, R), pt(c + half / 2, R), pt(c, R), pt(c - half / 2, R), pt(c - half, R)];
    p.addPath(polygon(pts));
  }
  return p;
}

/** The mock's feather of length L with its hinge at the origin, pointing right. */
function featherPath(L: number): SkPath {
  const hh = L * 0.3;
  const p = Skia.Path.Make();
  p.moveTo(0, 0);
  p.cubicTo(L * 0.25, -hh / 2, L * 0.7, hh * 0.1 - hh / 2, L, hh * 0.18 - hh / 2);
  p.cubicTo(L * 0.7, hh * 0.75 - hh / 2, L * 0.3, hh / 2, 0, 0);
  p.close();
  return p;
}

type Halo = { r: number; rgb: string; a: number; blur: number; w?: number };
type Rays = { n: number; r: number; rgb: string; a: number; rot: number; cy: number; wf: number };
type Wing = { f: number[]; c1: string; c2: string; sp: [number, number] };
type Crown = { n: 3 | 5 | 7; c: [string, string, string] };
type Ring = { kind: 'thin' | 'fil' | 'dbl'; grad: Grad; g2?: Grad; studs: 0 | 6 | 12; sc: string; ss: number };
type Orbit = { n: number; rx: number; ry: number; col: string; s: number };
type Numeral = { fill: Grad; ink: string; h: number; cy: number; w100: number; scrim?: [number, number] };
type Loop = { kind: 'ember' | 'halo' | 'rays' | 'prism' | 'orbit' | 'core'; ms: number; yoyo: boolean };
type Enter = { kind: 'scale' | 'glint' | 'sheen' | 'unfold' | 'pop' | 'pillar'; ms: number };

/** One tier's art, in the mock's terms (build8.py HY[tier]). */
export type TierStyle = {
  frame: Grad;
  edge: string;
  face: [string, string] | [string];
  /** The inner face and facet scale inside the frame. */
  fw: number;
  /** The facets, top right then clockwise. */
  facets: string[];
  /** The table glint's white and where it fades out. */
  tab: number;
  tabEnd: number;
  lines: string;
  glint: number;
  halos: Halo[];
  rays: Rays[];
  pillar?: { a: number; w: number; top: number; rgb: string };
  wings: Wing[];
  crown?: Crown;
  angel?: string;
  ring?: Ring;
  orbit?: Orbit;
  prism?: number;
  core?: boolean;
  stars?: boolean;
  numeral: Numeral;
  loop?: Loop;
  enter?: Enter;
};

const GOLDR = g(160, ['#FFFBE0', '#FFD65A', '#B8741C'], [0, 0.45, 1]);
const SILVR = g(160, ['#FFFFFF', '#C8D2E6', '#7C879E'], [0, 0.42, 1]);
const BRONR = g(160, ['#FFE2C0', '#D98A4A', '#7A3A16'], [0, 0.45, 1]);
const RAINB = g(135, ['#FF6B8A', '#FFD36A', '#6BFFA8', '#6BC8FF', '#B06BFF'], [0, 0.25, 0.5, 0.75, 1]);
const GOLDN = g(180, ['#FFFDF0', '#FFE48C', '#F5B93A', '#E39A22'], [0, 0.52, 0.53, 1]);

/** The mock's facet tints from a hi/mid/lo/deep material. */
function facetCols(hi: string, mid: string, lo: string, deep: string): string[] {
  return [`rgba(${hi},0.6)`, `rgba(${mid},0.5)`, `rgba(${lo},0.56)`, `rgba(${deep},0.56)`, `rgba(${lo},0.5)`, `rgba(${mid},0.55)`];
}
/** The mock's two-tone numeral: `top` to 52%, `bot` from 53%. */
function nm(top: string, bot: string, ink: string, scrim: [number, number] = [76, 42]): Numeral {
  return { fill: g(180, [top, top, bot, bot], [0, 0.52, 0.53, 1]), ink, h: 26, cy: 83, w100: 50, scrim };
}
const halo = (r: number, rgb: string, a: number, blur: number, w?: number): Halo => ({ r, rgb, a, blur, w });
const rays = (n: number, r: number, rgb: string, a: number, rot: number, cy: number, wf: number): Rays => ({ n, r, rgb, a, rot, cy, wf });
const wing = (f: number[], c1: string, c2: string, sp: [number, number]): Wing => ({ f, c1, c2, sp });
const dbl = (grad: Grad, sc: string, ss: number, g2?: Grad): Ring => ({ kind: 'dbl', grad, g2, studs: 12, sc, ss });

const TIER_DIM: TierStyle = {
  frame: g(160, ['#6b7192', '#2e3350']),
  edge: '#2A0E04',
  face: ['#10141f'],
  fw: 0.93,
  facets: Array<string>(6).fill('rgba(160,168,196,0.25)'),
  tab: 0.1,
  tabEnd: 0.55,
  lines: 'rgba(200,205,225,0.25)',
  glint: 8,
  halos: [],
  rays: [],
  wings: [],
  numeral: { fill: g(180, ['#8E94B0', '#8E94B0']), ink: '#0d1424', h: 24, cy: 84, w100: 40 },
};
/** T1 Amber: H3 as picked. */
const TIER_AMBER: TierStyle = {
  frame: g(160, ['#FFD27A', '#E0821E', '#7A3306'], [0, 0.5, 1]),
  edge: '#2A0E04',
  face: ['#2A0E04', '#120602'],
  fw: 0.93,
  facets: ['rgba(255,236,170,0.55)', 'rgba(255,200,90,0.42)', 'rgba(224,120,30,0.46)', 'rgba(150,60,10,0.5)', 'rgba(200,95,20,0.42)', 'rgba(255,214,120,0.5)'],
  tab: 0.3,
  tabEnd: 0.55,
  lines: 'rgba(255,246,216,0.55)',
  glint: 8,
  halos: [],
  rays: [],
  wings: [],
  numeral: { fill: g(180, ['#FFF8E4', '#FFF8E4', '#F1D9A0', '#F1D9A0'], [0, 0.62, 0.63, 1]), ink: DARK, h: 24, cy: 84, w100: 40 },
  loop: { kind: 'ember', ms: 1800, yoyo: true },
};
const LADDER: TierStyle[] = [
  TIER_DIM,
  TIER_AMBER,
  // T2 Copper
  { ...TIER_AMBER, frame: g(160, ['#FFD9B8', '#D9834F', '#6E3016'], [0, 0.45, 1]), edge: '#2A100A', face: ['#2A100A', '#140805'], fw: 0.89,
    facets: facetCols('255,215,185', '240,150,105', '190,90,55', '110,45,25'), tab: 0.45, tabEnd: 0.58, lines: 'rgba(255,248,222,0.6)', glint: 8,
    ring: { kind: 'thin', grad: BRONR, studs: 0, sc: '#FFF3B0', ss: 3.5 }, halos: [halo(48, '240,150,100', 0.36, 9)],
    numeral: nm('#FFF3E8', '#F2C6A4', '#2A100A'), enter: { kind: 'scale', ms: 400 } },
  // T3 Jade
  { ...TIER_AMBER, frame: g(160, ['#E8FFF2', '#8FD9B4', '#2C6B52'], [0, 0.45, 1]), edge: '#06201A', face: ['#06201A', '#021009'], fw: 0.88,
    facets: facetCols('205,255,228', '90,222,162', '30,150,105', '8,70,55'), tab: 0.45, tabEnd: 0.58, lines: 'rgba(235,255,245,0.6)', glint: 8,
    ring: { kind: 'thin', grad: SILVR, studs: 6, sc: '#E8FFF2', ss: 3 }, halos: [halo(52, '90,230,160', 0.42, 10)],
    numeral: nm('#F2FFF8', '#A8EBCB', '#052018'), enter: { kind: 'glint', ms: 300 } },
  // T4 Sapphire
  { ...TIER_AMBER, frame: g(160, ['#FFFFFF', '#BCD0F0', '#5470B0'], [0, 0.4, 1]), edge: '#050C26', face: ['#050C26', '#02050F'], fw: 0.85,
    facets: facetCols('205,228,255', '90,150,250', '35,80,205', '12,30,110'), tab: 0.45, tabEnd: 0.58, lines: 'rgba(235,244,255,0.65)', glint: 9,
    ring: dbl(GOLDR, '#FFF3B0', 4), halos: [halo(54, '110,170,255', 0.5, 11)],
    numeral: nm('#F4F9FF', '#B4D0F8', '#050C26'), enter: { kind: 'sheen', ms: 900 } },
  // T5 Amethyst
  { ...TIER_AMBER, frame: g(160, ['#FFFFFF', '#D8C9F0', '#F2C14E', '#7D5BB0'], [0, 0.38, 0.62, 1]), edge: '#12062A', face: ['#12062A', '#08031A'], fw: 0.86,
    facets: facetCols('240,215,255', '185,125,250', '120,55,205', '70,25,135'), tab: 0.5, tabEnd: 0.58, lines: 'rgba(250,240,255,0.65)', glint: 9,
    ring: { kind: 'fil', grad: g(160, ['#FFFFFF', '#C8B6E6', '#F2C14E', '#F2C14E'], [0, 0.4, 0.7, 1]), studs: 6, sc: '#FFF3B0', ss: 4 },
    halos: [halo(62, '175,110,255', 0.62, 12, 124)], wings: [wing([54, 50, 46], '#FFFFFF', '#BFC8D8', [14, 60])],
    numeral: nm('#FBF5FF', '#D9C0F8', '#12062A'), loop: { kind: 'halo', ms: 3000, yoyo: true }, enter: { kind: 'unfold', ms: 600 } },
  // T6 Ruby
  { ...TIER_AMBER, frame: g(160, ['#FFE9B0', '#E9B94A', '#8A3A1C'], [0, 0.4, 1]), edge: '#2A0610', face: ['#2A0610', '#12030A'], fw: 0.85,
    facets: facetCols('255,210,220', '255,95,120', '200,25,60', '100,6,30'), tab: 0.5, tabEnd: 0.58, lines: 'rgba(255,236,230,0.65)', glint: 10,
    ring: dbl(GOLDR, '#FFF3B0', 4.4), halos: [halo(60, '255,100,120', 0.55, 12)],
    // The mock's T6 rays sit at y 0.5 (build8 passes wf in the cy slot), so the burst fans out above the crown. Built as rendered.
    rays: [rays(12, 66, '255,170,170', 0.45, 0, 0.5, 0.5)],
    wings: [wing([60, 57, 54, 50, 46], '#FFFBE0', '#E9B94A', [10, 74])], crown: { n: 3, c: ['#FFE0E0', '#FF5A78', '#7A0E2A'] },
    numeral: nm('#FFF2F2', '#FFB8C0', '#2A0610', [74, 42]), loop: { kind: 'rays', ms: 60000, yoyo: false }, enter: { kind: 'pop', ms: 500 } },
  // T7 Gold
  { ...TIER_AMBER, frame: GOLDR, edge: '#2A0E04', face: ['#2A0E04', '#120602'], fw: 0.86,
    facets: facetCols('255,252,215', '255,225,110', '250,170,40', '190,100,12'), tab: 0.55, tabEnd: 0.58, lines: 'rgba(255,255,236,0.75)', glint: 10,
    ring: dbl(GOLDR, '#FFF3B0', 4.6), halos: [halo(58, '255,210,100', 0.55, 12, 120)], rays: [rays(16, 66, '255,226,140', 0.55, 0, CYG, 0.55)],
    pillar: { a: 0.85, w: 18, top: -34, rgb: '255,248,210' }, wings: [wing([62, 59, 56, 53, 49, 45, 41], '#FFFBE0', '#E9A83A', [6, 84])],
    numeral: { fill: GOLDN, ink: DARK, h: 26, cy: 83, w100: 50, scrim: [74, 42] }, loop: { kind: 'rays', ms: 40000, yoyo: false }, enter: { kind: 'pillar', ms: 700 } },
  // T8 Prismatic
  { ...TIER_AMBER, frame: g(160, ['#FFFFFF', '#E8EEFF', '#B8C2DA', '#6A7494'], [0, 0.35, 0.65, 1]), edge: '#10121E', face: ['#10121E', '#06070D'], fw: 0.84,
    facets: facetCols('255,255,255', '230,236,248', '190,200,225', '120,130,170'), tab: 0.6, tabEnd: 0.58, lines: 'rgba(255,255,255,0.8)', glint: 11, prism: 0.85,
    ring: dbl(RAINB, '#FFFFFF', 4.6, SILVR), halos: [halo(64, '255,255,255', 0.5, 12, 128)],
    wings: [wing([62, 58, 54, 50, 46], '#FFFFFF', '#BCC8E0', [-4, 58]), wing([56, 52, 48, 44, 40, 36], '#FFFFFF', '#E4E8F6', [8, 86])],
    crown: { n: 5, c: ['#FFFFFF', '#D6DCF0', '#8892B4'] },
    numeral: { fill: g(100, ['#FFD6E0', '#FFF2B8', '#CFFFE0', '#C8E6FF', '#E6D2FF'], [0, 0.25, 0.5, 0.75, 1]), ink: '#10121E', h: 26, cy: 83, w100: 50, scrim: [76, 42] },
    loop: { kind: 'prism', ms: 6000, yoyo: true }, enter: { kind: 'pop', ms: 500 } },
  // T9 Celestial
  { ...TIER_AMBER, frame: g(160, ['#FFFFFF', '#BFD8FF', '#7FA0E8', '#3C4F9A'], [0, 0.38, 0.62, 1]), edge: '#060830', face: ['#060830', '#02031A'], fw: 0.84,
    facets: facetCols('190,235,255', '80,120,230', '35,40,150', '10,12,70'), tab: 0.55, tabEnd: 0.58, lines: 'rgba(220,240,255,0.75)', glint: 11, stars: true,
    ring: dbl(g(160, ['#FFFFFF', '#CFE4FF', '#8CB0F0'], [0, 0.4, 1]), '#FFFFFF', 4.2), halos: [halo(66, '140,200,255', 0.6, 13, 136)],
    wings: [wing([62, 58, 54, 50, 46], '#FFFFFF', '#8FB4F0', [8, 70])], crown: { n: 7, c: ['#FFFFFF', '#A8CCFF', '#3E56B0'] }, angel: '#CFE8FF',
    orbit: { n: 4, rx: 50, ry: 40, col: '#DFF0FF', s: 5 },
    numeral: nm('#FFFFFF', '#C6E0FF', '#060830'), loop: { kind: 'orbit', ms: 24000, yoyo: false }, enter: { kind: 'pop', ms: 500 } },
  // T10 Mythic
  { ...TIER_AMBER, frame: g(160, ['#FFF3B0', '#FF9A3C', '#C8206A', '#5A0B3A'], [0, 0.3, 0.6, 1]), edge: '#14031A', face: ['#1A0420', '#0A0212'], fw: 0.83,
    facets: ['rgba(255,226,140,0.78)', 'rgba(210,30,100,0.68)', 'rgba(95,12,80,0.74)', 'rgba(22,4,34,0.8)', 'rgba(210,30,100,0.62)', 'rgba(255,170,70,0.72)'],
    tab: 0.55, tabEnd: 0.58, lines: 'rgba(255,236,190,0.8)', glint: 12, core: true,
    ring: dbl(g(160, ['#FFF3B0', '#FFC15A', '#C8206A'], [0, 0.4, 1]), '#FFF3B0', 5),
    halos: [halo(72, '255,140,90', 0.7, 14, 150), halo(54, '220,60,150', 0.5, 12, 100)],
    rays: [rays(24, 76, '255,214,140', 0.62, 0, CYG, 0.5), rays(24, 64, '255,150,220', 0.5, 7, CYG, 0.35)],
    wings: [wing([62, 59, 56, 53, 50, 46], '#FFF6D0', '#D9902E', [-6, 54]), wing([58, 55, 52, 49, 46, 42, 38], '#FFFFFF', '#FFD65A', [6, 88])],
    crown: { n: 7, c: ['#FFFBE0', '#FFB84A', '#B0206A'] }, orbit: { n: 6, rx: 56, ry: 46, col: '#FFE8A8', s: 6 },
    numeral: { fill: g(180, ['#FFFFFF', '#FFF4C8', '#FFC860', '#FF9A5A'], [0, 0.45, 0.53, 1]), ink: '#2A0420', h: 26, cy: 83, w100: 56, scrim: [82, 44] },
    loop: { kind: 'core', ms: 2400, yoyo: true }, enter: { kind: 'pop', ms: 500 } },
];
/** Indexed by tier (streakTier in practice-card): 0 is the grey ghost, 1 to 10 the ladder. */
export const TIER_STYLE: TierStyle[] = LADDER;

/** The crown shards per point count: centre x, centre y, width, height, rotation. */
const CROWN_POS: Record<3 | 5 | 7, [number, number, number, number, number][]> = {
  3: [[50, -9, 16, 30, 0], [31, -3, 13, 26, -24], [69, -3, 13, 26, 24]],
  5: [[50, -9, 16, 30, 0], [31, -3, 13, 26, -24], [69, -3, 13, 26, 24], [14, 16, 12, 22, -48], [86, 16, 12, 22, 48]],
  7: [[50, -9, 16, 30, 0], [31, -3, 13, 26, -24], [69, -3, 13, 26, 24], [14, 16, 12, 22, -48], [86, 16, 12, 22, 48], [8, 52, 12, 22, -24], [92, 52, 12, 22, 24]],
};
/** Sparks above the gem's top-right edge: left, top, size, opacity. The bigger one is gold, the small one ember. */
const SPARKS: [number, number, number, number][] = [[58, -3, 3.5, 0.9], [66, -9, 2.5, 0.6]];
/** T9's star field: the mock's seeded dots inside the gem (centre x, centre y, size). */
const STAR_FIELD: [number, number, number][] = [[43.2, 16.9, 2.8], [32.7, 45.9, 1.6], [44.8, 12.9, 2.8], [39.0, 14.1, 2.2], [33.5, 14.3, 2.2], [33.1, 34.8, 1.6], [55.0, 35.6, 1.6], [53.0, 27.5, 1.6], [32.6, 47.5, 2.2], [46.9, 33.8, 2.8]];
/** The prism sheen's rainbow across the gem (112deg, stops 18% to 82%). */
const PRISM_COLORS = ['rgba(255,0,100,0)', 'rgba(255,70,90,0.8)', 'rgba(255,210,60,0.85)', 'rgba(80,255,150,0.8)', 'rgba(70,170,255,0.85)', 'rgba(190,90,255,0.8)', 'rgba(255,0,100,0)'];
const PRISM_STOPS = [0.18, 0.3, 0.4, 0.5, 0.6, 0.7, 0.82];

const SHADOW_HEX = polygon(hexPts(GL, GT + 3, GW, GH, 1, 0.24));
const RIM_HEX = polygon(hexPts(GL, GT, GW, GH, 1, 0.24));
const GEM_BOX: Box = [GL, GT, GW, GH];
const TABLE_GRAD = cssAngle(GL, GT, GW, GH, 150);
const PRISM_GRAD = cssAngle(GL, GT, GW, GH, 112);
const TYPEFACE = require('../../assets/fonts/Nunito_900Black.ttf');

/** The static paths of one tier, built once. */
type TierArt = {
  face: SkPath;
  faceTop: number;
  faceBottom: number;
  facets: SkPath[];
  table: SkPath;
  lines: SkPath;
  glint: SkPath;
  rings: { path: SkPath; box: Box; grad: Grad; opacity: number }[];
  studs: [number, number, number][];
  rays: { path: SkPath; r: number; cy: number; rgb: string; a: number; rot: number }[];
  feathers: { path: SkPath; L: number; hh: number; mirror: boolean; ang: number; c1: string; c2: string }[];
  shards: { x: number; y: number; w: number; h: number; rot: number; body: SkPath; shade: SkPath; light: SkPath; c: [string, string, string] }[];
};
const ART_CACHE = new Map<number, TierArt>();
function tierArt(tier: number, art: TierStyle): TierArt {
  const hit = ART_CACHE.get(tier);
  if (hit) return hit;
  // T1 keeps H3's facets at the frame's size; the ladder's gems sit inside the frame at fw.
  const fs = tier <= 1 ? 1 : art.fw;
  const outer = hexPts(GL, GT, GW, GH, fs, 0.25);
  const inner = hexPts(GL, GT, GW, GH, fs * 0.52, 0.25);
  const lines = Skia.Path.Make();
  outer.forEach(([x, y], i) => {
    lines.moveTo(x, y);
    lines.lineTo(inner[i][0], inner[i][1]);
  });
  lines.addPath(polygon(outer));
  lines.addPath(polygon(inner));
  const rings: TierArt['rings'] = [];
  const studs: TierArt['studs'] = [];
  if (art.ring) {
    const R = art.ring;
    const add = (inset: number, r: number, grad: Grad, opacity: number) => {
      const box: Box = [GL - inset, GT - inset, GW + 2 * inset, GH + 2 * inset];
      rings.push({ path: ringPath(...box, r), box, grad, opacity });
    };
    add(6, 3.2, R.grad, 1);
    if (R.kind !== 'thin') add(11, R.kind === 'fil' ? 1.6 : 2.4, R.g2 ?? R.grad, 1);
    if (R.kind === 'dbl') add(15.5, 1.2, R.g2 ?? R.grad, 0.7);
    if (R.studs) {
      const pts = hexPts(GL - 6, GT - 6, GW + 12, GH + 12, 1, 0.25);
      pts.forEach(([x, y]) => studs.push([x, y, R.ss]));
      if (R.studs === 12) pts.forEach(([x, y], i) => studs.push([(x + pts[(i + 1) % 6][0]) / 2, (y + pts[(i + 1) % 6][1]) / 2, R.ss * 0.62]));
    }
  }
  const feathers: TierArt['feathers'] = [];
  art.wings.forEach((w) => {
    const k = w.f.length;
    [false, true].forEach((mirror) =>
      w.f.forEach((L, i) => feathers.push({ path: featherPath(L), L, hh: L * 0.3, mirror, ang: w.sp[0] + ((w.sp[1] - w.sp[0]) * i) / Math.max(1, k - 1), c1: w.c1, c2: w.c2 })),
    );
  });
  const shards: TierArt['shards'] = art.crown
    ? CROWN_POS[art.crown.n].map(([x, y, w, h, rot]) => ({
        x, y, w, h, rot, c: art.crown!.c,
        body: polygon(hexPts(-w / 2, -h / 2, w, h, 1, 0.24)),
        shade: polygon([[0, -h / 2], [-w / 2, -h / 2 + 0.24 * h], [-w / 2, -h / 2 + 0.76 * h], [0, h / 2], [0, -h / 2 + 0.4 * h]]),
        light: polygon([[0, -h / 2], [w / 2, -h / 2 + 0.24 * h], [0, -h / 2 + 0.4 * h]]),
      }))
    : [];
  const built: TierArt = {
    face: polygon(hexPts(GL, GT, GW, GH, art.fw, 0.24)),
    faceTop: GT + (GH * (1 - art.fw)) / 2,
    faceBottom: GT + GH - (GH * (1 - art.fw)) / 2,
    facets: outer.map((_, i) => polygon([outer[i], outer[(i + 1) % 6], inner[(i + 1) % 6], inner[i]])),
    table: polygon(inner),
    lines,
    glint: starPath(GL + GW * 0.3, GT + GH * 0.22, art.glint),
    rings,
    studs,
    rays: art.rays.map((r) => ({ path: raysPath(r.n, r.r, r.cy, r.wf), r: r.r, cy: r.cy, rgb: r.rgb, a: r.a, rot: r.rot })),
    feathers,
    shards,
  };
  ART_CACHE.set(tier, built);
  return built;
}

function BoxGrad({ box, grad }: { box: Box; grad: Grad }) {
  const { start, end } = cssAngle(box[0], box[1], box[2], box[3], grad.deg);
  return <LinearGradient start={start} end={end} colors={grad.colors} positions={grad.positions} />;
}

/** A four-point star with the mock's `drop-shadow(0 0 .45s)` glow under it. */
function Star({ path, size, fill, glow, opacity }: { path: SkPath; size: number; fill: string; glow: string; opacity: number | SharedValue<number> }) {
  return (
    <Group opacity={opacity}>
      <Path path={path} color={glow}>
        <Blur blur={size * 0.225} />
      </Path>
      <Path path={path} color={fill} />
    </Group>
  );
}

/** The mock's dot: a disc with a `0 0 2s` glow. */
function Dot({ x, y, s, color }: { x: number; y: number; s: number; color: string }) {
  return (
    <>
      <Circle cx={x} cy={y} r={s / 2} color={color}>
        <Blur blur={s} />
      </Circle>
      <Circle cx={x} cy={y} r={s / 2} color={color} />
    </>
  );
}

/** A blurred radial glow centred on (CX, cy): full at the centre, 35% at 60%, gone at the edge. */
function HaloGlow({ h, cy = CYG }: { h: Halo; cy?: number }) {
  const w = h.w ?? h.r * 2;
  return (
    <Oval x={CX - w / 2} y={cy - w / 2} width={w} height={w}>
      <RadialGradient c={vec(CX, cy)} r={w / 2} colors={[`rgba(${h.rgb},${h.a})`, `rgba(${h.rgb},${h.a * 0.35})`, `rgba(${h.rgb},0)`]} positions={[0, 0.6, 1]} />
      <Blur blur={h.blur} />
    </Oval>
  );
}

/** One orbit spark on its ellipse; the shared angle moves it, and it fades out under the numeral's line. */
function OrbitSpark({ i, o, turn }: { i: number; o: Orbit; turn: SharedValue<number> }) {
  const base = ((360 * i) / o.n + 20) * (Math.PI / 180);
  const s = i % 2 === 0 ? o.s : o.s * 0.65;
  const rx = o.rx;
  const ry = o.ry;
  const path = useMemo(() => starPath(0, 0, s), [s]);
  const place = useDerivedValue(() => {
    const a = base + turn.value * 2 * Math.PI;
    return [{ translateX: CX + rx * Math.cos(a) }, { translateY: CYG + ry * Math.sin(a) }];
  });
  const opacity = useDerivedValue(() => {
    const y = CYG + ry * Math.sin(base + turn.value * 2 * Math.PI);
    return 0.95 * Math.max(0, Math.min(1, (ORBIT_FLOOR - y) / 6));
  });
  return (
    <Group transform={place}>
      <Star path={path} size={s} fill={o.col} glow={o.col} opacity={opacity} />
    </Group>
  );
}

/**
 * The day count under the gem: Nunito Black, `h` tall (narrower from 100 on
 * so three digits stay `w100` wide), centred on `cy`. Lit: the tier's fill, a
 * 2.6 outline, a 3px hard drop and a soft shadow. Dim: grey with a thin dark
 * outline.
 */
function GemNumeral({ n, lit, num, typeface }: { n: number; lit: boolean; num: Numeral; typeface: SkTypeface }) {
  const text = String(n);
  const layout = useMemo(() => {
    const probe = Skia.Font(typeface, 100);
    const b = probe.measureText(text);
    const hh = b.height / 100;
    let fs = num.h / hh;
    if (n >= 100) fs = Math.min(fs * 0.9, num.w100 / (b.width / 100));
    const font = Skia.Font(typeface, fs);
    const r = font.measureText(text);
    // Visual centre of the digits on cy; the measured rect's y is negative above the baseline.
    const y = num.cy - (r.y + r.height / 2);
    const x = W / 2 - (r.x + r.width / 2);
    // The mock's gradient spans the CSS line box (ascender 1.02, descender 0.36, line-height 1) of a 120 wide block.
    const box: Box = [W / 2 - 60, y - 0.83 * fs, 120, fs];
    return { font, x, y, box };
  }, [typeface, text, n, num]);
  const { font, x, y, box } = layout;
  if (!lit) {
    return (
      <>
        <SkText font={font} text={text} x={x} y={y} color="#0d1424" style="stroke" strokeWidth={4} strokeJoin="round" />
        <SkText font={font} text={text} x={x} y={y} color="#8E94B0" />
      </>
    );
  }
  return (
    <>
      <SkText font={font} text={text} x={x} y={y + 6} color="rgba(0,0,0,0.45)">
        <Blur blur={2.5} />
      </SkText>
      <SkText font={font} text={text} x={x} y={y + 3} color={num.ink} />
      <SkText font={font} text={text} x={x} y={y} color={num.ink} style="stroke" strokeWidth={5.2} strokeJoin="round" />
      <SkText font={font} text={text} x={x} y={y}>
        <BoxGrad box={box} grad={num.fill} />
      </SkText>
    </>
  );
}

/**
 * The streak gem lockup. `size` is the gem's width (64 in the mock); the box
 * is 100x96 at that scale. `tier` (0 to 10) picks the art from TIER_STYLE, 0
 * being the grey gem. `clipSides` is how far past the box (in px) the wings
 * and glows may reach before the card's side cuts them; the top is never cut.
 */
export function StreakGem({ size, streak, tier, clipSides = 40 }: { size: number; streak: number; tier: number; clipSides?: number }) {
  const k = size / GEM_W;
  const lit = tier > 0;
  const t = Math.min(Math.max(tier, 0), TIER_STYLE.length - 1);
  const art = TIER_STYLE[t];
  const paths = useMemo(() => tierArt(t, art), [t, art]);
  const typeface = useTypeface(TYPEFACE);
  const reducedMotion = useReducedMotion();
  const loop = useSharedValue(0);
  const enter = useSharedValue(1);
  useEffect(() => {
    cancelAnimation(loop);
    cancelAnimation(enter);
    loop.value = 0;
    enter.value = 1;
    if (!lit || reducedMotion) return;
    if (art.loop) {
      const { ms, yoyo } = art.loop;
      loop.value = withRepeat(withTiming(1, { duration: ms, easing: yoyo ? Easing.inOut(Easing.sin) : Easing.linear }), -1, yoyo);
    }
    if (art.enter) {
      enter.value = 0;
      enter.value = withTiming(1, { duration: art.enter.ms, easing: art.enter.kind === 'pop' ? Easing.out(Easing.back(1.6)) : Easing.out(Easing.cubic) });
    }
    return () => {
      cancelAnimation(loop);
      cancelAnimation(enter);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lit, reducedMotion, art]);
  const loopKind = art.loop?.kind;
  const enterKind = art.enter?.kind;
  const emberOpacity = useDerivedValue(() => (loopKind === 'ember' ? 1 - 0.3 * loop.value : 1));
  const haloOpacity = useDerivedValue(() => (loopKind === 'halo' ? 1 - 0.3 * loop.value : 1));
  const raysSpin = useDerivedValue(() => [{ rotate: loopKind === 'rays' ? loop.value * 2 * Math.PI : 0 }]);
  const prismShift = useDerivedValue(() => [{ translateX: loopKind === 'prism' ? loop.value * 24 : 0 }]);
  const orbitTurn = useDerivedValue(() => (loopKind === 'orbit' ? loop.value : 0));
  const coreOpacity = useDerivedValue(() => (loopKind === 'core' ? 1 - 0.2 * loop.value : 1));
  const gemScale = useDerivedValue(() => [{ scale: enterKind === 'scale' ? 0.92 + 0.08 * enter.value : 1 }]);
  const glintOpacity = useDerivedValue(() => (enterKind === 'glint' ? 0.95 * enter.value : 0.95));
  const sheenPlace = useDerivedValue(() => [{ translateX: -GW * 1.2 + GW * 2.4 * enter.value }]);
  const sheenOpacity = useDerivedValue(() => (enterKind === 'sheen' ? 1 - enter.value : 0));
  const wingsScale = useDerivedValue(() => [{ scaleX: enterKind === 'unfold' ? 0.1 + 0.9 * enter.value : 1 }]);
  const extrasScale = useDerivedValue(() => [{ scale: enterKind === 'pop' ? 0.6 + 0.4 * enter.value : 1 }]);
  const pillarRise = useDerivedValue(() => [{ scaleY: enterKind === 'pillar' ? enter.value : 1 }]);

  const canvas = { position: 'absolute' as const, left: -PAD * k, top: -PAD * k, width: (W + 2 * PAD) * k, height: (H + 2 * PAD) * k };
  const frame = [{ translateX: PAD * k }, { translateY: PAD * k }, { scale: k }];
  const clip = { position: 'absolute' as const, left: -clipSides, top: -PAD * k, width: W * k + 2 * clipSides, height: (H + 2 * PAD) * k, overflow: 'hidden' as const };
  const inner = { position: 'absolute' as const, left: clipSides, top: PAD * k, width: W * k, height: H * k };
  const scrim = art.numeral.scrim;
  return (
    <View style={{ width: W * k, height: H * k }} pointerEvents="none">
      <View style={clip}>
        <View style={inner}>
          <Canvas style={canvas}>
            <Group transform={frame}>
              <Group transform={gemScale} origin={vec(CX, CYG)}>
                {lit && art.halos.length > 0 ? (
                  <Group opacity={haloOpacity}>
                    {art.halos.map((h, i) => <HaloGlow key={i} h={h} />)}
                  </Group>
                ) : null}
                {lit
                  ? paths.rays.map((r, i) => (
                      <Group key={i} transform={raysSpin} origin={vec(CX, r.cy)}>
                        <Path path={r.path} transform={[{ rotate: (r.rot * Math.PI) / 180 }]} origin={vec(CX, r.cy)}>
                          <RadialGradient c={vec(CX, r.cy)} r={r.r} colors={[`rgba(${r.rgb},0)`, `rgba(${r.rgb},0)`, `rgba(${r.rgb},${r.a})`, `rgba(${r.rgb},0)`]} positions={[0, 0.3, 0.38, 1]} />
                        </Path>
                      </Group>
                    ))
                  : null}
                {lit && art.core ? (
                  <Group opacity={coreOpacity}>
                    <Oval x={CX - 30} y={CYG - 30} width={60} height={60}>
                      <RadialGradient c={vec(CX, CYG)} r={30} colors={['rgba(255,255,240,0.75)', 'rgba(255,255,240,0.26)', 'rgba(255,255,240,0)']} positions={[0, 0.6, 1]} />
                      <Blur blur={8} />
                    </Oval>
                  </Group>
                ) : null}
                {lit && art.pillar ? (
                  <Group transform={pillarRise} origin={vec(CX, CYG + 26)}>
                    <Mask
                      mode="alpha"
                      mask={
                        <Rect x={CX - art.pillar.w / 2} y={art.pillar.top} width={art.pillar.w} height={CYG - art.pillar.top + 26}>
                          <LinearGradient start={vec(CX, art.pillar.top)} end={vec(CX, CYG + 26)} colors={['rgba(255,255,255,0)', '#FFFFFF', '#FFFFFF', 'rgba(255,255,255,0)']} positions={[0, 0.3, 0.7, 1]} />
                        </Rect>
                      }>
                      <Rect x={CX - art.pillar.w / 2} y={art.pillar.top} width={art.pillar.w} height={CYG - art.pillar.top + 26}>
                        <LinearGradient start={vec(CX - art.pillar.w / 2, 0)} end={vec(CX + art.pillar.w / 2, 0)} colors={[`rgba(${art.pillar.rgb},0)`, `rgba(${art.pillar.rgb},${art.pillar.a})`, `rgba(${art.pillar.rgb},0)`]} positions={[0, 0.5, 1]} />
                      </Rect>
                    </Mask>
                  </Group>
                ) : null}
                {lit && paths.feathers.length > 0 ? (
                  <Group transform={extrasScale} origin={vec(CX, CYG)}>
                    <Group transform={wingsScale} origin={vec(CX, HINGE_Y)}>
                      {paths.feathers.map((f, i) => (
                        <Group key={i} transform={[{ translateX: CX + (f.mirror ? -HINGE_DX : HINGE_DX) }, { translateY: HINGE_Y }, { scaleX: f.mirror ? -1 : 1 }, { rotate: (-f.ang * Math.PI) / 180 }]}>
                          <Path path={f.path} color="#3A1A02" transform={[{ translateY: 1 }]} />
                          <Path path={f.path}>
                            <LinearGradient start={vec(0, 0)} end={vec(f.L, 0)} colors={[f.c1, f.c2]} />
                          </Path>
                          <Path path={f.path}>
                            <LinearGradient start={vec(0, -f.hh / 2)} end={vec(0, f.hh / 2)} colors={['rgba(255,255,255,0.2)', 'rgba(255,255,255,0)']} />
                          </Path>
                        </Group>
                      ))}
                    </Group>
                  </Group>
                ) : null}
                {lit && paths.shards.length > 0 ? (
                  <Group transform={extrasScale} origin={vec(CX, CYG)}>
                    {paths.shards.map((s, i) => (
                      <Group key={i} transform={[{ translateX: s.x }, { translateY: s.y }, { rotate: (s.rot * Math.PI) / 180 }]}>
                        <Path path={s.body} color="rgba(255,200,90,0.6)">
                          <Blur blur={2} />
                        </Path>
                        <Path path={s.body} color="#2A0E04" transform={[{ translateY: 1.5 }]} />
                        <Path path={s.body}>
                          <BoxGrad box={[-s.w / 2, -s.h / 2, s.w, s.h]} grad={g(160, s.c, [0, 0.55, 1])} />
                        </Path>
                        <Path path={s.shade} color="rgba(0,0,0,0.26)" />
                        <Path path={s.light} color="rgba(255,255,255,0.5)" />
                      </Group>
                    ))}
                  </Group>
                ) : null}
                {lit && art.angel ? (
                  <>
                    <Oval x={CX - 17} y={-17} width={34} height={10.2} color={art.angel} style="stroke" strokeWidth={2.5}>
                      <Blur blur={4} />
                    </Oval>
                    <Oval x={CX - 17 + 1.25} y={-17 + 1.25 + 1} width={34 - 2.5} height={10.2 - 2.5} color="#3A1A02" style="stroke" strokeWidth={2.5} />
                    <Oval x={CX - 17 + 1.25} y={-17 + 1.25} width={34 - 2.5} height={10.2 - 2.5} color={art.angel} style="stroke" strokeWidth={2.5} />
                  </>
                ) : null}
                {lit
                  ? paths.rings.map((r, i) => (
                      <Path key={i} path={r.path} opacity={r.opacity}>
                        <BoxGrad box={r.box} grad={r.grad} />
                      </Path>
                    ))
                  : null}
                {lit ? paths.studs.map(([x, y, s], i) => <Dot key={i} x={x} y={y} s={s} color={art.ring!.sc} />) : null}
                <Path path={SHADOW_HEX} color={art.edge} />
                <Path path={RIM_HEX}>
                  <BoxGrad box={GEM_BOX} grad={art.frame} />
                </Path>
                {art.face.length > 1 ? (
                  <Path path={paths.face}>
                    <LinearGradient start={vec(W / 2, paths.faceTop)} end={vec(W / 2, paths.faceBottom)} colors={art.face} />
                  </Path>
                ) : (
                  <Path path={paths.face} color={art.face[0]} />
                )}
                {lit ? (
                  <Group opacity={emberOpacity}>
                    <Oval x={W / 2 - FLAME * 0.49} y={FLAME_Y + FLAME * 0.15} width={FLAME * 0.98} height={FLAME} color="#FF8A3D" opacity={EMBER}>
                      <Blur blur={FLAME * 0.2} />
                    </Oval>
                  </Group>
                ) : null}
              </Group>
            </Group>
          </Canvas>
          <View style={[styles.flameBox, { left: FLAME_X * k, top: FLAME_Y * k, width: FLAME * k, height: FLAME * k }]}>
            <Text style={[styles.flame, { fontSize: FLAME * k, lineHeight: Math.round(FLAME * k * 1.2), opacity: lit ? 1 : 0.3 }, !lit && styles.flameOff]}>🔥</Text>
          </View>
          <Canvas style={canvas}>
            <Group transform={frame}>
              <Group transform={gemScale} origin={vec(CX, CYG)}>
                {lit
                  ? SPARKS.map(([x, y, s, o]) => (
                      <Group key={`${x}-${y}`} opacity={o}>
                        <Dot x={x + s / 2} y={y + s / 2} s={s} color={s > 3 ? '#FFC857' : '#FF9650'} />
                      </Group>
                    ))
                  : null}
                {lit && scrim ? (
                  <Group transform={[{ translateX: CX }, { translateY: art.numeral.cy }, { scaleY: scrim[1] / scrim[0] }]} opacity={0.92}>
                    <Circle cx={0} cy={0} r={scrim[0] / 2}>
                      <RadialGradient c={vec(0, 0)} r={scrim[0] / 2} colors={['#1a0b04', '#1a0b04', 'rgba(26,11,4,0)']} positions={[0, 0.55, 1]} />
                      <Blur blur={2} />
                    </Circle>
                  </Group>
                ) : null}
                {paths.facets.map((facet, i) => (
                  <Path key={i} path={facet} color={art.facets[i]} />
                ))}
                {lit && art.stars ? STAR_FIELD.map(([x, y, s], i) => <Dot key={i} x={x} y={y} s={s} color="#FFFFFF" />) : null}
                <Path path={paths.table}>
                  <LinearGradient start={TABLE_GRAD.start} end={TABLE_GRAD.end} colors={[`rgba(255,255,255,${art.tab})`, 'rgba(255,255,255,0)']} positions={[0, art.tabEnd]} />
                </Path>
                <Path path={paths.lines} color={art.lines} style="stroke" strokeWidth={1} />
                <Star path={paths.glint} size={art.glint} fill="#FFFFFF" glow="rgba(255,255,255,0.95)" opacity={lit ? glintOpacity : 0.3} />
                {lit && art.prism ? (
                  <Group clip={RIM_HEX} opacity={art.prism} blendMode="screen">
                    <Rect x={GL - GW} y={GT - GH} width={GW * 3} height={GH * 3} transform={prismShift}>
                      <LinearGradient start={PRISM_GRAD.start} end={PRISM_GRAD.end} colors={PRISM_COLORS} positions={PRISM_STOPS} />
                    </Rect>
                  </Group>
                ) : null}
                {lit && enterKind === 'sheen' ? (
                  <Group clip={RIM_HEX} opacity={sheenOpacity}>
                    <Rect x={GL} y={GT - GH} width={GW * 0.5} height={GH * 3} transform={sheenPlace}>
                      <LinearGradient start={vec(GL, 0)} end={vec(GL + GW * 0.5, 0)} colors={['rgba(255,255,255,0)', 'rgba(255,255,255,0.45)', 'rgba(255,255,255,0)']} />
                    </Rect>
                  </Group>
                ) : null}
                {lit && art.orbit ? Array.from({ length: art.orbit.n }, (_, i) => <OrbitSpark key={i} i={i} o={art.orbit!} turn={orbitTurn} />) : null}
                {typeface ? <GemNumeral n={streak} lit={lit} num={art.numeral} typeface={typeface} /> : null}
              </Group>
            </Group>
          </Canvas>
        </View>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  flameBox: { position: 'absolute', alignItems: 'center', justifyContent: 'center' },
  flame: { textAlign: 'center', includeFontPadding: false },
  // The mock's grayscale: an emoji ignores colour and opacity does not desaturate it,
  // so the luminosity blend keeps the flame's light and takes hue and saturation from the near-grey card.
  flameOff: { mixBlendMode: 'luminosity' },
});
