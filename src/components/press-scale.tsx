import { Pressable, type PressableProps } from 'react-native';
import Animated, { useAnimatedStyle, useReducedMotion, useSharedValue, withSpring } from 'react-native-reanimated';
import * as Haptics from 'expo-haptics';

const AnimatedPressable = Animated.createAnimatedComponent(Pressable);

export type PressScaleProps = PressableProps & {
  /** Whether to fire haptic feedback on press. Defaults to true. */
  haptic?: boolean;
};

/**
 * A wrapper around Pressable that animates a scale transform to 0.94 on press-in,
 * springs back to 1 on press-out, and provides light haptic feedback.
 * Respects reduced-motion preferences by skipping the scale animation.
 */
export function PressScale({ onPress, onLongPress, disabled, haptic = true, style, children, ...props }: PressScaleProps) {
  const scale = useSharedValue(1);
  const reducedMotion = useReducedMotion();

  const handlePressIn = async () => {
    // Fire haptic on press-in
    if (haptic) {
      await Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    }

    // Animate scale only if not disabled and reduced motion is not requested
    if (!disabled && !reducedMotion) {
      scale.value = withSpring(0.94);
    }
  };

  const handlePressOut = () => {
    // Spring back to 1 only if reduced motion is not requested
    if (!disabled && !reducedMotion) {
      scale.value = withSpring(1);
    }
  };

  const animatedStyle = useAnimatedStyle(() => ({
    transform: [{ scale: scale.value }],
  }));

  return (
    <AnimatedPressable
      {...props}
      onPress={onPress}
      onLongPress={onLongPress}
      disabled={disabled}
      onPressIn={handlePressIn}
      onPressOut={handlePressOut}
      style={[animatedStyle, style]}>
      {children}
    </AnimatedPressable>
  );
}
