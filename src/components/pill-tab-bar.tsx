import type { BottomTabBarProps } from 'expo-router/tabs';
import { useCallback, useEffect, useRef, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import * as Haptics from 'expo-haptics';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import Animated, {
  runOnJS,
  type SharedValue,
  useAnimatedReaction,
  useAnimatedStyle,
  useSharedValue,
  withSpring,
  withTiming,
} from 'react-native-reanimated';
import Svg, { Circle, Path } from 'react-native-svg';

import { hapticImpact, hapticSelection } from '@/lib/haptics';
import { useDir } from '@/lib/i18n';
import { fonts } from '@/constants/fonts';
import { Radius, Spacing, prism } from '@/constants/theme';
import {
  PILL_H,
  PILL_ICON_OFF,
  PILL_ICON_ON,
  PILL_ICON_SIZE,
  PILL_LABEL_SIZE,
  PILL_PAD_X,
  PILL_SPRING,
  PillTrayShell,
  SlidingLitPill,
  useSlidingPill,
} from '@/components/prism/pill-tray';

const AnimatedView = Animated.createAnimatedComponent(View);

// Matches the 24-viewbox, round-cap stroke style of src/components/tide/toolbar-icons.tsx.
const STROKE = 1.8;
const ICON_SIZE = PILL_ICON_SIZE;
/** Space between the bar and the bottom safe-area edge. */
const BAR_GAP = Spacing.sm;
/**
 * How far the floating bar reaches up from the bottom safe-area edge: its gap
 * plus its height. A screen that pads its bottom by the safe-area inset loses
 * this much of its own height under the bar.
 */
export const PILL_TAB_BAR_REACH = BAR_GAP + 2 * prism.tray.pad + PILL_H;
type TabIconProps = { color: string; size?: number };

function IslandsIcon({ color, size = ICON_SIZE }: TabIconProps) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none">
      <Path d="M7 15c1.2-4.5 3-7 5-7s3.8 2.5 5 7" stroke={color} strokeWidth={STROKE} strokeLinecap="round" strokeLinejoin="round" />
      <Circle cx={12} cy={8.5} r={1.1} fill={color} />
      <Path
        d="M2.5 16c1.4-1.3 2.8-1.3 4.2 0s2.8 1.3 4.2 0 2.8-1.3 4.2 0 2.8 1.3 4.2 0 2.8-1.3 4.2 0"
        stroke={color}
        strokeWidth={STROKE}
        strokeLinecap="round"
      />
    </Svg>
  );
}

// Antenna glyph for the Podcast tab, matched to this app's stroke width.
function PodcastIcon({ color, size = ICON_SIZE }: TabIconProps) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none">
      <Path d="M12 12v9" stroke={color} strokeWidth={STROKE} strokeLinecap="round" />
      <Circle cx={12} cy={9} r={2.6} stroke={color} strokeWidth={STROKE} strokeLinecap="round" strokeLinejoin="round" />
      <Path d="M7.5 5.5C5 8 5 12 7.5 14.5" stroke={color} strokeWidth={STROKE} strokeLinecap="round" />
      <Path d="M16.5 5.5C19 8 19 12 16.5 14.5" stroke={color} strokeWidth={STROKE} strokeLinecap="round" />
    </Svg>
  );
}

// Lucide's "settings" gear glyph, matched to this app's stroke width.
function SettingsIcon({ color, size = ICON_SIZE }: TabIconProps) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none">
      <Circle cx={12} cy={12} r={3} stroke={color} strokeWidth={STROKE} strokeLinecap="round" strokeLinejoin="round" />
      <Path
        d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1Z"
        stroke={color}
        strokeWidth={STROKE}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </Svg>
  );
}

const TAB_ICON: Record<string, (props: TabIconProps) => React.ReactElement> = {
  index: IslandsIcon,
  podcast: PodcastIcon,
  settings: SettingsIcon,
};

/** Which tab's `[x, x + width)` band contains `x`, or null if none (an empty layouts array, or a point past the last tab). Runs on the UI thread. */
function hitTestIndex(x: number, tabs: Array<{ x: number; width: number }>): number | null {
  'worklet';
  for (let i = 0; i < tabs.length; i++) {
    const tab = tabs[i];
    if (x >= tab.x && x < tab.x + tab.width) return i;
  }
  return null;
}

/**
 * Floating pill tab bar for the Home / Settings group, styled with the
 * Prism kit's pill tray look: one glass capsule with a sliding lit pill.
 */
