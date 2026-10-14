import { useCallback, useEffect, useRef, useState } from 'react';
import { FlatList, Pressable, StyleSheet, Text, useWindowDimensions, View, type StyleProp, type ViewStyle } from 'react-native';
import Animated, { cancelAnimation, runOnJS, useAnimatedStyle, useReducedMotion, useSharedValue, withDelay, withSpring, withTiming, type SharedValue } from 'react-native-reanimated';

import { CosmeticArt, SHAPE_BOX } from '@/components/cat/cosmetic-layer';
import { fonts } from '@/constants/fonts';
import { Spacing, tide } from '@/constants/theme';
import { useDir, useT } from '@/lib/i18n';
import { itemState, type CosmeticItem, type ItemState, type Progress } from '@/lib/progression';

const COLUMNS = 3;
export const GAP = Spacing.sm;
const DISC = 48;
const ART_SCALE = 0.36;
const CYAN = '#7CC8FF';
const GOLD = '#FFC857';
const INK = '#0B1030';
const TILE_H = 128;
const ENTER = { damping: 18, stiffness: 180 } as const;
const STAGGER_MS = 40;
const STAGGER_CELLS = 12;

export type ItemGridProps = {
  items: CosmeticItem[];
  progress: Progress;
  selectedId: string | null;
  /** Changes with the slot: cells of the old key fade out, the new ones stagger in. */
  slotKey: string;
  onSelect: (item: CosmeticItem) => void;
  /** Extra room under the last row, for the floating action bar. */
  bottomPad?: number;
};

/** Keeps a layer mounted while it fades out, so a crossfade is opacity only. */
function useFade(on: boolean, ms: number, reduced: boolean): { mounted: boolean; t: SharedValue<number> } {
  const t = useSharedValue(on ? 1 : 0);
  const [mounted, setMounted] = useState(on);
  const first = useRef(true);
  useEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    cancelAnimation(t);
    if (on) {
      setMounted(true);
      t.value = reduced ? 1 : withTiming(1, { duration: ms });
      return;
    }
    t.value = reduced ? 0 : withTiming(0, { duration: ms });
    const id = setTimeout(() => setMounted(false), reduced ? 0 : ms + 20);
    return () => clearTimeout(id);
  }, [on, ms, reduced, t]);
  return { mounted, t };
}

type CellProps = { item: CosmeticItem; state: ItemState; selected: boolean; index: number; size: number; animate: boolean; onPress: () => void };

/** Cell ids that already played their entrance, so a remounted cell appears flat. */
const entered = new Set<string>();

