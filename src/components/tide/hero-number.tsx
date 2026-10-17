import { Blur, Canvas, Group, RadialGradient, Rect, vec } from '@shopify/react-native-skia';
import { StyleSheet, Text, View, type TextStyle } from 'react-native';

import { fonts } from '@/constants/fonts';
import { useDir } from '@/lib/i18n';

// The H2c hero number: white digits on a blue ground shadow, a tight contact
// shadow and a faint gold halo, over a soft gold radial glow. All static.
const SIZE = 88;
const GLOW_W = 320;
const GLOW_H = 186;
const GOLD = '245,196,81';

// Android clips a text shadow to the Text box, so each layer is padded by PAD and pulled back by the same margin.
const PAD = 24;
const base: TextStyle = { padding: PAD, margin: -PAD, fontFamily: fonts.ui, fontSize: SIZE, fontWeight: '700', lineHeight: SIZE, color: '#FFFFFF', textAlign: 'left', includeFontPadding: false };

/** The soft gold radial glow behind a hero number, sized for the 88pt digits. */
export function HeroGlow() {
  return (
    <Canvas style={styles.glow} pointerEvents="none">
      {/* closest-side ellipse: a circle squashed to 186 high */}
      <Group transform={[{ scaleY: GLOW_H / GLOW_W }]}>
        <Rect x={0} y={0} width={GLOW_W} height={GLOW_W}>
          <RadialGradient
            c={vec(GLOW_W / 2, GLOW_W / 2)}
            r={GLOW_W / 2}
            positions={[0, 0.55, 1]}
            colors={[`rgba(${GOLD},0.14)`, `rgba(${GOLD},0.05)`, `rgba(${GOLD},0)`]}
          />
          <Blur blur={5} />
        </Rect>
      </Group>
    </Canvas>
  );
}

export const HERO_SIZE = SIZE;
export const heroText = base;

/** The big session count. Three same-glyph layers because a Text takes one shadow each. `label` replaces the digits, `size` the 88pt default. */
export function HeroNumber({ value, label: text, color = '#FFFFFF', size = SIZE }: { value: number; label?: string; color?: string; size?: number }) {
  const label = text ?? String(value);
  const sized = size === SIZE ? null : { fontSize: size, lineHeight: size };
  const { rtl } = useDir();
  return (
    <View style={[styles.box, sized && { height: size }, rtl && styles.boxRtl]}>
      <HeroGlow />
      <Text accessible={false} style={[base, sized, styles.layer, { textShadowColor: 'rgba(10,40,120,0.45)', textShadowOffset: { width: 0, height: 10 }, textShadowRadius: 18 }]}>
        {label}
      </Text>
      <Text accessible={false} style={[base, sized, styles.layer, { textShadowColor: 'rgba(6,20,60,0.45)', textShadowOffset: { width: 0, height: 2 }, textShadowRadius: 3 }]}>
        {label}
      </Text>
      <Text style={[base, sized, { color, textShadowColor: `rgba(${GOLD},0.2)`, textShadowOffset: { width: 0, height: 0 }, textShadowRadius: 16 }]}>{label}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  box: { height: SIZE, alignSelf: 'flex-start' },
  // The number sits on the reading edge: the right one in Hebrew.
  boxRtl: { alignSelf: 'flex-end' },
  glow: { position: 'absolute', left: -90, top: -49, width: GLOW_W, height: GLOW_H },
  layer: { position: 'absolute', left: 0, top: 0 },
});
