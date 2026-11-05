// focus-stories D5: the translation shown under the sentence while the body is
// held. `text` is the stage's `translation` (empty or undefined draws nothing),
// `shown` is true while the finger is down, `width` = window width - 48.
// It is absolute, so it never moves the sentence; it fades in 150ms and out 120ms.
import { useEffect } from 'react';
import { StyleSheet } from 'react-native';
import Animated, { Easing, useAnimatedStyle, useReducedMotion, useSharedValue, withTiming } from 'react-native-reanimated';

import { fonts } from '@/constants/fonts';
import { tide } from '@/constants/theme';
import { useT } from '@/lib/i18n';

export type TranslationSlotProps = { text: string | undefined; shown: boolean; width: number };

export function TranslationSlot({ text, shown, width }: TranslationSlotProps) {
  const reduced = useReducedMotion();
  const { t } = useT();
  const o = useSharedValue(0);
  useEffect(() => {
    o.value = withTiming(shown ? 1 : 0, { duration: reduced ? 0 : shown ? 150 : 120, easing: Easing.out(Easing.cubic) });
  }, [shown, reduced, o]);
  const style = useAnimatedStyle(() => ({ opacity: Number.isFinite(o.value) ? o.value : 0 }));
  if (!text) return null;
  return (
    <Animated.Text
      numberOfLines={3}
      pointerEvents="none"
      accessibilityLabel={`${t('ladder.translation')}: ${text}`}
      accessibilityElementsHidden={!shown}
      importantForAccessibility={shown ? 'yes' : 'no-hide-descendants'}
      style={[styles.text, { width, top: 0 }, style]}>
      {text}
    </Animated.Text>
  );
}

const styles = StyleSheet.create({
  text: { position: 'absolute', alignSelf: 'center', marginTop: 8, fontFamily: fonts.ui, fontSize: 17, lineHeight: 24, color: tide.textDim, textAlign: 'center' },
});
