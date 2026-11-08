/** Streak tiers and the ember glow shared by the gem, the celebration and the profile. */

import { View } from 'react-native';
import { Canvas, Circle, RadialGradient, vec } from '@shopify/react-native-skia';

import { MILESTONE_DAYS } from '@/lib/level-up-store';

/** First day of each streak tier: the gem's look changes for good once a streak reaches it. */
const TIER_FLOORS = [1, ...MILESTONE_DAYS];
/** The gem tier for a streak: 0 with no streak, 1 from day 1, up to 10 from day 1000. */
export function streakTier(days: number): number {
  return TIER_FLOORS.filter((floor) => days >= floor).length;
}
export const EMBER = '#FFB36B';

/** A radial ember fade: the mocks' blurred glow disc, drawn in Skia. */
export function EmberGlow({ size, colors, positions }: { size: number; colors: string[]; positions: number[] }) {
  const r = size / 2;
  return (
    <View pointerEvents="none" style={{ position: 'absolute', width: size, height: size }}>
      <Canvas style={{ width: size, height: size }}>
        <Circle cx={r} cy={r} r={r}>
          <RadialGradient c={vec(r, r)} r={r} colors={colors} positions={positions} />
        </Circle>
      </Canvas>
    </View>
  );
}
