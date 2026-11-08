import { Canvas, LinearGradient, Rect, vec } from '@shopify/react-native-skia';
import { SymbolView } from 'expo-symbols';
import { useState } from 'react';
import { Platform, Pressable, StyleSheet, Text, useWindowDimensions, View, type ViewStyle } from 'react-native';
import { Gesture, GestureDetector, ScrollView } from 'react-native-gesture-handler';
import Animated, {
  Easing,
  type SharedValue,
  scrollTo,
  useAnimatedReaction,
  useAnimatedRef,
  useAnimatedStyle,
  useReducedMotion,
  useScrollViewOffset,
  useSharedValue,
  withTiming,
} from 'react-native-reanimated';
import { scheduleOnRN } from 'react-native-worklets';

import { CountPill, ProjectRow, ROW_H, rowStyles } from '@/components/review/project-row';
import { SessionLines } from '@/components/tide/session-lines';
import { fonts } from '@/constants/fonts';
import { tide } from '@/constants/theme';
import { prefetchSessionLines, type SessionProject } from '@/lib/api';
import { hapticImpact, hapticSelection } from '@/lib/haptics';
import { useT } from '@/lib/i18n';
import { ltr } from '@/lib/bidi';

const AnimatedScroll = Animated.createAnimatedComponent(ScrollView);

const LIFT_MS = 160;
const SLIDE = { duration: 180, easing: Easing.out(Easing.cubic) };
// The box: 236pt with every island closed, 460pt while one is open (the mock's `ease`, 280ms).
const CAP_CLOSED = 236;
const CAP_OPEN = 460;
const OPEN_MS = 280;
const OPEN_EASE = Easing.inOut(Easing.ease);
const FADE_H = 26;
const FADE_FROM = 'rgba(11,16,24,0.95)';
const FADE_TO = 'rgba(11,16,24,0)';
const AUTO_EDGE = 20;
const AUTO_STEP = 6;
// Swipe to remove: the red action's width, and how far past it a release still opens it.
const ACTION_W = 88;
const REMOVE_RED = '#8A2F3B';
// The row header's opaque ground, so Remove and the lines below never show through it.
const HEAD_BG = '#0E1626';
// The lifted row's shadow: the theme's `0 6 16` at 0.32, in the sky's dark ink rather than pure black.
const LIFT_SHADOW = { shadowColor: '#040C1E', shadowOffset: { width: 0, height: 6 }, shadowRadius: 8 } as const;
const LIFT_OPACITY = 0.32;
const liftHaptic = () => void hapticImpact();
const dropHaptic = () => void hapticSelection();

export type DragProps = {
  items: SessionProject[];
  enabled: boolean;
  dirRow: ViewStyle | undefined;
  rtl: boolean;
  openId: SharedValue<string>;
  keepOpen: () => void;
  onOrder: (ids: string[]) => void;
  /** The count pill: opens the change sheet. */
  onTap: (id: string) => void;
  onRemove: (id: string) => void;
};

/** The open-island state every row reads on the UI thread. `wanted` is the island the learner asked for, `openBody` the one whose body is on screen (they differ for a moment while one closes before the next grows). */
type Box = {
  wanted: SharedValue<string>;
  openBody: SharedValue<string>;
  bodyH: SharedValue<number>;
  capV: SharedValue<number>;
  scrollY: SharedValue<number>;
  scrollRef: ReturnType<typeof useAnimatedRef<Animated.ScrollView>>;
  dur: number;
};

