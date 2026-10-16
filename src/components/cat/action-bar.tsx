import { useEffect, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import Animated, { cancelAnimation, useAnimatedStyle, useReducedMotion, useSharedValue, withTiming } from 'react-native-reanimated';

import { PrismButton } from '@/components/prism';
import { fonts } from '@/constants/fonts';
import { tide, verb } from '@/constants/theme';

export const ACTION_H = 54;

/** The wardrobe page colour, used as the navy top of the pill. */
const NAVY = '#0B1020';
/** Gold rising from the bottom edge: alpha 0 at the top to 0.22 at the bottom. RGB matches verb.read.c1. */
const FACE_FILL = {
  backgroundColor: NAVY,
  experimental_backgroundImage: 'linear-gradient(180deg, rgba(255,200,87,0) 0%, rgba(255,200,87,0.22) 100%)',
};
const TEXT = verb.read.c2;

export type ActionBarProps = {
  /** null hides the bar; the space stays reserved so the grid never jumps. */
  label: string | null;
  /** Shows a coin capsule on the right. Only set on Buy. */
  price?: number;
  disabled?: boolean;
  /** A request is in flight: the pill stays but cannot be pressed again. */
  busy?: boolean;
  onPress?: () => void;
};

/**
 * One pill for the selected item: Buy, Equip, or why it cannot be had yet.
 * Shows and hides with translateY 6px plus opacity only (160ms in, 120ms out).
 * `disabled` (locked or unaffordable) drops the gold and mutes the text.
 */
export function ActionBar({ label, price, disabled, busy, onPress }: ActionBarProps) {
  const reduced = useReducedMotion();
  const [shown, setShown] = useState(label);
  const [shownPrice, setShownPrice] = useState(price);
  const t = useSharedValue(label ? 1 : 0);
  useEffect(() => {
    cancelAnimation(t);
    if (label) {
      setShown(label);
      t.value = reduced ? 1 : withTiming(1, { duration: 160 });
    } else {
      t.value = reduced ? 0 : withTiming(0, { duration: 120 });
    }
  }, [label, reduced, t]);
  // Kept apart from the fade effect so a price change never restarts the fade.
  // The price stays while the bar fades out, so the capsule does not vanish early.
  useEffect(() => {
    if (label) setShownPrice(price);
  }, [label, price]);
  const style = useAnimatedStyle(() => ({ opacity: t.value, transform: [{ translateY: (1 - t.value) * 6 }] }));
  return (
    <Animated.View pointerEvents={label ? 'auto' : 'none'} style={[styles.wrap, style]}>
      {shown ? (
        <PrismButton
          shape="pill"
          verb="read"
          height={ACTION_H}
          disabled={disabled || busy || !label}
          onPress={onPress}
          accessibilityLabel={shown}
          style={[{ borderRadius: 999 }, disabled ? { backgroundColor: NAVY } : FACE_FILL]}>
          <View style={styles.row}>
            <Text style={[styles.label, { color: disabled ? tide.textDim : TEXT }]}>{shown}</Text>
            {shownPrice !== undefined ? (
              <View style={styles.capsule}>
                <View style={styles.coin} />
                <Text style={styles.capsuleText}>{shownPrice}</Text>
              </View>
            ) : null}
          </View>
        </PrismButton>
      ) : null}
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  wrap: { alignItems: 'center', height: ACTION_H },
  row: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  label: { fontFamily: fonts.ui, fontWeight: '600', fontSize: 13 },
  capsule: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: 999,
    backgroundColor: 'rgba(255,200,87,0.12)',
  },
  coin: { width: 8, height: 8, borderRadius: 4, backgroundColor: verb.read.c1 },
  capsuleText: { fontFamily: fonts.ui, fontWeight: '600', fontSize: 13, color: TEXT },
});