export function PillTabBar({ state, descriptors, navigation }: BottomTabBarProps) {
  const insets = useSafeAreaInsets();
  const { rtl } = useDir();

  const [tabLayouts, setTabLayouts] = useState<Array<{ x: number; width: number }>>([]);
  // The widest tab measured so far, which the lit fill's canvas is drawn at.
  // It only grows: the sliding pill clips the canvas down, so a canvas wider
  // than the tab under it costs nothing, while one narrower than that tab
  // leaves a dark crescent at one end. Labels that shrink (an app language
  // switch) therefore cannot leave it short.
  const [fillWidth, setFillWidth] = useState(0);
  const [hoveredIndex, setHoveredIndex] = useState<number | null>(null);
  const layoutsRef = useRef<Array<{ x: number; width: number }>>([]);

  // Scrub gesture state, all UI-thread only. `layouts` and `barWidth` mirror
  // React state/measurements so the gesture worklets can read them without
  // crossing threads. `bubbleWidth` is the held tab's width, snapshotted at
  // the start of a drag and held fixed for its whole duration (see the
  // "Design" note on LitPillFill's Skia canvas). `held` drives the grow and
  // rim-brighten look. `lastHoverIndex` is the drag's own copy of which tab
  // it is over, used to detect a boundary crossing and to commit on release.
  const layouts = useSharedValue<Array<{ x: number; width: number }>>([]);
  const barWidth = useSharedValue(0);
  const bubbleWidth = useSharedValue(0);
  const held = useSharedValue(0);
  const lastHoverIndex = useSharedValue(-1);
  const pressedIndex = useSharedValue(-1);

  const handleTabLayout = useCallback((index: number, x: number, width: number) => {
    layoutsRef.current[index] = { x, width };
    setFillWidth((widest) => Math.max(widest, width));

    // Only set state once all layouts are collected to avoid excessive re-renders
    if (layoutsRef.current.filter(l => l).length === state.routes.length) {
      setTabLayouts([...layoutsRef.current]);
    }
  }, [state.routes.length]);

  const handleBarLayout = useCallback((e: import('react-native').LayoutChangeEvent) => {
    barWidth.value = e.nativeEvent.layout.width;
  }, [barWidth]);

  useEffect(() => {
    layouts.value = tabLayouts;
  }, [tabLayouts, layouts]);

  // Slides when the active tab or the measured layouts change, including right
  // after a scrub commits a tab switch (that changes `state.index` like a tap).
  const { translateX: pillTranslateX, width: pillWidth } = useSlidingPill(tabLayouts[state.index]);

  // Fires a tab switch: same haptic and navigate call for a tap and for a
  // committed scrub. Also clears a scrub's hover highlight, since it drove
  // `hoveredIndex` and the newly active tab now lights itself via `on`.
  const commit = useCallback((index: number) => {
    const route = state.routes[index];
    if (!route) return;
    setHoveredIndex(null);
    void hapticImpact(Haptics.ImpactFeedbackStyle.Medium);
    navigation.navigate(route.name);
  }, [navigation, state.routes]);

  // Fires on each tab boundary a scrub's finger crosses.
  const onCross = useCallback((index: number) => {
    void hapticSelection();
    setHoveredIndex(index);
  }, []);

  const clearHover = useCallback(() => setHoveredIndex(null), []);

  const dragGesture = Gesture.Pan()
    .activateAfterLongPress(250)
    .onStart((e) => {
      if (layouts.value.length === 0 || barWidth.value === 0) return;
      const startIndex = hitTestIndex(e.x, layouts.value);
      if (startIndex === null) return;
      const tab = layouts.value[startIndex];
      bubbleWidth.value = tab.width;
      pillWidth.value = tab.width;
      pillTranslateX.value = tab.x;
      lastHoverIndex.value = startIndex;
      held.value = withTiming(1, { duration: 180 });
      if (startIndex !== state.index) runOnJS(onCross)(startIndex);
    })
    .onUpdate((e) => {
      if (layouts.value.length === 0 || barWidth.value === 0 || bubbleWidth.value === 0) return;
      const clampedX = Math.min(Math.max(e.x, 0), barWidth.value);
      pillTranslateX.value = clampedX - bubbleWidth.value / 2;
      const index = hitTestIndex(clampedX, layouts.value);
      if (index !== null && index !== lastHoverIndex.value) {
        lastHoverIndex.value = index;
        runOnJS(onCross)(index);
      }
    })
    .onEnd(() => {
      if (lastHoverIndex.value === -1) return;
      runOnJS(commit)(lastHoverIndex.value);
    })
    .onFinalize((_e, success) => {
      // held always fades back out, on both a clean release and a cancel.
      held.value = withTiming(0, { duration: 180 });
      // Always settle the pill on a tab. After a drag it sits wherever the
      // finger left it, and a release on the already active tab changes no
      // state, so the state.index effect never runs to move it back.
      const released = success && lastHoverIndex.value >= 0 ? lastHoverIndex.value : state.index;
      const tab = layouts.value[released];
      if (tab) {
        pillTranslateX.value = withSpring(tab.x, PILL_SPRING);
        pillWidth.value = withSpring(tab.width, PILL_SPRING);
      }
      lastHoverIndex.value = -1;
      bubbleWidth.value = 0;
      if (!success) runOnJS(clearHover)();
    });

  const tapGesture = Gesture.Tap()
    .onBegin((e) => {
      if (layouts.value.length === 0 || barWidth.value === 0) {
        pressedIndex.value = -1;
        return;
      }
      const index = hitTestIndex(e.x, layouts.value);
      pressedIndex.value = index === null ? -1 : index;
    })
    .onFinalize(() => {
      pressedIndex.value = -1;
    })
    .onEnd((e) => {
      if (layouts.value.length === 0 || barWidth.value === 0) return;
      const index = hitTestIndex(e.x, layouts.value);
      if (index === null) return;
      runOnJS(commit)(index);
    });

  const rowGesture = Gesture.Exclusive(dragGesture, tapGesture);
  const litIndex = hoveredIndex ?? state.index;

  return (
    <View
      pointerEvents="box-none"
      style={[styles.wrap, { bottom: insets.bottom + BAR_GAP }]}>
      <PillTrayShell style={styles.bar}>
        <GestureDetector gesture={rowGesture}>
          <View style={styles.barRow} onLayout={handleBarLayout}>
            <SlidingLitPill translateX={pillTranslateX} width={pillWidth} fillWidth={fillWidth} held={held} />
            {(rtl ? [...state.routes].reverse() : state.routes).map((route) => {
              const index = state.routes.indexOf(route);
              const options = descriptors[route.key]?.options;
              const label = options?.title ?? route.name;
              const on = litIndex === index;
              const Icon = TAB_ICON[route.name];
              return (
                <TabPill
                  key={route.key}
                  on={on}
                  index={index}
                  pressedIndex={pressedIndex}
                  onLayout={(e) => {
                    const { x, width } = e.nativeEvent.layout;
                    handleTabLayout(index, x, width);
                  }}>
                  {Icon ? <Icon color={on ? PILL_ICON_ON : PILL_ICON_OFF} /> : null}
                  <Text style={[styles.pillText, { color: on ? prism.tray.lit.label : PILL_ICON_OFF }]}>{label}</Text>
                </TabPill>
              );
            })}
          </View>
        </GestureDetector>
      </PillTrayShell>
    </View>
  );
}