/** The project rows in a scrolling box: tap one to open its lines, tap its count to change it, hold one (350ms) or its grip to lift it and drag it up or down, swipe it toward the leading edge to show Remove. The order lives in `order` on the UI thread until the drop. */
export function DragRows({ items, ...rest }: DragProps) {
  const { width } = useWindowDimensions();
  const order = useSharedValue<string[]>(items.map((p) => p.island_id));
  const active = useSharedValue('');
  const reduce = useReducedMotion();
  const scrollRef = useAnimatedRef<Animated.ScrollView>();
  const scrollY = useScrollViewOffset(scrollRef);
  const wanted = useSharedValue('');
  const openBody = useSharedValue('');
  const bodyH = useSharedValue(0);
  const capV = useSharedValue(CAP_CLOSED);
  const box: Box = { wanted, openBody, bodyH, capV, scrollY, scrollRef, dur: reduce ? 0 : OPEN_MS };
  const n = items.length;
  const boxStyle = useAnimatedStyle(() => ({ height: Math.min(n * ROW_H + bodyH.value, capV.value) + 2 }));
  const listStyle = useAnimatedStyle(() => ({ height: n * ROW_H + bodyH.value }));
  // A fade shows only when there is more to scroll in that direction.
  const topFade = useAnimatedStyle(() => ({ opacity: scrollY.value > 2 ? 1 : 0 }));
  const botFade = useAnimatedStyle(() => {
    const content = n * ROW_H + bodyH.value;
    const max = content - Math.min(content, capV.value);
    return { opacity: max > 2 && scrollY.value < max - 2 ? 1 : 0 };
  });
  return (
    <Animated.View style={[styles.box, boxStyle]}>
      <AnimatedScroll ref={scrollRef} showsVerticalScrollIndicator={false} scrollEventThrottle={16} bounces={false}>
        <Animated.View style={listStyle}>
          {items.map((p, i) => (
            <DragRow key={p.island_id} p={p} slot={i} rows={n} order={order} active={active} canRemove={n > 1} box={box} {...rest} />
          ))}
        </Animated.View>
      </AnimatedScroll>
      <Animated.View pointerEvents="none" style={[styles.fade, { top: 0 }, topFade]}>
        <Canvas style={styles.fadeCanvas}>
          <Rect x={0} y={0} width={width} height={FADE_H}>
            <LinearGradient start={vec(0, 0)} end={vec(0, FADE_H)} colors={[FADE_FROM, FADE_TO]} />
          </Rect>
        </Canvas>
      </Animated.View>
      <Animated.View pointerEvents="none" style={[styles.fade, { bottom: 0 }, botFade]}>
        <Canvas style={styles.fadeCanvas}>
          <Rect x={0} y={0} width={width} height={FADE_H}>
            <LinearGradient start={vec(0, 0)} end={vec(0, FADE_H)} colors={[FADE_TO, FADE_FROM]} />
          </Rect>
        </Canvas>
      </Animated.View>
    </Animated.View>
  );
}

type RowProps = Omit<DragProps, 'items'> & { canRemove: boolean; p: SessionProject; slot: number; rows: number; order: SharedValue<string[]>; active: SharedValue<string>; box: Box };

