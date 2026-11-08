import { Canvas, LinearGradient, RoundedRect, vec } from '@shopify/react-native-skia';
import { type ReactNode, useState } from 'react';
import { Platform, StyleSheet, Text, View } from 'react-native';

import { PressScale } from '@/components/press-scale';
import { tide } from '@/constants/theme';
import { useDir } from '@/lib/i18n';

const EDGE_A = '#FF5468';
const EDGE_B = '#7CC8FF';
const RADIUS = 20;
const CHECK = 24;

/** The mock's 120deg coral to sky gradient, as a filled or stroked rounded
 * rect drawn by Skia (expo-linear-gradient is not a dependency). */
export function PrismShape({ width, height, radius, stroke, offset = 0 }: { width: number; height: number; radius: number; stroke?: number; offset?: number }) {
  if (!(width > 0 && height > 0)) return null;
  const inset = stroke ? stroke / 2 : 0;
  return (
    <Canvas style={{ position: 'absolute', left: -offset, top: -offset, width, height }} pointerEvents="none">
      <RoundedRect
        x={inset}
        y={inset}
        width={width - inset * 2}
        height={height - inset * 2}
        r={radius - inset}
        style={stroke ? 'stroke' : 'fill'}
        strokeWidth={stroke}>
        <LinearGradient start={vec(0, height * 0.3)} end={vec(width, height * 0.7)} colors={[EDGE_A, EDGE_B]} />
      </RoundedRect>
    </Canvas>
  );
}

/** The selection marker of every exclusive list: a prism check circle when on,
 * an empty ring when off. */
export function CheckCircle({ selected }: { selected: boolean }) {
  if (!selected) return <View style={[styles.check, styles.ring]} />;
  return (
    <View style={styles.check}>
      <PrismShape width={CHECK} height={CHECK} radius={CHECK / 2} />
      <Text style={styles.checkGlyph}>✓</Text>
    </View>
  );
}

/**
 * One card: avatar, title and subtitle, a check, and an information-only chip
 * line (picker F, app/settings/app-language.tsx). The card is the one control.
 * `children` render under the card while it is selected (a voice style
 * Segmented, say). A `soon` card is dimmed, has no check and is not pressable.
 */
export function LanguageCard({
  avatar,
  title,
  subtitle,
  chips,
  selected,
  soon,
  label,
  onPress,
  children,
}: {
  /** A string is a flag or emoji; a node (a voice icon image) fills the circle. */
  avatar: string | ReactNode;
  title: string;
  subtitle?: string;
  chips?: { flag: string; label: string }[];
  selected: boolean;
  soon?: boolean;
  /** Accessibility label; defaults to the title. */
  label?: string;
  onPress: () => void;
  children?: ReactNode;
}) {
  const dir = useDir();
  const [size, setSize] = useState({ w: 0, h: 0 });
  const on = selected && !soon;
  const card = (
    <PressScale
      onPress={soon ? undefined : onPress}
      disabled={soon}
      accessibilityLabel={label ?? title}
      accessibilityState={{ selected: on, disabled: !!soon }}
      style={[styles.card, on && styles.cardOn, soon && styles.soon]}
      onLayout={(e) => setSize({ w: e.nativeEvent.layout.width, h: e.nativeEvent.layout.height })}>
      {on ? <PrismShape width={size.w} height={size.h} radius={RADIUS} stroke={1.5} offset={1} /> : null}
      <View style={[styles.top, dir.row]}>
        <View style={styles.avatar}>
          {typeof avatar === 'string' ? <Text style={styles.flag}>{avatar}</Text> : avatar}
        </View>
        <View style={styles.names}>
          <Text style={[styles.native, dir.text, { textAlign: dir.rtl ? 'right' : 'left' }]}>{title}</Text>
          {subtitle ? <Text style={[styles.english, dir.text]}>{subtitle}</Text> : null}
        </View>
        {soon ? null : <CheckCircle selected={on} />}
      </View>
      {chips && chips.length > 0 ? (
        <View style={[styles.chips, { flexDirection: dir.rtl ? 'row-reverse' : 'row' }]}>
          {chips.map((c) => (
            <View key={c.label} style={styles.chip}>
              <Text style={styles.chipText}>{`${c.flag} ${c.label}`}</Text>
            </View>
          ))}
        </View>
      ) : null}
    </PressScale>
  );
  const under = on && children ? <View style={styles.under}>{children}</View> : null;
  if (!on || Platform.OS !== 'ios') {
    return (
      <View style={styles.slot}>
        {card}
        {under}
      </View>
    );
  }
  return (
    <View style={[styles.slot, styles.glowA]}>
      <View style={styles.glowB}>{card}</View>
      {under}
    </View>
  );
}

const styles = StyleSheet.create({
  slot: { marginBottom: 9, borderRadius: RADIUS },
  under: { marginTop: 8 },
  glowA: Platform.select({
    ios: { backgroundColor: tide.sky[0], shadowColor: EDGE_A, shadowOpacity: 0.28, shadowRadius: 22, shadowOffset: { width: 0, height: 0 } },
    default: {},
  }),
  glowB: Platform.select({
    ios: {
      borderRadius: RADIUS,
      backgroundColor: tide.sky[0],
      shadowColor: EDGE_B,
      shadowOpacity: 0.22,
      shadowRadius: 22,
      shadowOffset: { width: 0, height: 0 },
    },
    default: {},
  }),
  card: {
    backgroundColor: 'rgba(255,255,255,0.07)',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.12)',
    borderRadius: RADIUS,
    paddingVertical: 12,
    paddingHorizontal: 14,
  },
  cardOn: { backgroundColor: 'rgba(255,255,255,0.10)', borderColor: 'transparent' },
  soon: { opacity: 0.45 },
  top: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  avatar: {
    width: 40,
    height: 40,
    borderRadius: 20,
    backgroundColor: 'rgba(255,255,255,0.09)',
    alignItems: 'center',
    justifyContent: 'center',
    overflow: 'hidden',
  },
  flag: { fontSize: 22 },
  names: { flex: 1 },
  native: { fontSize: 17, fontWeight: '600', color: tide.text, writingDirection: 'auto' },
  english: { fontSize: 13, color: tide.textDim, marginTop: 2 },
  check: { width: CHECK, height: CHECK, borderRadius: CHECK / 2, alignItems: 'center', justifyContent: 'center' },
  ring: { borderWidth: 1.5, borderColor: 'rgba(255,255,255,0.12)' },
  checkGlyph: { fontSize: 14, fontWeight: '800', color: '#0B1220' },
  chips: { flexWrap: 'wrap', gap: 6, marginTop: 9, paddingStart: 52 },
  chip: {
    backgroundColor: 'rgba(255,255,255,0.06)',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.12)',
    borderRadius: 999,
    paddingVertical: 3,
    paddingHorizontal: 9,
  },
  chipText: { fontSize: 12, color: tide.textDim },
});
