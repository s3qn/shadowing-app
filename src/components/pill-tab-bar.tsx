import type { BottomTabBarProps } from 'expo-router/tabs';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import * as Haptics from 'expo-haptics';
import Animated, { useAnimatedStyle, useReducedMotion, useSharedValue, withSpring } from 'react-native-reanimated';
import Svg, { Circle, Path } from 'react-native-svg';

import { hapticImpact } from '@/lib/haptics';
import { fonts } from '@/constants/fonts';
import { Radius, Spacing, tide } from '@/constants/theme';

const AnimatedView = Animated.createAnimatedComponent(View);

// Matches the 24-viewbox, round-cap stroke style of src/components/tide/toolbar-icons.tsx.
const STROKE = 1.8;
const ICON_SIZE = 18;
const BAR_BORDER = 1;
const BAR_PAD = Spacing.xs;
const PILL_PAD_V = Spacing.xs + 2;
/** Space between the bar and the bottom safe-area edge. */
const BAR_GAP = Spacing.sm;
/**
 * How far the floating bar reaches up from the bottom safe-area edge: its gap
 * plus its height. The pill row is as tall as the icon, the 13pt label is
 * shorter. A screen that pads its bottom by the safe-area inset loses this
 * much of its own height under the bar.
 */
export const PILL_TAB_BAR_REACH = BAR_GAP + 2 * (BAR_BORDER + BAR_PAD + PILL_PAD_V) + ICON_SIZE;
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
  settings: SettingsIcon,
};

/**
 * Floating pill tab bar for the Home / Settings group, styled with Tide
 * colours to match the island player's own pill controls.
 */
export function PillTabBar({ state, descriptors, navigation }: BottomTabBarProps) {
  const insets = useSafeAreaInsets();
  const reducedMotion = useReducedMotion();

  const [tabLayouts, setTabLayouts] = useState<Array<{ x: number; width: number }>>([]);
  const pillTranslateX = useSharedValue(0);
  const pillWidth = useSharedValue(0);
  const layoutsRef = useRef<Array<{ x: number; width: number }>>([]);

  const handleTabLayout = useCallback((index: number, x: number, width: number) => {
    layoutsRef.current[index] = { x, width };

    // Only set state once all layouts are collected to avoid excessive re-renders
    if (layoutsRef.current.filter(l => l).length === state.routes.length) {
      setTabLayouts([...layoutsRef.current]);
    }
  }, [state.routes.length]);

  // Slide the pill when the active tab or the measured layouts change. The
  // first placement is instant so the pill does not fly in from x = 0.
  const placed = useRef(false);
  const activeTab = tabLayouts[state.index];
  useEffect(() => {
    if (!activeTab) return;
    if (reducedMotion || !placed.current) {
      pillTranslateX.value = activeTab.x;
      pillWidth.value = activeTab.width;
      placed.current = true;
      return;
    }
    const spring = { damping: 18, overshootClamping: true };
    pillTranslateX.value = withSpring(activeTab.x, spring);
    pillWidth.value = withSpring(activeTab.width, spring);
  }, [activeTab, reducedMotion, pillTranslateX, pillWidth]);

  const pillAnimatedStyle = useAnimatedStyle(() => ({
    transform: [{ translateX: pillTranslateX.value }],
    width: pillWidth.value,
  }));

  return (
    <View
      pointerEvents="box-none"
      style={[styles.wrap, { bottom: insets.bottom + BAR_GAP }]}>
      <View style={styles.bar}>
        <AnimatedView style={[styles.slidingPill, pillAnimatedStyle]} />
        {state.routes.map((route, index) => {
          const options = descriptors[route.key]?.options;
          const label = options?.title ?? route.name;
          const on = state.index === index;
          const Icon = TAB_ICON[route.name];
          return (
            <Pressable
              key={route.key}
              onPress={() => {
                void hapticImpact(Haptics.ImpactFeedbackStyle.Medium);
                navigation.navigate(route.name);
              }}
              onLayout={(e) => {
                const { x, width } = e.nativeEvent.layout;
                handleTabLayout(index, x, width);
              }}
              style={styles.pill}>
              {Icon ? <Icon color={on ? tide.sky[0] : tide.textDim} /> : null}
              <Text style={[styles.pillText, { color: on ? tide.sky[0] : tide.text }]}>{label}</Text>
            </Pressable>
          );
        })}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: {
    position: 'absolute',
    left: 0,
    right: 0,
    alignItems: 'center',
  },
  bar: {
    position: 'relative',
    flexDirection: 'row',
    gap: Spacing.xs,
    borderWidth: BAR_BORDER,
    borderColor: tide.waterline,
    backgroundColor: tide.water,
    borderRadius: Radius.pill,
    padding: BAR_PAD,
  },
  slidingPill: {
    position: 'absolute',
    backgroundColor: tide.lang.ja,
    borderRadius: Radius.pill,
    top: BAR_PAD,
    bottom: BAR_PAD,
  },
  pill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.xs,
    borderRadius: Radius.pill,
    paddingVertical: PILL_PAD_V,
    paddingHorizontal: Spacing.md,
  },
  pillText: { fontSize: 13, fontWeight: '700', fontFamily: fonts.ui },
});
