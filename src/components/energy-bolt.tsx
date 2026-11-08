/**
 * The energy meter (board-energy card A, motion V7 "spent part lingers"): a
 * Skia bolt whose fill is clipped by a rect that rises with the level, a pale
 * ghost of the spent part that follows 160 ms later, the count beside it and
 * a mini bar that snaps. One component draws Home's chip (18 pt bolt) and the
 * energy sheet's lead (40 pt bolt). Amber at 1 to 4, grey dashed at 0; the
 * two tones are separate values so a refill from 0 never passes through
 * amber. While `active` is false the meter holds its values and replays the
 * change 200 ms after it turns true (a spend made on record.tsx with Home
 * underneath). Reduced motion jumps the level and fades the bolt from 35% to
 * 100% over 150 ms. Also the cost chip for AI buttons.
 */
import { useEffect, useRef, useState } from 'react';
import { Platform, StyleSheet, Text, TextInput, View } from 'react-native';
import { Canvas, DashPathEffect, Group, Path, Skia } from '@shopify/react-native-skia';
import Animated, {
  cancelAnimation,
  Easing,
  interpolateColor,
  runOnJS,
  useAnimatedProps,
  useAnimatedReaction,
  useAnimatedStyle,
  useDerivedValue,
  useReducedMotion,
  useSharedValue,
  withDelay,
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
const DIM = '#B7B1C6';
const AMBER_INK = '#FFE9A8';
/** The chip's number: the stats row's white, amber when low, dim at 0. */
const CHIP_INK = '#FFFFFF';
const CHIP_DIM = '#B7BDCB';
const TRACK = 'rgba(255,255,255,0.14)';
const TONE: Record<EnergyLevel, string> = { full: FULL, low: LOW, empty: EMPTY };
const SIZE = { chip: 18, sheet: 40 } as const;
// Clamped: a big drop (300 to 5) must not swing past the target and read 0.
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

/** The bolt outline at any size: the cost chip and the sheet's cost rows. `dashed` is the empty state's outline. */
export function BoltGlyph({ size, color, dashed }: { size: number; color: string; dashed?: boolean }) {
  const boltPath = getBoltPath();
  return (
    <Canvas style={{ width: size, height: size }}>
      <Group transform={[{ scale: size / 24 }]}>
        {boltPath ? (
          <Path path={boltPath} style="stroke" strokeWidth={(1.6 * 24) / size} strokeJoin="round" strokeCap="round" color={color}>
            {dashed ? <DashPathEffect intervals={[2.6, 2.6]} /> : null}
          </Path>
        ) : null}
      </Group>
    </Canvas>
  );
}

/** The clip rect (in the bolt's 24 unit box) for a fill level 0..1. */
function fillRect(level: number) {
  'worklet';
  const l = Number.isFinite(level) ? Math.min(1, Math.max(0, level)) : 0;
  const v = l <= 0.0005 ? 0 : 0.09 + 0.91 * l;
  // Plain object (what Skia.XYWHRect builds), so nothing throws where Skia is not loaded.
  return { x: 0, y: Y0 - H * v, width: 24, height: 24 };
}

function clamp01(raw: number) {
  'worklet';
  return Number.isFinite(raw) ? Math.min(1, Math.max(0, raw)) : 0;
}

type MeterProps = {
  left: number;
  max: number;
  /** `chip`: Home's stats row (18 pt bolt, number, 30 x 5 bar). `sheet`: the energy sheet's lead (40 pt bolt, "n / max", full-width bar). */
  variant: 'chip' | 'sheet';
  /** False while the screen is under another one: hold the values, replay the change 200 ms after focus. */
  active?: boolean;
};

/** The bolt, the count beside it and the mini bar (board-energy card A). */
export function EnergyMeter({ left, max, variant, active = true }: MeterProps) {
  const { t } = useT();
  const dir = useDir();
  const reduced = useReducedMotion();
  const total = Math.max(1, max);
  const kind = energyLevel(left);
  const boltPath = getBoltPath();
  const sheet = variant === 'sheet';
  const size = SIZE[variant];

  const bal = useSharedValue(left);
  const ghost = useSharedValue(Math.min(1, left / total));
  const warm = useSharedValue(kind === 'low' ? 1 : 0);
  const empty = useSharedValue(kind === 'empty' ? 1 : 0);
  const fade = useSharedValue(1);
  // What the meter last showed, and whether it was held while `left` moved.
  const shown = useRef({ left, total });
  const wasActive = useRef(active);
  const [dashed, setDashed] = useState(kind === 'empty');
  // The number box is as wide as the larger of the two values, set once per change.
  const boxDigits = useSharedValue(String(left).length);

  useEffect(() => {
    const resumed = active && !wasActive.current;
    wasActive.current = active;
    if (!active) return;
    const before = shown.current;
    if (before.left === left && before.total === total) return;
    shown.current = { left, total };
    boxDigits.value = Math.max(String(left).length, String(before.left).length);
    const level = Math.min(1, left / total);
    const low = left > 0 && left <= ENERGY_LOW ? 1 : 0;
    if (reduced) {
      cancelAnimation(bal);
      cancelAnimation(ghost);
      bal.value = left;
      ghost.value = level;
      warm.value = low;
      empty.value = left === 0 ? 1 : 0;
      fade.value = 0.35;
      fade.value = withTiming(1, { duration: 150 });
      return;
    }
    const wait = resumed ? 200 : 0;
    if (left < before.left) {
      // Spend: the solid fill drops at once, the pale ghost of the spent part follows.
      bal.value = withDelay(wait, withSpring(left, SPRING));
      ghost.value = withDelay(wait + 160, withTiming(level, { duration: 280, easing: Easing.out(Easing.quad) }));
    } else {
      // Refill or purchase: the pale part leads, the solid fill follows.
      ghost.value = withDelay(wait, withTiming(level, { duration: 220, easing: Easing.out(Easing.cubic) }));
      bal.value = withDelay(wait + 120, withSpring(left, SPRING));
    }
    warm.value = withDelay(wait, withTiming(low, { duration: 240, easing: Easing.out(Easing.quad) }));
    // Grey waits for the drain to land; on a refill it leaves at once.
    empty.value = left === 0 ? withDelay(wait + 220, withTiming(1, { duration: 240 })) : withDelay(wait, withTiming(0, { duration: 240 }));
  }, [left, total, active, reduced, bal, ghost, warm, empty, fade, boxDigits]);

  const solidClip = useDerivedValue(() => fillRect(bal.value / total));
  // The ghost never sits under the solid fill, even when a second change retargets both.
  const ghostClip = useDerivedValue(() => fillRect(Math.max(ghost.value, bal.value / total)));
  const colour = useDerivedValue(() =>
    interpolateColor(clamp01(empty.value), [0, 1], [interpolateColor(clamp01(warm.value), [0, 1], [FULL, LOW]), EMPTY]),
  );
  // The dashed outline is a render prop: one JS call when `empty` crosses the middle.
  useAnimatedReaction(
    () => empty.value > 0.5,
    (now, before) => {
      if (now !== before) runOnJS(setDashed)(now);
    },
  );
  const boltStyle = useAnimatedStyle(() => ({ opacity: Number.isFinite(fade.value) ? fade.value : 1 }));
  const countProps = useAnimatedProps(() => {
    const raw = bal.value;
    const text = String(Math.round(Number.isFinite(raw) ? Math.max(0, raw) : 0));
    return { text, defaultValue: text } as object;
  });
  const chipInk = useAnimatedStyle(() => ({
    color: interpolateColor(clamp01(empty.value), [0, 1], [interpolateColor(clamp01(warm.value), [0, 1], [CHIP_INK, AMBER_INK]), CHIP_DIM]),
  }));
  const boxWidth = useAnimatedStyle(() => ({ width: boxDigits.value * (sheet ? 26 : 9) }));

  // The mini bar snaps: a plain style, the bolt's tone.
  const barFill = { width: `${Math.round(Math.min(1, left / total) * 100)}%` as const, backgroundColor: TONE[kind] };
  const bar = (
    <View style={[styles.bar, sheet ? styles.barSheet : styles.barChip]}>
      <View style={[styles.barFill, barFill]} />
    </View>
  );
  return (
    <View
      accessible
      accessibilityRole="text"
      accessibilityLabel={t('energy.a11y', { n: left, max })}
      style={sheet ? styles.sheetWrap : [styles.beside, dir.row]}>
      <View style={[styles.beside, dir.row, sheet && styles.besideSheet]}>
        <Animated.View style={[{ width: size, height: size }, boltStyle]}>
          <Canvas style={{ width: size, height: size }}>
            <Group transform={[{ scale: size / 24 }]}>
              {boltPath ? (
                <>
                  <Group clip={ghostClip}>
                    <Path path={boltPath} color={colour} opacity={0.35} />
                  </Group>
                  <Group clip={solidClip}>
                    <Path path={boltPath} color={colour} />
                  </Group>
                  <Path path={boltPath} style="stroke" strokeWidth={1.8} strokeJoin="round" strokeCap="round" color={colour}>
                    {dashed ? <DashPathEffect intervals={[2.6, 2.6]} /> : null}
                  </Path>
                </>
              ) : null}
            </Group>
          </Canvas>
        </Animated.View>
        {/* One LTR unit: the digits read the same way in Hebrew and Arabic. */}
        <View style={styles.count}>
          <AnimatedInput
            editable={false}
            pointerEvents="none"
            underlineColorAndroid="transparent"
            style={[sheet ? styles.numSheet : styles.numChip, boxWidth, sheet ? null : chipInk]}
            animatedProps={countProps}
            defaultValue={String(left)}
          />
          {sheet ? <Text style={styles.of}>{` / ${max}`}</Text> : null}
        </View>
        {sheet ? null : bar}
      </View>
      {sheet ? bar : null}
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
  if (!energy || !energy.on) return null;
  const left = energy.daily_left + energy.granted_left;
  const spent = !energy.owner && left < cost;
  const label = !spent ? String(cost) : left > 0 ? t('energy.notEnough') : t('energy.tomorrow');
  const kind: EnergyLevel = spent ? 'empty' : energyLevel(left);
  const c = CHIP[kind];
  return (
    <View style={[styles.chip, { backgroundColor: c.bg, borderColor: c.border }]}>
      <BoltGlyph size={14} color={c.text} />
      <Text style={[styles.chipText, { color: c.text }]}>{label}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  beside: { flexDirection: 'row', alignItems: 'center', gap: 6, flexShrink: 0 },
  besideSheet: { gap: 10 },
  sheetWrap: { alignSelf: 'stretch', gap: 10 },
  count: { flexDirection: 'row', ...Platform.select({ web: {}, default: { direction: 'ltr' as const } }), alignItems: 'baseline' },
  numChip: { fontFamily: fonts.ui, fontSize: 16, fontWeight: '700', fontVariant: ['tabular-nums'], padding: 0, textAlign: 'right' },
  // The picked energy sheet's lead number (board-energy `.bn`): 44 px, bold, white.
  numSheet: { fontFamily: fonts.ui, fontSize: 44, fontWeight: '700', color: '#FFFFFF', fontVariant: ['tabular-nums'], padding: 0, textAlign: 'right' },
  of: { fontFamily: fonts.ui, fontSize: 16, fontWeight: '600', color: DIM, fontVariant: ['tabular-nums'] },
  // The fill grows from the left in every language, like the digits.
  bar: { borderRadius: 4, backgroundColor: TRACK, overflow: 'hidden', ...Platform.select({ web: {}, default: { direction: 'ltr' as const } }) },
  barChip: { width: 30, height: 5 },
  barSheet: { alignSelf: 'stretch', height: 8 },
  barFill: { height: '100%', borderRadius: 4 },
  chip: { flexDirection: 'row', alignItems: 'center', gap: 4, height: 26, paddingStart: 7, paddingEnd: 10, borderRadius: 13, borderWidth: 1 },
  chipText: { fontFamily: fonts.ui, fontSize: 13, fontWeight: '700' },
});
