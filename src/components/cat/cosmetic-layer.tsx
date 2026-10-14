import type { ReactElement } from 'react';
import { StyleSheet, View, type ViewStyle } from 'react-native';

import { ANCHORS, type ArtSpec, type Slot } from '@/constants/cosmetics';

/** Every shape is drawn in this local box, centred on the slot anchor. */
export const SHAPE_BOX = { w: 120, h: 80 } as const;

type Style = ViewStyle;
function r(x: number, y: number, w: number, h: number, bg: string, extra?: Style): ReactElement {
  return <View key={`${x}-${y}-${w}-${h}-${bg}`} style={[styles.abs, { left: x, top: y, width: w, height: h, backgroundColor: bg }, extra]} />;
}
function circle(cx: number, cy: number, d: number, bg: string, extra?: Style): ReactElement {
  return r(cx - d / 2, cy - d / 2, d, d, bg, { borderRadius: d / 2, ...extra });
}
function ring(cx: number, cy: number, d: number, color: string, w: number): ReactElement {
  return r(cx - d / 2, cy - d / 2, d, d, 'transparent', { borderRadius: d / 2, borderWidth: w, borderColor: color });
}
/** A border triangle. `dir` is where the point faces. */
function tri(cx: number, cy: number, w: number, h: number, color: string, dir: 'up' | 'down' | 'left' | 'right', rot = 0): ReactElement {
  const base: Style = { position: 'absolute', width: 0, height: 0, left: cx - w / 2, top: cy - h / 2, transform: [{ rotate: `${rot}deg` }] };
  const clear = 'transparent';
  let s: Style;
  if (dir === 'up') s = { borderLeftWidth: w / 2, borderRightWidth: w / 2, borderBottomWidth: h, borderLeftColor: clear, borderRightColor: clear, borderBottomColor: color };
  else if (dir === 'down') s = { borderLeftWidth: w / 2, borderRightWidth: w / 2, borderTopWidth: h, borderLeftColor: clear, borderRightColor: clear, borderTopColor: color };
  else if (dir === 'left') s = { borderTopWidth: h / 2, borderBottomWidth: h / 2, borderRightWidth: w, borderTopColor: clear, borderBottomColor: clear, borderRightColor: color };
  else s = { borderTopWidth: h / 2, borderBottomWidth: h / 2, borderLeftWidth: w, borderTopColor: clear, borderBottomColor: clear, borderLeftColor: color };
  return <View key={`t${cx}-${cy}-${dir}-${color}`} style={[base, s]} />;
}

const CX = SHAPE_BOX.w / 2;
const CY = SHAPE_BOX.h / 2;

type Draw = (c: string, a: string) => ReactElement[];

/** Stripe: one extra band in the accent colour, per shape. Missing = no stripe. */
const STRIPE: Record<string, { x: number; y: number; w: number; h: number }> = {
  cap: { x: 24, y: 10, w: 72, h: 6 },
  beanie: { x: 24, y: 14, w: 72, h: 6 },
  tophat: { x: 32, y: 14, w: 56, h: 5 },
  scarf: { x: 14, y: 24, w: 92, h: 5 },
  shirt: { x: 20, y: 30, w: 80, h: 6 },
  cape: { x: 10, y: 28, w: 100, h: 6 },
  kimono: { x: 18, y: 18, w: 84, h: 5 },
  hoodie: { x: 16, y: 26, w: 88, h: 6 },
  collar: { x: 24, y: 34, w: 72, h: 4 },
};

