/**
 * The energy meter, built from designs/energy-bolt/r1/V7: a 24px bolt (2px
 * outline, Skia path, fill clipped by a rect that rises with the level) and the
 * count beside it. One spring (damping 18, stiffness 180) drives the fill and
 * the count, so the number ticks down exactly as the bolt drains, and a second
 * tap retargets the same spring. Low (10 or less) turns amber with one pulse;
 * empty draws a dashed dim outline. Reduced motion jumps the level and fades
 * the bolt from 35% to 100% over 150ms. Also the cost chip for AI buttons.
 */
import { useEffect, useRef } from 'react';
import { StyleSheet, Text, TextInput, View } from 'react-native';
import { Canvas, DashPathEffect, Group, interpolateColors, Path, Skia } from '@shopify/react-native-skia';
import Animated, {
  cancelAnimation,
  useAnimatedProps,
  useAnimatedStyle,
  useDerivedValue,
  useReducedMotion,
  useSharedValue,
  withDelay,
  withSequence,
  withSpring,
  withTiming,
} from 'react-native-reanimated';

import { fonts } from '@/constants/fonts';
import { verb } from '@/constants/theme';
import { energyLevel, ENERGY_LOW, type EnergyLevel } from '@/lib/energy';
import { useDir, useT } from '@/lib/i18n';
import type { Energy } from '@/lib/api';

const BOLT = 'M13.2 2.2 L4.6 13.4 H10.9 L9.9 21.8 L19.4 9.8 H13 Z';
const Y0 = 21.8;
const H = 19.6;
const FULL = verb.listen.c1;
const LOW = verb.read.c1;
const EMPTY = '#8A90A6';
const INK = '#ECE8F4';
const DIM = '#B7B1C6';
const AMBER_INK = '#FFE9A8';
// Clamped: a big drop (60 to 8) must not swing past the target and read 0.
const SPRING = { damping: 18, stiffness: 180, overshootClamping: true };
const AnimatedInput = Animated.createAnimatedComponent(TextInput);

// Built on first use, not at import: Skia is not loaded when the web static
// export imports this module, so a module-scope call would throw there.
let boltCache: ReturnType<typeof Skia.Path.MakeFromSVGString> | undefined;
function getBoltPath() {
  if (boltCache === undefined) {
    try {
      boltCache = Skia.Path.MakeFromSVGString(BOLT);
    } catch {
      boltCache = null;
    }
  }
  return boltCache;
}

const KIND_INDEX: Record<EnergyLevel, number> = { full: 0, low: 1, empty: 2 };

type MeterProps = { left: number; max: number };

/** The bolt and the count beside it (the V7 "beside" layout). */
export function EnergyMeter({ left, max }: MeterProps) {
  const { t } = useT();
  const dir = useDir();
  const reduced = useReducedMotion();
  const total = Math.max(1, max);
  const target = Math.min(1, Math.max(0, left / total));
  const kind = energyLevel(left);
  const boltPath = getBoltPath();

  const level = useSharedValue(target);
  const tone = useSharedValue(KIND_INDEX[kind]);
  const scale = useSharedValue(1);
  const fade = useSharedValue(1);
  const prev = useRef(left);

  useEffect(() => {
    const before = prev.current;
    prev.current = left;
    tone.value = reduced ? KIND_INDEX[kind] : withTiming(KIND_INDEX[kind], { duration: 90 });
    if (reduced) {
      cancelAnimation(level);
      level.value = target;
      if (before !== left) {
        fade.value = 0.35;
        fade.value = withTiming(1, { duration: 150 });
      }
      return;
    }
    level.value = withSpring(target, SPRING);
    if (before > ENERGY_LOW && left <= ENERGY_LOW && left > 0) {
      scale.value = withDelay(160, withSequence(withTiming(1.08, { duration: 120 }), withTiming(1, { duration: 120 })));
    }
  }, [left, target, kind, reduced, level, tone, scale, fade]);

  const clip = useDerivedValue(() => {
    const raw = level.value;
    const l = Number.isFinite(raw) ? Math.min(1, Math.max(0, raw)) : 0;
    const v = l <= 0.0005 ? 0 : 0.09 + 0.91 * l;
    // Plain object (what Skia.XYWHRect builds), so nothing throws where Skia is not loaded.
    return { x: 0, y: Y0 - H * v, width: 24, height: 24 };
  });
  const colour = useDerivedValue(() => {
    const raw = tone.value;
    return interpolateColors(Number.isFinite(raw) ? raw : 0, [0, 1, 2], [FULL, LOW, EMPTY]);
  });
  const boltStyle = useAnimatedStyle(() => ({
    opacity: Number.isFinite(fade.value) ? fade.value : 1,
    transform: [{ scale: Number.isFinite(scale.value) ? scale.value : 1 }],
  }));
  const countProps = useAnimatedProps(() => {
    const raw = level.value;
    const l = Number.isFinite(raw) ? Math.min(1, Math.max(0, raw)) : 0;
    const text = String(Math.round(l * total));
    return { text, defaultValue: text } as object;
  });

  const numColour = kind === 'empty' ? DIM : kind === 'low' ? AMBER_INK : INK;
  return (
    <View
      accessible
      accessibilityRole="text"
      accessibilityLabel={t('energy.a11y', { n: left, max })}
      style={[styles.beside, dir.row]}>
      <Animated.View style={[styles.bolt, boltStyle]}>
        <Canvas style={styles.bolt}>
          <Group>
            {boltPath ? (
              <>
                <Group clip={clip}>
                  <Path path={boltPath} color={colour} opacity={0.9} />
                </Group>
                <Path path={boltPath} style="stroke" strokeWidth={2} strokeJoin="round" strokeCap="round" color={colour}>
                  {kind === 'empty' ? <DashPathEffect intervals={[2.6, 2.6]} /> : null}
                </Path>
              </>
            ) : null}
          </Group>
        </Canvas>
      </Animated.View>
      {/* One LTR unit: "5 / 60" reads the same way in Hebrew and Arabic. */}
      <View style={styles.count}>
        <AnimatedInput
          editable={false}
          pointerEvents="none"
          underlineColorAndroid="transparent"
          style={[styles.num, { color: numColour, width: String(max).length * 9 }]}
          animatedProps={countProps}
          defaultValue={String(left)}
        />
        <Text style={styles.of}>{` / ${max}`}</Text>
      </View>
    </View>
  );
}

