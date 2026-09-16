import { useState } from 'react';
import { StyleSheet, View } from 'react-native';
import Animated, { interpolate, useAnimatedStyle, type SharedValue } from 'react-native-reanimated';

import { tide } from '@/constants/theme';
import type { LineTier } from '@/lib/takes';

// A shadowing island this long does not exist; the cap just keeps the row
// from stretching off the card if one somehow does.
const MAX_LANTERNS = 24;
const NEUTRAL_OPACITY = 0.18;
const EMPTY_CACHE: { tiers: LineTier[]; weakest: number } = { tiers: [], weakest: -1 };
const TIER_COLOR: Record<LineTier, string> = {
  none: '#7E7892',
  retry: '#5C4A8A',
  good: tide.turn,
  great: tide.pos.verb,
};

/** Delay between one lantern lighting and the next. */
export const LANTERN_STEP_MS = 110;
/** How long a single lantern takes to rise from unlit to lit. */
export const LANTERN_RISE_MS = 500;
/** How long a card's lanterns take to fade to dark together once it stops
 * being the lit card. */
export const LANTERN_FADE_MS = 120;

export type LanternRowProps = {
  /** Lines on this island, capped at MAX_LANTERNS for the row. */
  count: number;
  /** Tier per line, or `null` while this card is not the lit one (drawn as
   * neutral, since `power` is 0 for a card that has never lit). */
  tiers: LineTier[] | null;
  /** While `tiers` is null, keep drawing the last known colours: true while
   * the fade to dark runs, false once the card is dark and settled. */
  holdColours: boolean;
  /** Index of the weakest line, lit in coral instead of its own tier
   * colour, or `-1` for none. */
  weakest: number;
  /** Elapsed ms since this card started lighting, driving the light
   * sequence. Owned by the parent row so a new scroll can cancel it. */
  litMs: SharedValue<number>;
  /** Multiplier on the weakest lantern's opacity and glow: 1 outside a
   * flicker, dipping toward 0.35 during one. */
  flick: SharedValue<number>;
  /** 1 when this card is the lit one, 0 when dark. Losing the light fades
   * this from 1 to 0 over LANTERN_FADE_MS. */
  power: SharedValue<number>;
};

/** One card's row of paper lanterns, one per line, lighting in sequence. */
export function LanternRow({ count, tiers, holdColours, weakest, litMs, flick, power }: LanternRowProps) {
  const shown = Math.min(count, MAX_LANTERNS);
  const gap = shown > 14 ? 4 : 9;
  // A card losing the light gets tiers=null on the same render its fade
  // starts, but the fade still has to take the real colours down, not
  // flash to neutral first. Cache the last known tiers for that fade.
  // Once the fade has finished, drop them so the card reads neutral again.
  const [cache, setCache] = useState<{ tiers: LineTier[]; weakest: number }>(EMPTY_CACHE);
  if (tiers && (tiers !== cache.tiers || weakest !== cache.weakest)) setCache({ tiers, weakest });
  else if (!tiers && !holdColours && cache !== EMPTY_CACHE) setCache(EMPTY_CACHE);
  const shownTiers = tiers ?? (holdColours ? cache.tiers : EMPTY_CACHE.tiers);
  const shownWeakest = tiers ? weakest : holdColours ? cache.weakest : -1;

  return (
    <View style={[styles.row, { gap }]}>
      {Array.from({ length: shown }, (_, i) => {
        const tier = shownTiers[i] ?? 'none';
        const isWeakest = i === shownWeakest;
        const color = isWeakest ? tide.lang.ja : TIER_COLOR[tier];
        return (
          <Lantern key={i} index={i} color={color} isWeakest={isWeakest} litMs={litMs} flick={flick} power={power} />
        );
      })}
    </View>
  );
}

function Lantern({
  index,
  color,
  isWeakest,
  litMs,
  flick,
  power,
}: {
  index: number;
  color: string;
  isWeakest: boolean;
  litMs: SharedValue<number>;
  flick: SharedValue<number>;
  power: SharedValue<number>;
}) {
  const style = useAnimatedStyle(() => {
    const p = Math.min(1, Math.max(0, (litMs.value - index * LANTERN_STEP_MS) / LANTERN_RISE_MS));
    const e = 1 - (1 - p) * (1 - p);
    let litOpacity = interpolate(e, [0, 0.5, 1], [NEUTRAL_OPACITY, 1, 1]);
    let litShadowOpacity = interpolate(e, [0, 0.5, 1], [0, 1, 0.7]);
    const shadowRadius = interpolate(e, [0, 0.5, 1], [0, 16, 9]);
    if (isWeakest) {
      litOpacity *= flick.value;
      litShadowOpacity *= flick.value;
    }
    const pw = power.value;
    return {
      opacity: NEUTRAL_OPACITY + (litOpacity - NEUTRAL_OPACITY) * pw,
      shadowOpacity: litShadowOpacity * pw,
      shadowRadius,
    };
  });
  return (
    <View style={styles.wrapper}>
      <Animated.View style={[styles.body, { backgroundColor: color, shadowColor: color }, style]}>
        <View style={styles.cap} />
      </Animated.View>
    </View>
  );
}

const styles = StyleSheet.create({
  // 24 tall so a two-line title, the meta line and this row fit the 128px card.
  row: { flexDirection: 'row', alignItems: 'center', height: 24 },
  // Sized to fit the body plus the cap's 3px stem above it, so the cap is
  // never clipped and every lantern still reserves the same row height.
  wrapper: { width: 11, height: 18 },
  body: {
    width: 11,
    height: 15,
    marginTop: 3,
    borderTopLeftRadius: 4,
    borderTopRightRadius: 4,
    borderBottomLeftRadius: 5,
    borderBottomRightRadius: 5,
    shadowOffset: { width: 0, height: 0 },
  },
  cap: {
    position: 'absolute',
    top: -3,
    left: 3,
    width: 5,
    height: 2,
    borderRadius: 1,
    backgroundColor: 'rgba(236,232,244,0.45)',
  },
});
