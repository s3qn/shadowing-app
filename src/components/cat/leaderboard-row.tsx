import { memo, useEffect } from 'react';
import { Image, StyleSheet, Text, View } from 'react-native';
import Animated, { Easing, useAnimatedStyle, useReducedMotion, useSharedValue, withDelay, withTiming } from 'react-native-reanimated';

import type { Slot } from '@/constants/cosmetics';
import { ITEM_IMAGES } from '@/constants/cosmetic-images';
import { fonts } from '@/constants/fonts';
import { Radius, Spacing, tide } from '@/constants/theme';
import { useDir, useT } from '@/lib/i18n';

export const GOLD = '#F7C55B';
export const BLUE = '#6FB6FF';
export const ROW_H = 64;
const BASE_CAT = require('../../../assets/kageneko-base.png') as number;
const PAWS = require('../../../assets/kageneko-paws.png') as number;

// Artboard scale: every layer is authored at this size and placed 1:1.
const CANVAS = 1254;
type Box = { x: number; y: number; w: number; h: number };
// Top-left and native size of each item PNG (centre minus half size).
const SLOT_BOX: Record<Slot | 'tail', Box> = {
  head: { x: 345.5, y: 10, w: 560, h: 320 },
  face: { x: 305.5, y: 375, w: 640, h: 280 },
  accessory: { x: 405.5, y: 760, w: 440, h: 180 },
  body: { x: 345.5, y: 800, w: 560, h: 400 },
  tail: { x: 941.7, y: 749.4, w: 220, h: 180 },
};
// The square of the canvas shown in the medallion: the cat sits in the central
// upper region, so crop the empty margins and centre on the cat.
const WINDOW = 1150;
const WIN_CX = 625;
const WIN_CY = 620;

export type EquippedIds = Partial<Record<Slot, string | null>>;

/**
 * A static dressed cat composed on the 1254 canvas, then the whole composite is
 * scaled and cropped to a circle. Back to front: base, tail bow, body, paws,
 * accessory, face, head. Plain Images only: no Rive, no blur, nothing animated.
 */

// TODO(perf): swap the live Rive medallion for a pre-baked thumbnail (D47).
export const Medallion = memo(function Medallion({ size, equipped }: { size: number; equipped: EquippedIds }) {
  const k = size / WINDOW;
  const ox = size / 2 - WIN_CX * k;
  const oy = size / 2 - WIN_CY * k;
  const item = (slot: Slot) => {
    const id = equipped[slot];
    return id ? { id, src: ITEM_IMAGES[id] } : null;
  };
  const acc = item('accessory');
  const tailBow = acc && acc.id.startsWith('accessory.tailbow') ? acc : null;
  const neck = acc && !tailBow ? acc : null;
  const place = (key: string, src: number | undefined, box: Box) =>
    src === undefined ? null : (
      <Image key={key} source={src} resizeMode="contain" style={{ position: 'absolute', left: box.x * k, top: box.y * k, width: box.w * k, height: box.h * k }} />
    );
  const full = { position: 'absolute' as const, left: 0, top: 0, width: CANVAS * k, height: CANVAS * k };
  return (
    <View style={[styles.medal, { width: size, height: size, borderRadius: size / 2, experimental_backgroundImage: 'radial-gradient(circle at 50% 35%, #3A5C8C, #223A5E)' }]}>
      <View style={{ position: 'absolute', left: ox, top: oy, width: CANVAS * k, height: CANVAS * k }}>
        <Image source={BASE_CAT} resizeMode="contain" style={full} />
        {tailBow ? place('tail', tailBow.src, SLOT_BOX.tail) : null}
        {place('body', item('body')?.src, SLOT_BOX.body)}
        <Image source={PAWS} resizeMode="contain" style={full} />
        {neck ? place('accessory', neck.src, SLOT_BOX.accessory) : null}
        {place('face', item('face')?.src, SLOT_BOX.face)}
        {place('head', item('head')?.src, SLOT_BOX.head)}
      </View>
    </View>
  );
});