type TabPillProps = {
  children: React.ReactNode;
  on: boolean;
  index: number;
  pressedIndex: SharedValue<number>;
  onLayout: (e: import('react-native').LayoutChangeEvent) => void;
};

/**
 * One tab's pill: a plain 0.96 press scale. The selected tab shows only the
 * sliding lit fill underneath; an unselected tab draws its own faint chip
 * background and rim so it still reads as a pill. The tap/scrub gesture on
 * the row (see `PillTabBar`) drives the press scale by writing this tab's
 * own index into `pressedIndex`, instead of this component's own
 * `Pressable`, since one `GestureDetector` now covers the whole row.
 */
function TabPill({ children, on, index, pressedIndex, onLayout }: TabPillProps) {
  const scale = useSharedValue(1);
  useAnimatedReaction(
    () => pressedIndex.value === index,
    (isPressed, wasPressed) => {
      if (isPressed === wasPressed) return;
      scale.value = isPressed ? withTiming(0.96, { duration: 80 }) : withSpring(1, prism.press.spring);
    },
  );
  const scaleStyle = useAnimatedStyle(() => ({ transform: [{ scale: scale.value }] }));
  return (
    <AnimatedView onLayout={onLayout} style={[styles.pill, on ? null : styles.pillChrome, scaleStyle]}>
      {children}
    </AnimatedView>
  );
}

const styles = StyleSheet.create({
  wrap: {
    position: 'absolute',
    left: 0,
    right: 0,
    alignItems: 'center',
  },
  bar: { gap: Spacing.xs },
  // The GestureDetector's own row, so its onLayout and its e.x are in the
  // same coordinate space as each TabPill's onLayout (both measured from
  // this view, not from the padded capsule one level up). It carries the
  // gap that used to sit on `bar` itself, since a flex gap only spaces
  // in-flow children and `bar` now wraps a single child (this row).
  barRow: { flexDirection: 'row', gap: Spacing.xs },
  pill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.xs,
    height: PILL_H,
    paddingHorizontal: PILL_PAD_X,
    borderRadius: Radius.pill,
  },
  pillChrome: {
    backgroundColor: prism.tray.pillFill,
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.05)',
  },
  pillText: { fontSize: PILL_LABEL_SIZE, fontWeight: '600', fontFamily: fonts.ui },
});
