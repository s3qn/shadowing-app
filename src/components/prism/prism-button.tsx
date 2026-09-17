import { useEffect, useState } from 'react';
import { type AccessibilityRole, type LayoutChangeEvent, Pressable, type StyleProp, StyleSheet, View, type ViewStyle } from 'react-native';
import Animated, {
  Easing,
  type SharedValue,
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
  withDelay,
  withSpring,
  withTiming,
} from 'react-native-reanimated';

import { PrismFace, prismFaceSize, type PrismFaceProps } from '@/components/prism/prism-face';
import { prism, verb as verbTokens } from '@/constants/theme';
import { hapticImpact } from '@/lib/haptics';

export type PrismButtonProps = Omit<PrismFaceProps, 'onT'> & {
  /** Whether the button is in its "on" state: stronger fringe, glow and sheen. */
  on?: boolean;
  onPress?: () => void;
  onLongPress?: () => void;
  disabled?: boolean;
  /** Fires a light haptic on press-in. Defaults to true. */
  haptic?: boolean;
  accessibilityLabel?: string;
  accessibilityRole?: AccessibilityRole;
  accessibilityState?: Record<string, unknown>;
  onLayout?: (e: LayoutChangeEvent) => void;
  testID?: string;
  /** Style for the outer Pressable (margins, alignment, flex). `style` goes to the face. */
  containerStyle?: StyleProp<ViewStyle>;
};

function clampSink(height: number): number {
  return Math.min(Math.max(Math.round(height / 10), prism.press.sinkMin), prism.press.sinkMax);
}

type RingProps = { ring: SharedValue<number>; width: number; height: number; radius: number; colour: string; top: number };

/** One of the three rings that spread from under the lip on release. Guards
 * non-finite values: a UI-thread throw here would exit Expo Go silently. */
function RippleRing({ ring, width, height, radius, colour, top }: RingProps) {
  const style = useAnimatedStyle(() => {
    const t = Number.isFinite(ring.value) ? ring.value : 1;
    if (t <= 0 || t >= 1) return { opacity: 0, transform: [{ scale: 1 }] };
    return {
      opacity: prism.ripple.opacity * (1 - t),
      transform: [{ scale: 1 + (prism.ripple.scale - 1) * t }],
    };
  });
  return (
    <Animated.View
      pointerEvents="none"
      style={[
        styles.ring,
        { top, left: 0, width, height, borderRadius: radius, borderWidth: prism.ripple.width, borderColor: colour },
        style,
      ]}
    />
  );
}

/**
 * The Tide Drop press: the face sinks onto its lip on press-in, holds while
 * held, springs back on release, and three rings spread from the lip and
 * fade. Reduced motion keeps a small 1.5 px sink and skips the rings. Uses
 * `Pressable` directly, not `PressScale`: the sink replaces the scale.
 */