function Cell({ item, state, selected, index, size, animate, onPress }: CellProps) {
  const { t } = useT();
  const dir = useDir();
  const reduced = useReducedMotion();
  const worn = state === 'equipped';
  const enter = useSharedValue(animate && !reduced && !entered.has(item.id) ? 0 : 1);
  const press = useSharedValue(1);
  const sel = useFade(selected && !worn, 140, reduced);
  const wornFade = useFade(worn, 160, reduced);
  const check = useSharedValue(worn ? 1 : 0);

  useEffect(() => {
    if (animate && !reduced && !entered.has(item.id)) {
      entered.add(item.id);
      enter.value = withDelay(Math.min(index, STAGGER_CELLS - 1) * STAGGER_MS, withSpring(1, ENTER));
    }
  }, [animate, reduced, index, enter, item.id]);
  useEffect(() => {
    cancelAnimation(check);
    if (!worn) check.value = 0;
    else check.value = reduced ? 1 : withSpring(1, { damping: 14, stiffness: 260 });
  }, [worn, reduced, check]);

  const cellStyle = useAnimatedStyle(() => {
    const e = Number.isFinite(enter.value) ? enter.value : 1;
    return { opacity: Math.min(1, Math.max(0, e)), transform: [{ translateY: (1 - e) * 12 }, { scale: press.value }] };
  });
  const selStyle = useAnimatedStyle(() => ({ opacity: sel.t.value }));
  const wornStyle = useAnimatedStyle(() => ({ opacity: wornFade.t.value }));
  const checkStyle = useAnimatedStyle(() => ({ opacity: Math.min(1, check.value * 2), transform: [{ scale: Number.isFinite(check.value) ? check.value : 1 }] }));

  const unaffordable = state === 'unaffordable';
  const locked = state === 'locked';
  const band =
    state === 'equipped' ? (
      <View style={[styles.band, { backgroundColor: CYAN }]}>
        <Text style={[styles.bandText, { color: INK }]}>{t('wardrobe.worn')}</Text>
      </View>
    ) : state === 'owned' ? (
      <View style={[styles.band, { backgroundColor: 'rgba(255,255,255,0.04)' }]}>
        <Text style={[styles.bandText, { color: '#98A0CC' }]}>{t('wardrobe.owned')}</Text>
      </View>
    ) : locked ? (
      <View style={[styles.band, dir.row, { backgroundColor: 'rgba(255,255,255,0.05)' }]}>
        <LockGlyph color="#8A90B8" style={dir.rtl ? { marginLeft: 5 } : { marginRight: 5 }} />
        <Text style={[styles.bandText, { color: '#8A90B8' }]}>{t('wardrobe.lv', { n: item.level_req })}</Text>
      </View>
    ) : item.price === 0 ? (
      <View style={[styles.band, { backgroundColor: GOLD }]}>
        <Text style={[styles.bandText, { color: INK }]}>{t('wardrobe.claim')}</Text>
      </View>
    ) : (
      <View style={[styles.band, dir.row, unaffordable ? styles.bandNo : styles.bandBuy]}>
        <View style={[styles.coin, dir.rtl ? { marginLeft: 5 } : { marginRight: 5 }]} />
        <Text style={[styles.bandText, { color: unaffordable ? GOLD : '#FFD27A' }]}>{item.price}</Text>
      </View>
    );

  return (
    <Animated.View style={[{ width: size, height: TILE_H }, cellStyle]}>
      <Pressable
        onPress={onPress}
        onPressIn={() => {
          press.value = withTiming(0.97, { duration: 80 });
        }}
        onPressOut={() => {
          press.value = withSpring(1, { damping: 14, stiffness: 260, mass: 0.6 });
        }}
        accessibilityRole="button"
        accessibilityLabel={item.name}
        accessibilityState={{ selected: selected || worn }}
        style={styles.fill}>
        <View style={[styles.fill, styles.cell]}>
          {sel.mounted ? (
            <Animated.View pointerEvents="none" style={[styles.selRim, selStyle]}>
              <View style={styles.selInner} />
            </Animated.View>
          ) : null}
          {wornFade.mounted ? <Animated.View pointerEvents="none" style={[styles.wornRim, wornStyle]} /> : null}
          <View style={[styles.discRing, worn && styles.discRingWorn, unaffordable && { opacity: 0.75 }]}>
            <View style={[styles.disc, locked && { backgroundColor: '#27306A' }]}>
              <View style={{ width: SHAPE_BOX.w * ART_SCALE, height: SHAPE_BOX.h * ART_SCALE, opacity: locked ? 0.45 : 1 }}>
                <View style={{ width: SHAPE_BOX.w, height: SHAPE_BOX.h, transform: [{ translateX: -(SHAPE_BOX.w * (1 - ART_SCALE)) / 2 }, { translateY: -(SHAPE_BOX.h * (1 - ART_SCALE)) / 2 }, { scale: ART_SCALE }] }}>
                  <CosmeticArt art={item.art} />
                </View>
              </View>
              {locked ? (
                <View pointerEvents="none" style={styles.veil}>
                  <LockGlyph color="#E8EAF6" style={{ transform: [{ scale: 1.15 }] }} />
                </View>
              ) : null}
            </View>
          </View>
          <Text numberOfLines={1} style={[styles.name, locked && { opacity: 0.55 }, unaffordable && { opacity: 0.7 }]}>
            {item.name}
          </Text>
          <View style={styles.bandClip} pointerEvents="none">
            {band}
          </View>
          {worn ? (
            <Animated.View style={[styles.check, dir.rtl ? { left: -6 } : { right: -6 }, checkStyle]}>
              <Text style={styles.checkGlyph}>✓</Text>
            </Animated.View>
          ) : null}
        </View>
      </Pressable>
    </Animated.View>
  );
}

/** A padlock from Views: shackle above a body, drawn in the given colour. */
function LockGlyph({ color, style }: { color: string; style?: StyleProp<ViewStyle> }) {
  return (
    <View style={[{ alignItems: 'center' }, style]}>
      <View style={{ width: 7, height: 6, borderWidth: 1.7, borderBottomWidth: 0, borderTopLeftRadius: 4, borderTopRightRadius: 4, borderColor: color }} />
      <View style={{ width: 10, height: 8, borderRadius: 2, backgroundColor: color }} />
    </View>
  );
}

/**
 * The item grid: three columns of square cells. The first on-screen cells of a
 * slot stagger in (a per-cell delay, not a layout animation); cells scrolled in
 * later appear flat. A slot change fades the old cells out over 100ms first.
 */
