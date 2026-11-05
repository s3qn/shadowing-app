// The ladder's tiles: Tile, the 145deg gradient tile the review and the celebration
// draw, and LadderHelpButton, the 26pt dim circle of the stage's row and a native header.
// Split out of ladder-stage.tsx as a pure move, no behaviour change.
import { Canvas, LinearGradient, RoundedRect, vec } from '@shopify/react-native-skia';
import type { ReactNode } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import type { Look } from '@/components/tide/ladder/stage-model';
import { EDGE } from '@/components/tide/ladder/stage-tokens';
import { tide, withAlpha } from '@/constants/theme';
import { useT } from '@/lib/i18n';

/** A gradient tile (the mock's 145deg tint fill): the review's kind tiles and the celebration's. */
export function Tile({ look, size, radius, fontSize, children }: { look: Look; size: number; radius: number; fontSize: number; children: ReactNode }) {
  const inner = Math.max(size - 2, 0);
  return (
    <View
      style={[
        styles.tile,
        { width: size, height: size, borderRadius: radius, borderColor: withAlpha(look.tint, look.rim) },
        look.glow && { shadowColor: look.tint, shadowOpacity: 0.4, shadowRadius: 16, shadowOffset: { width: 0, height: 0 } },
      ]}>
      <Canvas style={StyleSheet.absoluteFill} pointerEvents="none">
        <RoundedRect x={0} y={0} width={inner} height={inner} r={Math.max(radius - 1, 0)}>
          <LinearGradient start={vec(0, 0)} end={vec(inner, inner)} colors={[withAlpha(look.tint, look.from), withAlpha(look.tint, look.to)]} />
        </RoundedRect>
      </Canvas>
      <Text style={[styles.tileText, { fontSize }]}>{children}</Text>
    </View>
  );
}

/** The mock's `.ic`: a 26pt dim circle with one glyph, for the stage's own row and a native header. */
export function LadderHelpButton({ onPress, glyph = '?', label }: { onPress: () => void; glyph?: string; label?: string }) {
  const { t } = useT();
  return (
    <Pressable onPress={onPress} hitSlop={10} accessibilityRole="button" accessibilityLabel={label ?? t('player.help')} style={({ pressed }) => [styles.ib, pressed && { opacity: 0.7 }]}>
      <Text style={styles.ibText}>{glyph}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  ib: { width: 26, height: 26, borderRadius: 13, alignItems: 'center', justifyContent: 'center', borderWidth: 1, borderColor: EDGE },
  ibText: { fontSize: 13, lineHeight: 16, color: tide.textDim },
  tile: { alignItems: 'center', justifyContent: 'center', borderWidth: 1 },
  tileText: { color: tide.text, fontWeight: '700' },
});