function DragRow({ p, slot, rows, order, active, enabled, dirRow, rtl, openId, keepOpen, onOrder, onTap, onRemove, canRemove, box }: RowProps) {
  const { t } = useT();
  const id = p.island_id;
  const { wanted, openBody, bodyH, capV, scrollY, scrollRef, dur } = box;
  const maxY = Math.max(0, (rows - 1) * ROW_H);
  // The body mounts on the first open and stays, so its height is measured once and a second open is instant.
  const [mounted, setMounted] = useState(false);
  const natural = useSharedValue(0);
  const chev = useSharedValue(0);
  const scrollFrom = useSharedValue(0);
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
  // The chevron turns 0 to 90 degrees with the island that is asked for.
  useAnimatedReaction(
    () => wanted.value === id,
    (now, prev) => {
      if (now !== prev) chev.value = withTiming(now ? 1 : 0, { duration: dur > 0 ? 250 : 0 });
    },
  );
  const mountBody = () => {
    setMounted(true);
    prefetchSessionLines(id);
  };
  // `order`, `active` and `openId` are shared values from the screen, written on the UI thread; the react-compiler rule reads that as prop mutation.
  /* eslint-disable react-hooks/immutability */
  /** Opens this island's lines (closing the open one first) or closes them. Runs on the UI thread. */
  const toggle = () => {
    'worklet';
    scheduleOnRN(mountBody);
    if (wanted.value === id) {
      wanted.value = '';
      capV.value = withTiming(CAP_CLOSED, { duration: dur, easing: OPEN_EASE });
      bodyH.value = withTiming(0, { duration: dur, easing: OPEN_EASE }, (done) => {
        if (done && wanted.value === '') openBody.value = '';
      });
      return;
    }
    const switching = openBody.value !== '' && openBody.value !== id;
    wanted.value = id;
    capV.value = withTiming(CAP_OPEN, { duration: dur, easing: OPEN_EASE });
    if (!switching) {
      openBody.value = id;
      bodyH.value = withTiming(natural.value, { duration: dur, easing: OPEN_EASE });
      return;
    }
    bodyH.value = withTiming(0, { duration: dur / 2, easing: OPEN_EASE }, (done) => {
      if (!done || wanted.value !== id) return;
      openBody.value = id;
      bodyH.value = withTiming(natural.value, { duration: dur, easing: OPEN_EASE });
    });
  };
  const measured = (h: number) => {
    natural.value = h;
    if (openBody.value === id && wanted.value === id) bodyH.value = withTiming(h, { duration: dur, easing: OPEN_EASE });
  };
  const makePan = (grip: boolean) => {
    const g = Gesture.Pan().enabled(enabled);
    return (grip ? g.minDistance(0) : g.activateAfterLongPress(350))
    .onStart(() => {
      openId.value = '';
      // The open body folds away at once, so the reorder maths stays on ROW_H.
      wanted.value = '';
      openBody.value = '';
      bodyH.value = 0;
      capV.value = CAP_CLOSED;
      scrollFrom.value = scrollY.value;
      active.value = id;
      from.value = top.value;
      lift.value = withTiming(1, { duration: LIFT_MS });
      scheduleOnRN(liftHaptic);
    })
    .onUpdate((e) => {
      if (active.value !== id) return;
      const dy = Number.isFinite(e.translationY) ? e.translationY : 0;
      const y = Math.min(maxY, Math.max(0, from.value + dy + (scrollY.value - scrollFrom.value)));
      top.value = y;
      // Near the box edge the list scrolls under the lifted row.
      const seen = y - scrollY.value;
      if (seen < AUTO_EDGE) scrollTo(scrollRef, 0, Math.max(0, scrollY.value - AUTO_STEP), false);
      else if (seen > capV.value - ROW_H - AUTO_EDGE) scrollTo(scrollRef, 0, scrollY.value + AUTO_STEP, false);
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
      scheduleOnRN(prefetchSessionLines, id);
    })
    .onEnd((_e, ok) => {
      // A tap on a row with Remove showing only closes Remove.
      if (ok && !wasOpen.value) toggle();
    });
  // The chevron toggles too: its own gesture, since one gesture object serves one detector.
  const chevTap = Gesture.Tap()
    .enabled(enabled)
    .onEnd((_e, ok) => {
      if (ok && shift.value < 0.5) toggle();
    });
  const pillTap = Gesture.Tap()
    .enabled(enabled)
    .onEnd((_e, ok) => {
      if (ok) scheduleOnRN(onTap, id);
    });
  const style = useAnimatedStyle(() => {
    const l = Number.isFinite(lift.value) ? lift.value : 0;
    const y = Number.isFinite(top.value) ? top.value : 0;
    // A row below the open island rides down by the body's height.
    const mine = order.value.indexOf(id);
    const openAt = openBody.value ? order.value.indexOf(openBody.value) : -1;
    const extra = openAt >= 0 && mine > openAt ? bodyH.value : 0;
    return { zIndex: active.value === id ? 2 : 1, shadowOpacity: LIFT_OPACITY * l, transform: [{ translateY: y + extra }, { scale: 1 + 0.03 * l }] };
  });
  const bodyStyle = useAnimatedStyle(() => ({ height: openBody.value === id ? bodyH.value : 0 }));
  const chevStyle = useAnimatedStyle(() => ({ transform: [{ rotate: `${chev.value * 90 * (rtl ? -1 : 1)}deg` }] }));
  const rule = useAnimatedStyle(() => ({ opacity: order.value.indexOf(id) > 0 ? 1 : 0 }));
  const slide = useAnimatedStyle(() => {
    const x = Number.isFinite(shift.value) ? shift.value : 0;
    return { transform: [{ translateX: x * lead }] };
  });
  const reveal = useAnimatedStyle(() => {
    const x = Number.isFinite(shift.value) ? shift.value : 0;
    // Only the header's height, and nothing at all while closed: Remove never shows behind an open island.
    return { width: Math.max(0, x), opacity: x > 0 ? 1 : 0 };
  });
  return (
    <Animated.View style={[styles.dragRow, LIFT_SHADOW, style]} onLayout={(e) => {
        rowW.value = e.nativeEvent.layout.width;
      }}>
      <Animated.View pointerEvents="none" style={[styles.rule, rule]} />
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
      <Animated.View style={[rowStyles.row, styles.head, dirRow, slide]}>
        <GestureDetector gesture={Gesture.Race(swipe, Gesture.Exclusive(pan, tap))}>
          <View style={rowStyles.rowText} accessibilityRole="button">
            <ProjectRow p={p} dirRow={dirRow} withTotal lead />
          </View>
        </GestureDetector>
        <GestureDetector gesture={pillTap}>
          <View accessibilityRole="button">
            <CountPill p={p} />
          </View>
        </GestureDetector>
        <GestureDetector gesture={chevTap}>
          <Animated.View style={[styles.chev, chevStyle]}>
            {Platform.OS === 'web' ? (
              <Text style={styles.chevWeb}>{ltr(rtl ? '‹' : '›')}</Text>
            ) : (
              <SymbolView name={rtl ? { ios: 'chevron.left', android: 'chevron_left' } : { ios: 'chevron.right', android: 'chevron_right' }} size={16} weight="semibold" tintColor={tide.textDim} />
            )}
          </Animated.View>
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
      {mounted ? (
        <Animated.View style={[styles.bodyClip, bodyStyle]}>
          {/* eslint-disable-next-line react-hooks/immutability */}
          <View style={styles.bodyInner} onLayout={(e) => measured(e.nativeEvent.layout.height)}>
            <SessionLines islandId={id} picked={p.picked} />
          </View>
        </Animated.View>
      ) : null}
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  box: { borderRadius: 18, borderWidth: 1, borderColor: 'rgba(255,255,255,0.10)', backgroundColor: 'rgba(255,255,255,0.04)', overflow: 'hidden' },
  fade: { position: 'absolute', left: 0, right: 0, height: FADE_H },
  fadeCanvas: { flex: 1 },
  rule: { position: 'absolute', top: 0, left: 0, right: 0, height: 1, backgroundColor: 'rgba(255,255,255,0.06)' },
  head: { paddingHorizontal: 10, backgroundColor: HEAD_BG },
  chev: { width: 18, height: 18, alignItems: 'center', justifyContent: 'center' },
  chevWeb: { fontSize: 20, lineHeight: 20, color: tide.textDim, fontFamily: fonts.ui },
  bodyClip: { overflow: 'hidden' },
  bodyInner: { position: 'absolute', top: 0, left: 0, right: 0 },
  dragRow: { position: 'absolute', left: 0, right: 0, top: 0 },
  action: { position: 'absolute', top: 0, height: ROW_H, overflow: 'hidden', backgroundColor: REMOVE_RED },
  actionPress: { flex: 1, justifyContent: 'center' },
  actionLabel: { width: ACTION_W, alignItems: 'center' },
  actionText: { color: '#FFFFFF', fontSize: 14, fontWeight: '600', fontFamily: fonts.ui },
  grip: { width: 32, height: 44, alignItems: 'center', justifyContent: 'center', gap: 2.5, opacity: 0.6 },
  gripRow: { flexDirection: 'row', gap: 4 },
  gripDot: { width: 3, height: 3, borderRadius: 1.5, backgroundColor: tide.textDim },
});
