import type { BottomTabBarProps } from 'expo-router/tabs';
import { StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { PressScale } from '@/components/press-scale';
import { fonts } from '@/constants/fonts';
import { Radius, Spacing, tide } from '@/constants/theme';

/**
 * Floating pill tab bar for the Home / Settings group, styled with Tide
 * colours to match the island player's own pill controls.
 */
export function PillTabBar({ state, descriptors, navigation }: BottomTabBarProps) {
  const insets = useSafeAreaInsets();

  return (
    <View
      pointerEvents="box-none"
      style={[styles.wrap, { bottom: insets.bottom + Spacing.sm }]}>
      <View style={styles.bar}>
        {state.routes.map((route, index) => {
          const options = descriptors[route.key]?.options;
          const label = options?.title ?? route.name;
          const on = state.index === index;
          return (
            <PressScale
              key={route.key}
              onPress={() => navigation.navigate(route.name)}
              style={[styles.pill, { backgroundColor: on ? tide.lang.ja : 'transparent' }]}>
              <Text style={[styles.pillText, { color: on ? tide.sky[0] : tide.text }]}>{label}</Text>
            </PressScale>
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
    flexDirection: 'row',
    gap: Spacing.xs,
    borderWidth: 1,
    borderColor: tide.waterline,
    backgroundColor: tide.water,
    borderRadius: Radius.pill,
    padding: Spacing.xs,
  },
  pill: {
    borderRadius: Radius.pill,
    paddingVertical: Spacing.xs + 2,
    paddingHorizontal: Spacing.md,
  },
  pillText: { fontSize: 13, fontWeight: '700', fontFamily: fonts.ui },
});
