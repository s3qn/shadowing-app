import { verb } from '@/constants/theme';

/** The slot contract: the placeholder cat and a later Rive cat both bind to it. */
export const SLOTS = ['head', 'face', 'body', 'accessory'] as const;
export type Slot = (typeof SLOTS)[number];

/** Back to front. 'base' is the cat itself. */
export const Z_ORDER = ['base', 'body', 'accessory', 'face', 'head'] as const;

/** The cat's drawing box. Everything is laid out in these units, then scaled. */
export const CAT_BOX = { w: 200, h: 240 } as const;

/** Where each slot's art is centred, in CAT_BOX units. */
export const ANCHORS: Record<Slot, { x: number; y: number }> = {
  head: { x: 100, y: 52 },
  face: { x: 100, y: 88 },
  body: { x: 100, y: 160 },
  accessory: { x: 100, y: 128 },
};

/** What an item looks like. Unknown shapes or patterns render as a plain color patch. */
export type ArtSpec = {
  shape: string;
  color: string;
  accent: string;
  pattern?: string;
  /** Metro asset id of the item PNG at the slot canvas size. Absent until the real art lands. */
  image?: number;
};

/** The Rive cat's `mode` enum, in the order the .riv defines it. */
export const KAGENEKO_MODES = ['idle', 'listening', 'your_turn', 'recording'] as const;
export type KagenekoMode = (typeof KAGENEKO_MODES)[number];

export type Equipped = Partial<Record<Slot, ArtSpec | null>>;

/** The shape vocabulary, mirrored in the server catalog `shapes`. */
export const SHAPES: Record<Slot, readonly string[]> = {
  head: ['cap', 'beanie', 'tophat', 'crown', 'bow'],
  face: ['glasses', 'shades', 'monocle', 'mask', 'blush'],
  body: ['scarf', 'shirt', 'cape', 'kimono', 'hoodie'],
  accessory: ['collar', 'bell', 'bowtie', 'tailbow', 'badge'],
};

/** Colour tint of an item's price, by rarity. */
export function rarityTint(price: number): string {
  if (price <= 0) return verb.read.c1;
  if (price < 100) return verb.tools.c1;
  if (price < 400) return verb.listen.c1;
  return verb.speak.c1;
}