export function ItemGrid({ items, progress, selectedId, slotKey, onSelect, bottomPad = 0 }: ItemGridProps) {
  const { width } = useWindowDimensions();
  const size = Math.floor((width - 2 * Spacing.lg - GAP * (COLUMNS - 1)) / COLUMNS);
  const reduced = useReducedMotion();
  const [shown, setShown] = useState({ key: slotKey, items });
  const fade = useSharedValue(1);
  const swap = useCallback(
    (key: string, next: CosmeticItem[]) => {
      setShown({ key, items: next });
      fade.value = 1;
    },
    [fade],
  );

  // Same slot: new items (a catalog refresh) replace in place. New slot: fade out, then swap.
  useEffect(() => {
    if (slotKey === shown.key) {
      if (items !== shown.items) setShown({ key: slotKey, items });
      return;
    }
    cancelAnimation(fade);
    if (reduced) {
      fade.value = 1;
      setShown({ key: slotKey, items });
      return;
    }
    fade.value = withTiming(0, { duration: 100 }, (done) => {
      'worklet';
      if (done) {
        runOnJS(swap)(slotKey, items);
      }
    });
  }, [slotKey, items, shown, fade, reduced, swap]);

  const fadeStyle = useAnimatedStyle(() => ({ opacity: fade.value }));

  return (
    <Animated.View style={[styles.fill, fadeStyle]}>
      <FlatList
        key={shown.key}
        data={shown.items}
        keyExtractor={(i) => i.id}
        numColumns={COLUMNS}
        columnWrapperStyle={styles.columns}
        contentContainerStyle={[styles.content, { paddingBottom: bottomPad }]}
        showsVerticalScrollIndicator={false}
        initialNumToRender={STAGGER_CELLS}
        maxToRenderPerBatch={6}
        windowSize={3}
        renderItem={({ item, index }) => (
          <Cell
            item={item}
            state={itemState(item, progress)}
            selected={selectedId === item.id}
            index={index}
            size={size}
            animate={index < STAGGER_CELLS}
            onPress={() => onSelect(item)}
          />
        )}
      />
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1 },
  content: { gap: GAP },
  columns: { gap: GAP },
  cell: {
    alignItems: 'center',
    paddingTop: 12,
    paddingHorizontal: 8,
    paddingBottom: 34,
    gap: 6,
    borderRadius: 20,
    experimental_backgroundImage: 'linear-gradient(180deg, #1E2658, #141A40)',
    boxShadow: 'inset 0 1px 0 rgba(255,255,255,0.10)',
  },
  selRim: {
    position: 'absolute', left: 0, right: 0, top: 0, bottom: 0,
    borderRadius: 20,
    padding: 2,
    experimental_backgroundImage: 'linear-gradient(90deg, #FF5468, rgba(255,255,255,0.9) 30%, rgba(255,255,255,0.9) 70%, #7CC8FF)',
    boxShadow: '-8px 0 18px -6px rgba(255,70,110,0.40), 8px 0 18px -6px rgba(70,170,255,0.45)',
  },
  selInner: { flex: 1, borderRadius: 18, backgroundColor: '#171E48' },
  wornRim: {
    position: 'absolute', left: 0, right: 0, top: 0, bottom: 0,
    borderRadius: 20,
    boxShadow: 'inset 0 0 0 1px rgba(124,200,255,0.55), inset 0 -26px 28px -14px rgba(124,200,255,0.30)',
  },
  check: { position: 'absolute', top: -6, width: 22, height: 22, borderRadius: 11, backgroundColor: CYAN, alignItems: 'center', justifyContent: 'center', zIndex: 2 },
  checkGlyph: { fontSize: 13, lineHeight: 16, fontWeight: '700', color: INK },
  discRing: { width: DISC, height: DISC, borderRadius: DISC / 2 },
  discRingWorn: { boxShadow: '0 0 0 2px #7CC8FF, 0 0 18px rgba(124,200,255,0.55)' },
  disc: { width: DISC, height: DISC, borderRadius: DISC / 2, backgroundColor: '#232b5e', alignItems: 'center', justifyContent: 'center', overflow: 'hidden' },
  veil: {
    position: 'absolute', left: 0, right: 0, top: 0, bottom: 0,
    alignItems: 'center', justifyContent: 'center',
    experimental_backgroundImage: 'linear-gradient(160deg, rgba(190,200,255,0.22), rgba(120,130,200,0.08))',
    boxShadow: 'inset 0 0 0 1px rgba(200,210,255,0.30)',
  },
  name: { fontFamily: fonts.ui, fontSize: 12.5, lineHeight: 16, fontWeight: '500', color: tide.text, maxWidth: '100%' },
  bandClip: { position: 'absolute', left: 0, right: 0, bottom: 0, height: 28, borderBottomLeftRadius: 20, borderBottomRightRadius: 20, overflow: 'hidden' },
  band: { height: 28, flexDirection: 'row', alignItems: 'center', justifyContent: 'center' },
  bandText: { fontFamily: fonts.ui, fontSize: 11.5, fontWeight: '600', letterSpacing: 0.1, lineHeight: 14 },
  bandBuy: {
    experimental_backgroundImage: 'linear-gradient(180deg, rgba(255,200,87,0.40), rgba(255,200,87,0.04))',
    boxShadow: 'inset 0 2px 0 #FFD98F',
  },
  bandNo: { opacity: 0.55, borderTopWidth: 1, borderStyle: 'dashed', borderColor: 'rgba(255,200,87,0.55)' },
  coin: { width: 9, height: 9, borderRadius: 5, backgroundColor: GOLD, borderWidth: 2, borderColor: '#E8A92E' },
});
