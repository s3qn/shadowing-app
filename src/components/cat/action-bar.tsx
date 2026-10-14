import { useEffect, useState } from 'react';
import { StyleSheet } from 'react-native';
import Animated, { cancelAnimation, useAnimatedStyle, useReducedMotion, useSharedValue, withTiming } from 'react-native-reanimated';

import { PrismButton } from '@/components/prism';

export const ACTION_H = 54;

export type ActionBarProps = {
  /** null hides the bar; the space stays reserved so the grid never jumps. */
  label: string | null;
  disabled?: boolean;
  /** A request is in flight: the pill stays but cannot be pressed again. */
  busy?: boolean;
  onPress?: () => void;
};

/**
 * One pill for the selected item: Buy, Claim, or why it cannot be had yet.
 * Shows and hides with translateY 6px plus opacity only (160ms in, 120ms out).
 */
export function ActionBar({ label, disabled, busy, onPress }: ActionBarProps) {
  const reduced = useReducedMotion();
  const [shown, setShown] = useState(label);
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
  const style = useAnimatedStyle(() => ({ opacity: t.value, transform: [{ translateY: (1 - t.value) * 6 }] }));
  return (
    <Animated.View pointerEvents={label ? 'auto' : 'none'} style={[styles.wrap, style]}>
      {shown ? (
        <PrismButton shape="pill" verb="read" height={ACTION_H} label={shown} disabled={disabled || busy || !label} onPress={onPress} accessibilityLabel={shown} />
      ) : null}
    </Animated.View>
  );
}

const styles = StyleSheet.create({ wrap: { alignItems: 'center', height: ACTION_H } });