const CHIP: Record<EnergyLevel, { text: string; bg: string; border: string }> = {
  full: { text: '#DDEBFF', bg: 'rgba(124,200,255,0.16)', border: 'rgba(124,200,255,0.38)' },
  low: { text: AMBER_INK, bg: 'rgba(255,200,87,0.14)', border: 'rgba(255,200,87,0.4)' },
  empty: { text: DIM, bg: 'rgba(255,255,255,0.06)', border: 'rgba(255,255,255,0.14)' },
};

/** The cost chip on an AI button: outline bolt and the price, "Not enough"
 * when some energy is left but less than the price, "Tomorrow" at 0. */
export function EnergyChip({ energy, cost }: { energy: Energy | null; cost: number }) {
  const { t } = useT();
  const boltPath = getBoltPath();
  if (!energy || !energy.on) return null;
  const left = energy.daily_left + energy.granted_left;
  const spent = !energy.owner && left < cost;
  const label = !spent ? String(cost) : left > 0 ? t('energy.notEnough') : t('energy.tomorrow');
  const kind: EnergyLevel = spent ? 'empty' : energyLevel(left);
  const c = CHIP[kind];
  return (
    <View style={[styles.chip, { backgroundColor: c.bg, borderColor: c.border }]}>
      <Canvas style={styles.chipBolt}>
        <Group transform={[{ scale: 14 / 24 }]}>
          {boltPath ? <Path path={boltPath} style="stroke" strokeWidth={(1.6 * 24) / 14} strokeJoin="round" strokeCap="round" color={c.text} /> : null}
        </Group>
      </Canvas>
      <Text style={[styles.chipText, { color: c.text }]}>{label}</Text>
    </View>
  );
}

/** The line under the meter: free practice, the low warning, or come back tomorrow. */
export function EnergyNote({ energy }: { energy: Energy }) {
  const { t } = useT();
  const dir = useDir();
  const left = energy.daily_left + energy.granted_left;
  const kind = energyLevel(left);
  return (
    <Text style={[styles.note, kind === 'low' && styles.noteLow, dir.text]}>
      {kind === 'full' ? (
        t('energy.free')
      ) : kind === 'low' ? (
        <>
          <Text style={styles.noteBold}>{t('energy.lowHead', { n: left })}</Text>
          {` ${t('energy.lowTail')}`}
        </>
      ) : (
        <>
          <Text style={styles.noteBold}>{t('energy.emptyHead')}</Text>
          {` ${t('energy.emptyTail')}`}
        </>
      )}
    </Text>
  );
}

const styles = StyleSheet.create({
  beside: { flexDirection: 'row', alignItems: 'center', gap: 6, flexShrink: 0 },
  bolt: { width: 24, height: 24 },
  count: { flexDirection: 'row', direction: 'ltr', alignItems: 'baseline' },
  num: { fontFamily: fonts.ui, fontSize: 14, fontWeight: '800', fontVariant: ['tabular-nums'], padding: 0, textAlign: 'right' },
  of: { fontFamily: fonts.ui, fontSize: 14, fontWeight: '600', color: DIM, fontVariant: ['tabular-nums'] },
  chip: { flexDirection: 'row', alignItems: 'center', gap: 4, height: 26, paddingStart: 7, paddingEnd: 10, borderRadius: 13, borderWidth: 1 },
  chipBolt: { width: 14, height: 14 },
  chipText: { fontFamily: fonts.ui, fontSize: 13, fontWeight: '700' },
  note: { fontFamily: fonts.ui, fontSize: 13, lineHeight: 18, color: DIM, marginHorizontal: 6, marginTop: 8 },
  noteLow: { color: '#FFE2A0' },
  noteBold: { fontWeight: '600', color: INK },
});
