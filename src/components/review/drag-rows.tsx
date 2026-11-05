import { Pressable, StyleSheet, Text, View, type ViewStyle } from 'react-native';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import Animated, { Easing, type SharedValue, useAnimatedReaction, useAnimatedStyle, useSharedValue, withTiming } from 'react-native-reanimated';
import { scheduleOnRN } from 'react-native-worklets';

import { ProjectRow, ROW_H, rowStyles } from '@/components/review/project-row';
import { fonts } from '@/constants/fonts';
import { tide } from '@/constants/theme';
import type * as api from '@/lib/api';
import { hapticImpact, hapticSelection } from '@/lib/haptics';
import { useT } from '@/lib/i18n';

const LIFT_MS = 160;
const SLIDE = { duration: 180, easing: Easing.out(Easing.cubic) };
// Swipe to remove: the red action's width, and how far past it a release still opens it.
const ACTION_W = 72;
const REMOVE_RED = '#FF5C5C';
// The lifted row's shadow: the theme's `0 6 16` at 0.32, in the sky's dark ink rather than pure black.
const LIFT_SHADOW = { shadowColor: '#040C1E', shadowOffset: { width: 0, height: 6 }, shadowRadius: 8 } as const;
const LIFT_OPACITY = 0.32;
const liftHaptic = () => void hapticImpact();
const dropHaptic = () => void hapticSelection();

export type DragProps = {
  items: api.SessionProject[];
  enabled: boolean;
  dirRow: ViewStyle | undefined;
  rtl: boolean;
  openId: SharedValue<string>;
  keepOpen: () => void;
  onOrder: (ids: string[]) => void;
  onTap: (id: string) => void;
  onRemove: (id: string) => void;
};

/** The project rows: tap one to change it, hold one (350ms) or its grip to lift it and drag it up or down, swipe it toward the leading edge to show Remove. The order lives in `order` on the UI thread until the drop. */
export function DragRows({ items, ...rest }: DragProps) {
  const order = useSharedValue<string[]>(items.map((p) => p.island_id));
  const active = useSharedValue('');
  return (
    <View style={{ height: items.length * ROW_H }}>
      {items.map((p, i) => (
        <DragRow key={p.island_id} p={p} slot={i} rows={items.length} order={order} active={active} canRemove={items.length > 1} {...rest} />
      ))}
    </View>
  );
}

type RowProps = Omit<DragProps, 'items'> & { canRemove: boolean; p: api.SessionProject; slot: number; rows: number; order: SharedValue<string[]>; active: SharedValue<string> };

