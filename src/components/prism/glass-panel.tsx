import { type ReactNode } from 'react';
import { type StyleProp, StyleSheet, View, type ViewStyle } from 'react-native';
import { BlurView } from 'expo-blur';

import { prism } from '@/constants/theme';

export type GlassPanelProps = {
  /** Corner radius. Defaults to `prism.panel.radius`; pass `Radius.pill` for a tab bar. */
  radius?: number;
  style?: StyleProp<ViewStyle>;
  children?: ReactNode;
};

/**
 * One shared pane of glass under a group of `flat` `PrismButton`s, so a row
 * of tiles or a tab bar costs a single blur pass instead of one per button.
 * The buttons inside keep their own sheen, fringe, lip, sink and ripples.
 */
export function GlassPanel({ radius = prism.panel.radius, style, children }: GlassPanelProps) {
  return (
    <View style={[styles.clip, { borderRadius: radius }, style]}>
      <BlurView style={StyleSheet.absoluteFill} intensity={prism.blur.intensity} tint={prism.blur.tint} />
      <View style={[StyleSheet.absoluteFill, { backgroundColor: prism.panel.fill }]} />
      <View pointerEvents="none" style={[StyleSheet.absoluteFill, { borderRadius: radius, borderWidth: 1, borderColor: prism.panel.rim }]} />
      {children}
    </View>
  );
}

const styles = StyleSheet.create({
  clip: { overflow: 'hidden', boxShadow: prism.shadow },
});