export function PrismButton({
  shape,
  size,
  width,
  height,
  verb,
  flat,
  label,
  value,
  style,
  containerStyle,
  children,
  on = false,
  onPress,
  onLongPress,
  disabled,
  haptic = true,
  accessibilityLabel,
  accessibilityRole = 'button',
  accessibilityState,
  onLayout,
  testID,
}: PrismButtonProps) {
  const reducedMotion = useReducedMotion();
  const dims = prismFaceSize(shape, size, width, height);
  const [measuredWidth, setMeasuredWidth] = useState<number | undefined>(dims.width);
  const lipWidth = dims.width ?? measuredWidth;

  const onT = useSharedValue(on ? 1 : 0);
  useEffect(() => {
    onT.value = withTiming(on ? 1 : 0, { duration: 180 });
  }, [on, onT]);

  const sinkT = useSharedValue(0);
  const r1 = useSharedValue(1);
  const r2 = useSharedValue(1);
  const r3 = useSharedValue(1);

  // Stays the same when `disabled` flips, so the lip and the reserved space never jump.
  const sink = reducedMotion ? prism.press.sinkReduced : clampSink(dims.height);

  // 0 enabled, 1 disabled: drives the face down to the sunk position (flush
  // with where the lip sits) instead of a press, and zeroes the glow and sheen.
  const dimT = useSharedValue(disabled ? 1 : 0);
  useEffect(() => {
    dimT.value = withTiming(disabled ? 1 : 0, { duration: 160 });
  }, [disabled, dimT]);

  // `Math.max` rather than a sum: if `disabled` flips true mid-press, sinkT
  // (springing back to 0 per the press-out guard) and dimT (rising to 1) never
  // add up to more than one sink, so the face cannot overshoot its lip depth.
  const faceStyle = useAnimatedStyle(() => {
    const press = Number.isFinite(sinkT.value) ? sinkT.value : 0;
    const dim = Number.isFinite(dimT.value) ? dimT.value : 0;
    return { transform: [{ translateY: Math.max(press, sink * dim) }] };
  });

  const handleFaceLayout = (e: LayoutChangeEvent) => {
    if (dims.width === undefined) setMeasuredWidth(e.nativeEvent.layout.width);
    onLayout?.(e);
  };

  const handlePressIn = () => {
    if (disabled) return;
    if (haptic) void hapticImpact();
    sinkT.set(withTiming(sink, { duration: prism.press.sinkInMs, easing: Easing.out(Easing.quad) }));
  };

  // Always springs back, even if `disabled` flipped true mid-press, so the
  // face never stays sunk.
  const handlePressOut = () => {
    sinkT.set(reducedMotion ? withTiming(0, { duration: 90 }) : withSpring(0, prism.press.spring));
  };

  // Rings start here rather than on press-out, so a press cancelled by a
  // scroll or a slide off the button does not ripple.
  const handlePress = () => {
    if (disabled) return;
    if (!reducedMotion) {
      const rings = [r1, r2, r3];
      for (let i = 0; i < rings.length; i++) {
        rings[i].set(0);
        rings[i].set(withDelay(prism.ripple.delays[i], withTiming(1, { duration: prism.ripple.ms, easing: Easing.out(Easing.cubic) })));
      }
    }
    onPress?.();
  };

  const colours = verbTokens[verb];

  return (
    <Pressable
      onPress={disabled ? undefined : handlePress}
      onLongPress={disabled ? undefined : onLongPress}
      disabled={disabled}
      hitSlop={6}
      accessibilityRole={accessibilityRole}
      accessibilityLabel={accessibilityLabel}
      accessibilityState={{ ...accessibilityState, disabled }}
      testID={testID}
      onPressIn={handlePressIn}
      onPressOut={handlePressOut}
      style={[styles.outer, { paddingBottom: sink }, disabled ? styles.disabled : null, containerStyle]}>
      {!reducedMotion && !disabled && lipWidth !== undefined
        ? [r1, r2, r3].map((ring, i) => (
            <RippleRing key={i} ring={ring} width={lipWidth} height={dims.height} radius={dims.radius} colour={colours.c2} top={sink} />
          ))
        : null}
      {!disabled && lipWidth !== undefined ? (
        <View
          pointerEvents="none"
          style={[
            styles.lip,
            { top: sink, left: 0, width: lipWidth, height: dims.height, borderRadius: dims.radius, backgroundColor: colours.lip },
          ]}
        />
      ) : null}
      <Animated.View onLayout={handleFaceLayout} style={faceStyle}>
        <PrismFace
          shape={shape}
          size={size}
          width={width}
          height={height}
          verb={verb}
          onT={onT}
          dimT={dimT}
          flat={flat}
          label={label}
          value={value}
          style={style}>
          {children}
        </PrismFace>
      </Animated.View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  outer: { overflow: 'visible' },
  disabled: { opacity: 0.35 },
  lip: { position: 'absolute' },
  ring: { position: 'absolute', backgroundColor: 'transparent' },
});