function DragRow({ p, slot, rows, order, active, enabled, dirRow, rtl, openId, keepOpen, onOrder, onTap, onRemove, canRemove }: RowProps) {
  const { t } = useT();
  const id = p.island_id;
  const maxY = Math.max(0, (rows - 1) * ROW_H);
  const top = useSharedValue(slot * ROW_H);
  const from = useSharedValue(0);
  const lift = useSharedValue(0);
  // Swipe: `shift` is how far the row has moved toward the leading edge (0 closed, ACTION_W open), `rowW` its measured width.
  const shift = useSharedValue(0);
  const shiftFrom = useSharedValue(0);
  const rowW = useSharedValue(0);
  const wasOpen = useSharedValue(false);
  const lead = rtl ? 1 : -1;
  // Another row moved past this one: slide to the new slot.
  useAnimatedReaction(
    () => order.value.indexOf(id),
    (now, prev) => {
      if (prev === null || now === prev || now < 0 || active.value === id) return;
      top.value = withTiming(now * ROW_H, SLIDE);
    },
  );
  // Another row opened, or a touch elsewhere closed this one.
  useAnimatedReaction(
    () => openId.value,
    (now) => {
      if (now !== id && shift.value !== 0) shift.value = withTiming(0, SLIDE);
    },
  );
  // `order`, `active` and `openId` are shared values from the screen, written on the UI thread; the react-compiler rule reads that as prop mutation.
  /* eslint-disable react-hooks/immutability */
  const makePan = (grip: boolean) => {
    const g = Gesture.Pan().enabled(enabled);
    return (grip ? g.minDistance(0) : g.activateAfterLongPress(350))
    .onStart(() => {
      openId.value = '';
      active.value = id;
      from.value = top.value;
      lift.value = withTiming(1, { duration: LIFT_MS });
      scheduleOnRN(liftHaptic);
    })
    .onUpdate((e) => {
      if (active.value !== id) return;
      const dy = Number.isFinite(e.translationY) ? e.translationY : 0;
      const y = Math.min(maxY, Math.max(0, from.value + dy));
      top.value = y;
      const to = Math.min(rows - 1, Math.max(0, Math.round(y / ROW_H)));
      const cur = order.value.indexOf(id);
      if (cur < 0 || to === cur) return;
      const next = order.value.slice();
      next.splice(cur, 1);
      next.splice(to, 0, id);
      order.value = next;
    })
    .onFinalize(() => {
      if (active.value !== id) return;
      const ids = order.value.slice();
      lift.value = withTiming(0, { duration: LIFT_MS });
      scheduleOnRN(dropHaptic);
      top.value = withTiming(Math.max(0, ids.indexOf(id)) * ROW_H, { duration: LIFT_MS }, () => {
        if (active.value === id) active.value = '';
        scheduleOnRN(onOrder, ids);
      });
    });
  };
  const pan = makePan(false);
  const gripPan = makePan(true);
  const swipe = Gesture.Pan()
    .enabled(enabled && canRemove)
    .activeOffsetX([-12, 12])
    .failOffsetY([-10, 10])
    .onStart(() => {
      openId.value = id;
      shiftFrom.value = shift.value;
    })
    .onUpdate((e) => {
      const dx = Number.isFinite(e.translationX) ? e.translationX : 0;
      const w = rowW.value > 0 ? rowW.value : ACTION_W;
      shift.value = Math.min(w, Math.max(0, shiftFrom.value + dx * lead));
    })
    .onEnd((e) => {
      const v = Number.isFinite(e.velocityX) ? e.velocityX * lead : 0;
      const w = rowW.value > 0 ? rowW.value : ACTION_W * 2;
      const s = Number.isFinite(shift.value) ? shift.value : 0;
      if (s > w * 0.5) {
        shift.value = withTiming(w, SLIDE, (done) => {
          if (done) scheduleOnRN(onRemove, id);
        });
      } else if (s > ACTION_W / 2 || v > 300) {
        shift.value = withTiming(ACTION_W, SLIDE);
      } else {
        shift.value = withTiming(0, SLIDE);
        if (openId.value === id) openId.value = '';
      }
    });
  const removeNow = () => {
    if (!enabled) return;
    openId.value = '';
    onRemove(id);
  };
  /* eslint-enable react-hooks/immutability */
  const tap = Gesture.Tap()
    .enabled(enabled)
    .onBegin(() => {
      wasOpen.value = shift.value > 0.5;
    })
    .onEnd((_e, ok) => {
      // A tap on an open row only closes it.
      if (ok && !wasOpen.value) scheduleOnRN(onTap, id);
    });
  const style = useAnimatedStyle(() => {
    const l = Number.isFinite(lift.value) ? lift.value : 0;
    const y = Number.isFinite(top.value) ? top.value : 0;
    return { zIndex: active.value === id ? 2 : 1, shadowOpacity: LIFT_OPACITY * l, transform: [{ translateY: y }, { scale: 1 + 0.03 * l }] };
  });
  const slide = useAnimatedStyle(() => {
    const x = Number.isFinite(shift.value) ? shift.value : 0;
    return { transform: [{ translateX: x * lead }] };
  });
  const reveal = useAnimatedStyle(() => {
    const x = Number.isFinite(shift.value) ? shift.value : 0;
    return { width: Math.max(0, x) };
  });
  return (
    <Animated.View style={[styles.dragRow, LIFT_SHADOW, style]} onLayout={(e) => {
        rowW.value = e.nativeEvent.layout.width;
      }}>
      {canRemove ? (
        <Animated.View style={[styles.action, rtl ? { left: 0 } : { right: 0 }, reveal]}>
          <Pressable onPressIn={keepOpen} onPress={removeNow} accessibilityRole="button" accessibilityLabel={t('review.remove')} style={[styles.actionPress, { alignItems: rtl ? 'flex-end' : 'flex-start' }]}>
            <View style={styles.actionLabel}>
              <Text style={styles.actionText} numberOfLines={1}>
                {t('review.swipeRemove')}
              </Text>
            </View>
          </Pressable>
        </Animated.View>
      ) : null}
      <Animated.View style={[rowStyles.row, dirRow, slide]}>
        <GestureDetector gesture={Gesture.Race(swipe, Gesture.Exclusive(pan, tap))}>
          <View style={rowStyles.rowText} accessibilityRole="button">
            <ProjectRow p={p} dirRow={dirRow} withTotal />
          </View>
        </GestureDetector>
        <GestureDetector gesture={gripPan}>
          <View style={styles.grip} accessibilityLabel={t('review.reorder')}>
            {[0, 1, 2].map((r) => (
              <View key={r} style={styles.gripRow}>
                <View style={styles.gripDot} />
                <View style={styles.gripDot} />
              </View>
            ))}
          </View>
        </GestureDetector>
      </Animated.View>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  dragRow: { position: 'absolute', left: 0, right: 0, top: 0 },
  action: { position: 'absolute', top: 0, bottom: 0, overflow: 'hidden', backgroundColor: REMOVE_RED },
  actionPress: { flex: 1, justifyContent: 'center' },
  actionLabel: { width: ACTION_W, alignItems: 'center' },
  actionText: { color: '#FFFFFF', fontSize: 14, fontWeight: '600', fontFamily: fonts.ui },
  grip: { width: 32, height: 44, alignItems: 'center', justifyContent: 'center', gap: 2.5, opacity: 0.6 },
  gripRow: { flexDirection: 'row', gap: 4 },
  gripDot: { width: 3, height: 3, borderRadius: 1.5, backgroundColor: tide.textDim },
});
