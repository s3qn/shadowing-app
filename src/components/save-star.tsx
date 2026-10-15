/**
 * The star on a sentence in a video or podcast: one tap saves the sentence to
 * the review deck, another removes it. Toggling gives a short bounce and a
 * selection haptic; reduced motion skips the bounce.
 */

import { SymbolView } from 'expo-symbols';
import { Pressable, StyleSheet } from 'react-native';
import Animated, { useAnimatedStyle, useReducedMotion, useSharedValue, withSequence, withSpring } from 'react-native-reanimated';

import { tide, verb } from '@/constants/theme';
import { hapticSelection } from '@/lib/haptics';
import { useT } from '@/lib/i18n';

export function SaveStar({ saved, onToggle }: { saved: boolean; onToggle: () => void }) {
  const { t } = useT();
  const reducedMotion = useReducedMotion();
  const scale = useSharedValue(1);
  const style = useAnimatedStyle(() => ({ transform: [{ scale: scale.value }] }));

  const press = () => {
    void hapticSelection();
    if (!reducedMotion) {
      scale.value = withSequence(
        withSpring(1.25, { damping: 12, stiffness: 260 }),
        withSpring(1, { damping: 14, stiffness: 200 }),
      );
    }
    onToggle();
  };

  return (
    <Animated.View style={[styles.wrap, style]}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={saved ? t('review.saved') : t('review.save')}
        accessibilityState={{ selected: saved }}
        onPress={press}
        style={[styles.button, { opacity: saved ? 1 : 0.7 }]}>
        <SymbolView
          name={saved ? { ios: 'star.fill', android: 'star' } : { ios: 'star', android: 'star_outline' }}
          size={20}
          weight="regular"
          tintColor={saved ? verb.read.c1 : tide.textDim}
        />
      </Pressable>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  wrap: { position: 'absolute', top: 8, end: 8 },
  button: {
    width: 40,
    height: 40,
    borderRadius: 20,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(255,255,255,0.06)',
  },
});
