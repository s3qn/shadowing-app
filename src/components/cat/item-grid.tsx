import { useCallback, useEffect, useRef, useState } from 'react';
import { FlatList, Pressable, StyleSheet, Text, useWindowDimensions, View } from 'react-native';
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
  const dim = state === 'locked' || state === 'unaffordable';
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

  const pill =
    state === 'equipped' ? (
      <View style={[styles.pill, styles.pillWorn]}>
        <Text style={[styles.pillText, { color: '#0B1020' }]}>{t('wardrobe.worn')}</Text>
      </View>
    ) : state === 'owned' ? (
      <View style={[styles.pill, styles.pillOwned]}>
        <Text style={[styles.pillText, { color: tide.textDim }]}>{t('wardrobe.owned')}</Text>
      </View>
    ) : state === 'locked' ? (
      <View style={[styles.pill, styles.pillLock]}>
        <Text style={[styles.pillText, { color: '#D4D9F2' }]}>{t('wardrobe.lv', { n: item.level_req })}</Text>
      </View>
    ) : (
      <View style={[styles.pill, styles.pillBuy, dir.row, state === 'unaffordable' && styles.pillNo]}>
        <View style={[styles.coin, state === 'unaffordable' && { opacity: 0.5 }]} />
        <Text style={[styles.pillText, { color: state === 'unaffordable' ? '#E0D5B2' : GOLD }]}>{item.price === 0 ? t('wardrobe.claim') : item.price}</Text>
      </View>
    );

  return (
    <Animated.View style={[{ width: size, height: size }, cellStyle]}>
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
          {worn ? (
            <Animated.View style={[styles.check, dir.rtl ? { left: 7 } : { right: 7 }, checkStyle]}>
              <Text style={styles.checkGlyph}>✓</Text>
            </Animated.View>
          ) : null}
          <View style={styles.disc}>
            <View style={{ width: SHAPE_BOX.w * ART_SCALE, height: SHAPE_BOX.h * ART_SCALE, opacity: dim ? 0.7 : 1 }}>
              <View style={{ width: SHAPE_BOX.w, height: SHAPE_BOX.h, transform: [{ translateX: -(SHAPE_BOX.w * (1 - ART_SCALE)) / 2 }, { translateY: -(SHAPE_BOX.h * (1 - ART_SCALE)) / 2 }, { scale: ART_SCALE }] }}>
                <CosmeticArt art={item.art} />
              </View>
            </View>
          </View>
          <Text numberOfLines={1} style={[styles.name, dim && { color: '#C4CAEA' }]}>
            {item.name}
          </Text>
          {pill}
        </View>
      </Pressable>
    </Animated.View>
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
    paddingTop: 9,
    paddingHorizontal: 4,
    gap: 5,
    borderRadius: 20,
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.10)',
    backgroundColor: 'rgba(255,255,255,0.05)',
  },
  selRim: {
    position: 'absolute', left: 0, right: 0, top: 0, bottom: 0,
    margin: -1,
    borderRadius: 20,
    padding: 2,
    experimental_backgroundImage: 'linear-gradient(135deg, #FF5468, #f4f2f8 50%, #7CC8FF)',
    boxShadow: '0 0 22px rgba(124,200,255,0.38)',
  },
  selInner: { flex: 1, borderRadius: 18, backgroundColor: '#1d2450' },
  wornRim: { position: 'absolute', left: 0, right: 0, top: 0, bottom: 0, margin: -1, borderRadius: 20, borderWidth: 2, borderColor: CYAN, backgroundColor: 'rgba(124,200,255,0.12)' },
  check: { position: 'absolute', top: 7, width: 17, height: 17, borderRadius: 9, backgroundColor: CYAN, alignItems: 'center', justifyContent: 'center', zIndex: 2 },
  checkGlyph: { fontSize: 11, lineHeight: 13, fontWeight: '700', color: '#0B1020' },
  disc: { width: DISC, height: DISC, borderRadius: DISC / 2, backgroundColor: '#232b5e', alignItems: 'center', justifyContent: 'center', overflow: 'hidden' },
  name: { fontFamily: fonts.ui, fontSize: 13, lineHeight: 16, fontWeight: '600', color: tide.text },
  pill: { height: 22, paddingHorizontal: 9, borderRadius: 11, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 5 },
  pillText: { fontFamily: fonts.ui, fontSize: 13, fontWeight: '600', lineHeight: 16 },
  pillWorn: { backgroundColor: CYAN },
  pillOwned: { borderWidth: 1, borderColor: 'rgba(255,255,255,0.16)' },
  pillBuy: { backgroundColor: 'rgba(255,200,87,0.12)', borderWidth: 1, borderColor: 'rgba(255,200,87,0.38)' },
  pillNo: { backgroundColor: 'transparent', borderColor: 'rgba(255,200,87,0.4)' },
  pillLock: { backgroundColor: 'rgba(255,255,255,0.10)', borderWidth: 1, borderColor: 'rgba(255,255,255,0.26)' },
  coin: { width: 10, height: 10, borderRadius: 5, backgroundColor: GOLD },
});
