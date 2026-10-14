import { useEffect } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import Animated, { useAnimatedStyle, useSharedValue, withSpring } from 'react-native-reanimated';

import { Radius, verb, withAlpha } from '@/constants/theme';

const TRACK_W = 51;
const TRACK_H = 31;
const KNOB = 25;
const INSET = 3;
const TRAVEL = TRACK_W - KNOB - INSET * 2;

/**
 * Tide on/off control, a drop-in for the stock Switch (`value` and
 * `onValueChange`). Off is a plain glass pill. On lights the track with the
 * listen verb gradient and rim. Only transform and opacity animate.
 */
export function TideToggle({
  value,
  onValueChange,
  disabled,
}: {
  value: boolean;
  onValueChange?: (next: boolean) => void;
  disabled?: boolean;
}) {
  const progress = useSharedValue(value ? 1 : 0);
  useEffect(() => {
    progress.value = withSpring(value ? 1 : 0, { damping: 18, stiffness: 220, mass: 0.7 });
  }, [value, progress]);

  const litStyle = useAnimatedStyle(() => ({ opacity: progress.value }));
  const knobStyle = useAnimatedStyle(() => ({ transform: [{ translateX: progress.value * TRAVEL }] }));

  return (
    <Pressable
      accessibilityRole="switch"
      accessibilityState={{ checked: value, disabled: !!disabled }}
      disabled={disabled}
      hitSlop={6}
      onPress={() => onValueChange?.(!value)}
      style={[styles.track, disabled && styles.disabled]}>
      <Animated.View pointerEvents="none" style={[styles.lit, litStyle]}>
        <View style={styles.litSheen} />
      </Animated.View>
      <Animated.View pointerEvents="none" style={[styles.knob, knobStyle]} />
    </Pressable>
  );
}

const styles = StyleSheet.create({
  track: {
    width: TRACK_W,
    height: TRACK_H,
    borderRadius: Radius.pill,
    justifyContent: 'center',
    paddingHorizontal: INSET,
    overflow: 'hidden',
    backgroundColor: 'rgba(255,255,255,0.08)',
    borderWidth: StyleSheet.hairlineWidth * 2,
    borderColor: 'rgba(255,255,255,0.22)',
  },
  disabled: { opacity: 0.45 },
  lit: {
    ...StyleSheet.absoluteFill,
    borderRadius: Radius.pill,
    backgroundColor: verb.listen.c1,
    borderWidth: 1,
    borderColor: verb.listen.lip,
    overflow: 'hidden',
  },
  litSheen: {
    position: 'absolute',
    left: 0,
    right: 0,
    top: 0,
    height: '55%',
    backgroundColor: withAlpha(verb.listen.c2, 0.55),
  },
  knob: {
    width: KNOB,
    height: KNOB,
    borderRadius: Radius.pill,
    backgroundColor: '#F4F2F8',
    shadowColor: '#000',
    shadowOpacity: 0.3,
    shadowRadius: 3,
    shadowOffset: { width: 0, height: 1 },
    elevation: 2,
  },
});