export function LevelChip({ level, tone }: { level: number; tone: 'gold' | 'blue' | 'plain' }) {
  const { t } = useT();
  const c = tone === 'gold' ? GOLD : tone === 'blue' ? BLUE : tide.text;
  const bg = tone === 'gold' ? 'rgba(247,197,91,0.14)' : tone === 'blue' ? 'rgba(111,182,255,0.18)' : 'rgba(255,255,255,0.08)';
  return (
    <View style={[styles.chip, { borderColor: c, backgroundColor: bg }]}>
      <Text style={[styles.chipLv, { color: c }]}>{t('leaderboard.lv')}</Text>
      <Text style={[styles.chipNum, { color: c }]}>{level}</Text>
    </View>
  );
}

export type RowProps = {
  rank: number;
  username: string;
  level: number;
  equipped: EquippedIds;
  /** The viewer's own row. */
  mine?: boolean;
  /** Pinned copy: adds the "you" tag and the next-rank line. */
  pinned?: boolean;
  nextLine?: string | null;
  /** List position, drives the entrance stagger (first few rows only). */
  index?: number;
};

const STAGGER_MS = 50;
const STAGGER_CAP = 6;

export const LeaderboardRow = memo(function LeaderboardRow({ rank, username, level, equipped, mine, pinned, nextLine, index = 99 }: RowProps) {
  const { t } = useT();
  const dir = useDir();
  const reduced = useReducedMotion();
  const staggered = !pinned && index < STAGGER_CAP && !reduced;
  const enter = useSharedValue(staggered || pinned ? 0 : 1);
  useEffect(() => {
    if (reduced) {
      enter.value = 1;
      return;
    }
    const delay = pinned ? 120 : index * STAGGER_MS;
    if (pinned || staggered) enter.value = withDelay(delay, withTiming(1, { duration: 260, easing: Easing.out(Easing.cubic) }));
  }, [reduced, pinned, staggered, index, enter]);
  const style = useAnimatedStyle(() => ({
    opacity: enter.value,
    transform: [{ translateY: (1 - enter.value) * (pinned ? 36 : 14) }],
  }));

  const gold = rank <= 3;
  const tone = mine ? 'blue' : gold ? 'gold' : 'plain';
  const rankColour = mine ? BLUE : gold ? GOLD : tide.textDim;
  return (
    <Animated.View style={style}>
      <View
        accessible
        accessibilityLabel={`${rank}. @${username}, ${t('leaderboard.lv')} ${level}`}
        style={[styles.row, mine && styles.rowMine, pinned && styles.rowPinned, dir.row]}
      >
        <Text style={[styles.rank, { color: rankColour }]}>{rank}</Text>
        <Medallion size={52} equipped={equipped} />
        <View style={styles.names}>
          <Text numberOfLines={1} style={[styles.name, { textAlign: 'left', writingDirection: 'ltr' }]}>
            @{username}
            {pinned ? <Text style={styles.you}>{`  ${t('leaderboard.you')}`}</Text> : null}
          </Text>
          {pinned && nextLine ? (
            <Text numberOfLines={1} style={styles.next}>
              {nextLine}
            </Text>
          ) : null}
        </View>
        <LevelChip level={level} tone={tone} />
      </View>
    </Animated.View>
  );
});

const styles = StyleSheet.create({
  medal: { overflow: 'hidden', borderWidth: 1, borderColor: 'rgba(255,255,255,0.25)' },
  row: {
    flexDirection: 'row',
    height: ROW_H,
    alignItems: 'center',
    gap: Spacing.md,
    paddingHorizontal: Spacing.md,
    borderRadius: Radius.lg,
    backgroundColor: 'rgba(34,58,94,0.72)',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.12)',
  },
  rowMine: { borderColor: BLUE, backgroundColor: 'rgba(40,80,130,0.8)' },
  rowPinned: { height: 72, boxShadow: '0 8px 24px rgba(0,0,0,0.35)' },
  rank: { width: 22, textAlign: 'center', fontFamily: fonts.uiMedium, fontSize: 18 },
  names: { flex: 1 },
  name: { fontFamily: fonts.ui, fontSize: 18, color: tide.text },
  you: { fontSize: 13, color: BLUE },
  next: { fontFamily: fonts.ui, fontSize: 12, color: tide.textDim, marginTop: 2 },
  chip: { minWidth: 52, alignItems: 'center', paddingVertical: 2, paddingHorizontal: Spacing.sm, borderRadius: Radius.lg, borderWidth: 1.5 },
  chipLv: { fontFamily: fonts.uiMedium, fontSize: 9, letterSpacing: 1 },
  chipNum: { fontFamily: fonts.uiMedium, fontSize: 20, lineHeight: 22 },
});