const SHAPES: Record<string, Draw> = {
  // head: the cat's skull top sits at the anchor, so hats rest on the lower edge of the box
  cap: (c, a) => [r(CX - 40, 18, 80, 40, c, { borderTopLeftRadius: 40, borderTopRightRadius: 40 }), r(CX - 14, 54, 66, 8, a, { borderRadius: 4 })],
  beanie: (c, a) => [r(CX - 38, 12, 76, 46, c, { borderTopLeftRadius: 38, borderTopRightRadius: 38 }), r(CX - 40, 50, 80, 14, a, { borderRadius: 6 }), circle(CX, 8, 16, a)],
  tophat: (c, a) => [r(CX - 28, 4, 56, 52, c, { borderRadius: 4 }), r(CX - 28, 38, 56, 8, a), r(CX - 44, 54, 88, 8, c, { borderRadius: 4 })],
  crown: (c, a) => [r(CX - 35, 40, 70, 22, c, { borderRadius: 4 }), tri(CX - 24, 28, 22, 26, c, 'up'), tri(CX, 24, 22, 32, c, 'up'), tri(CX + 24, 28, 22, 26, c, 'up'), circle(CX, 51, 8, a)],
  bow: (c, a) => [tri(CX - 18, 40, 30, 32, c, 'left'), tri(CX + 18, 40, 30, 32, c, 'right'), circle(CX, 40, 12, a)],
  // face
  glasses: (c, a) => [ring(CX - 22, CY, 34, c, 3), ring(CX + 22, CY, 34, c, 3), r(CX - 6, CY - 1, 12, 3, c), circle(CX - 30, CY - 8, 5, a, { opacity: 0.6 })],
  shades: (c, a) => [r(CX - 42, CY - 12, 38, 26, c, { borderRadius: 10 }), r(CX + 4, CY - 12, 38, 26, c, { borderRadius: 10 }), r(CX - 6, CY - 4, 12, 4, c), r(CX - 36, CY - 8, 14, 4, a, { borderRadius: 2, opacity: 0.7 })],
  monocle: (c, a) => [ring(CX + 22, CY, 36, a, 3), r(CX + 40, CY + 18, 2, 28, c)],
  mask: (c, a) => [r(CX - 50, CY - 16, 100, 34, c, { borderRadius: 16 }), r(CX - 40, CY - 11, 24, 24, a, { borderRadius: 12, opacity: 0.35 }), r(CX + 16, CY - 11, 24, 24, a, { borderRadius: 12, opacity: 0.35 })],
  blush: (c) => [r(CX - 56, CY + 14, 22, 12, c, { borderRadius: 6, opacity: 0.65 }), r(CX + 34, CY + 14, 22, 12, c, { borderRadius: 6, opacity: 0.65 })],
  // body
  scarf: (c, a) => [r(CX - 46, 18, 92, 22, c, { borderRadius: 11 }), r(CX + 14, 32, 22, 44, c, { borderRadius: 8 }), r(CX + 14, 68, 22, 6, a, { borderRadius: 3 })],
  shirt: (c, a) => [r(CX - 40, 10, 80, 66, c, { borderTopLeftRadius: 14, borderTopRightRadius: 14, borderBottomLeftRadius: 22, borderBottomRightRadius: 22 }), tri(CX, 16, 28, 16, a, 'down')],
  cape: (c, a) => [r(CX - 52, 6, 104, 72, c, { borderTopLeftRadius: 20, borderTopRightRadius: 20, borderBottomLeftRadius: 44, borderBottomRightRadius: 44 }), circle(CX, 12, 12, a)],
  kimono: (c, a) => [r(CX - 42, 6, 84, 70, c, { borderRadius: 12 }), r(CX - 42, 44, 84, 14, a), tri(CX, 14, 26, 16, a, 'down')],
  hoodie: (c, a) => [r(CX - 44, 8, 88, 68, c, { borderRadius: 16 }), ring(CX, 10, 40, a, 3), r(CX - 24, 48, 48, 16, a, { borderRadius: 8, opacity: 0.55 })],
  // accessory
  collar: (c, a) => [r(CX - 36, 34, 72, 10, c, { borderRadius: 5 }), circle(CX, 52, 14, a)],
  bell: (c, a) => [r(CX - 36, 34, 72, 8, c, { borderRadius: 4 }), circle(CX, 52, 20, a), r(CX - 4, 54, 8, 3, c, { borderRadius: 1 })],
  bowtie: (c, a) => [tri(CX - 14, 40, 26, 24, c, 'left'), tri(CX + 14, 40, 26, 24, c, 'right'), circle(CX, 40, 10, a)],
  tailbow: (c, a) => [tri(CX - 12, 40, 22, 22, c, 'left'), tri(CX + 12, 40, 22, 22, c, 'right'), circle(CX, 40, 9, a)],
  badge: (c, a) => [circle(CX, 40, 26, c), r(CX - 7, 33, 14, 14, a, { transform: [{ rotate: '45deg' }], borderRadius: 2 })],
};

/** Per-shape nudge from the slot anchor, for art that does not sit at the neck or eye line. */
const OFFSET: Record<string, { dx: number; dy: number }> = {
  tailbow: { dx: 58, dy: 70 },
  badge: { dx: -26, dy: 28 },
  monocle: { dx: 0, dy: 0 },
};

export type CosmeticArtProps = { art: ArtSpec };

/** One ArtSpec drawn in its local SHAPE_BOX. Never throws: an unknown shape is a plain colour patch. */
export function CosmeticArt({ art }: CosmeticArtProps) {
  const draw = SHAPES[art.shape];
  const color = art.color || '#888';
  const accent = art.accent || color;
  let parts: ReactElement[];
  try {
    parts = draw ? draw(color, accent) : [r(CX - 30, CY - 20, 60, 40, color, { borderRadius: 10 })];
    const s = art.pattern === 'stripe' ? STRIPE[art.shape] : undefined;
    if (s) parts = [...parts, r(s.x, s.y, s.w, s.h, accent)];
  } catch {
    parts = [r(CX - 30, CY - 20, 60, 40, color, { borderRadius: 10 })];
  }
  return <View style={styles.local}>{parts}</View>;
}

export type CosmeticLayerProps = {
  slot: Slot;
  art: ArtSpec;
  /** box units to pixels. Defaults to 1 (the layer is placed inside a CAT_BOX-sized parent). */
  scale?: number;
  opacity?: number;
};

/** Renders one ArtSpec at its slot anchor, in CAT_BOX units. */
export function CosmeticLayer({ slot, art, scale = 1, opacity = 1 }: CosmeticLayerProps) {
  const anchor = ANCHORS[slot];
  const off = OFFSET[art.shape] ?? { dx: 0, dy: 0 };
  const left = (anchor.x + off.dx - SHAPE_BOX.w / 2) * scale;
  const top = (anchor.y + off.dy - SHAPE_BOX.h / 2) * scale;
  return (
    <View
      pointerEvents="none"
      style={{ position: 'absolute', left, top, width: SHAPE_BOX.w * scale, height: SHAPE_BOX.h * scale, opacity }}>
      <View style={{ width: SHAPE_BOX.w, height: SHAPE_BOX.h, transform: [{ translateX: (-SHAPE_BOX.w * (1 - scale)) / 2 }, { translateY: (-SHAPE_BOX.h * (1 - scale)) / 2 }, { scale }] }}>
        <CosmeticArt art={art} />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  abs: { position: 'absolute' },
  local: { width: SHAPE_BOX.w, height: SHAPE_BOX.h },
});
