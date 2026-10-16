import { useEffect, useRef, useState } from 'react';
import { StyleSheet, Text, TextInput, View } from 'react-native';
import * as Haptics from 'expo-haptics';
import Animated, {
  cancelAnimation,
  Easing,
  useAnimatedProps,
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
  withSequence,
  withSpring,
  withTiming,
} from 'react-native-reanimated';

import { fonts } from '@/constants/fonts';
import { tide, verb } from '@/constants/theme';
import { hapticImpact } from '@/lib/haptics';
import { useDir, useT } from '@/lib/i18n';

export const XP_TRACK = 'rgba(255,255,255,0.10)';
export const XP_HIGHLIGHT = 'rgba(255,255,255,0.25)';
const GOLD = verb.read.c1;
const OUT_CUBIC = Easing.out(Easing.cubic);

export type XpBarProps = {
  fraction: number;
  height?: number;
  /** Bump with the fraction to play a level-up: fill to full, snap to 0, fill the rest. */
  levelUps?: number;
};

/**
 * The XP bar: a track, a gold fill scaled from the leading edge (transform
 * only, no layout) and a 1px top highlight. A new fraction mid-animation
 * retargets the same shared value.
 */
export function XpBar({ fraction, height = 10, levelUps = 0 }: XpBarProps) {
  const dir = useDir();
  const reduced = useReducedMotion();
  const p = Math.min(1, Math.max(0, Number.isFinite(fraction) ? fraction : 0));
  const f = useSharedValue(p);
  const seen = useRef(levelUps);
  useEffect(() => {
    cancelAnimation(f);
    if (reduced) {
      f.value = p;
    } else if (levelUps !== seen.current) {
      f.value = withSequence(withTiming(1, { duration: 300, easing: OUT_CUBIC }), withTiming(0, { duration: 0 }), withTiming(p, { duration: 400, easing: OUT_CUBIC }));
    } else {
      f.value = withTiming(p, { duration: 450, easing: OUT_CUBIC });
    }
    seen.current = levelUps;
  }, [p, levelUps, reduced, f]);
  const fillStyle = useAnimatedStyle(() => ({ transform: [{ scaleX: Number.isFinite(f.value) ? Math.min(1, Math.max(0, f.value)) : 0 }] }));
  return (
    <View style={[styles.track, { height, borderRadius: height / 2 }]}>
      <Animated.View style={[styles.fill, { transformOrigin: dir.rtl ? 'right' : 'left' }, fillStyle]}>
        <View style={styles.highlight} />
      </Animated.View>
    </View>
  );
}

const AnimatedInput = Animated.createAnimatedComponent(TextInput);

/** A coin count that counts to its new value on the UI thread (350ms out-cubic), no setState per frame. */
export function CoinCount({ value, style }: { value: number; style?: object }) {
  const reduced = useReducedMotion();
  const v = useSharedValue(value);
  useEffect(() => {
    cancelAnimation(v);
    v.value = reduced ? value : withTiming(value, { duration: 350, easing: OUT_CUBIC });
  }, [value, reduced, v]);
  const props = useAnimatedProps(() => {
    const text = String(Math.round(Number.isFinite(v.value) ? v.value : 0));
    return { text, defaultValue: text } as object;
  });
  return <AnimatedInput editable={false} pointerEvents="none" underlineColorAndroid="transparent" style={[styles.coinText, style]} animatedProps={props} defaultValue={String(value)} />;
}

export type LevelHeaderProps = {
  level: number;
  xpIntoLevel: number;
  xpToNext: number;
  coins: number;
  xpToday?: number;
  xpTodayCap?: number;
};

/** Level in gold, XP bar and the coin pill. xpToNext 0 means the top level. */
export function LevelHeader({ level, xpIntoLevel, xpToNext, coins, xpToday, xpTodayCap }: LevelHeaderProps) {
  const { t } = useT();
  const dir = useDir();
  const reduced = useReducedMotion();
  const maxed = xpToNext <= 0;
  const [levelUps, setLevelUps] = useState(0);
  const [oldLevel, setOldLevel] = useState<number | null>(null);
  const prevLevel = useRef(level);
  const pulseUntil = useRef(0);
  const pulse = useSharedValue(1);
  const fresh = useSharedValue(1);
  const ring = useSharedValue(0);

  useEffect(() => {
    const prev = prevLevel.current;
    prevLevel.current = level;
    if (level <= prev) return;
    setLevelUps((n) => n + 1);
    void hapticImpact(Haptics.ImpactFeedbackStyle.Heavy);
    if (reduced) return;
    // A pulse that is already running is not replayed; the number just updates.
    if (Date.now() < pulseUntil.current) return;
    pulseUntil.current = Date.now() + 700;
    setOldLevel(prev);
    cancelAnimation(pulse);
    cancelAnimation(fresh);
    cancelAnimation(ring);
    fresh.value = 0;
    fresh.value = withTiming(1, { duration: 220 });
    pulse.value = withSequence(withSpring(1.18, { damping: 12, stiffness: 220 }), withSpring(1, { damping: 12, stiffness: 220 }));
    ring.value = withSequence(withTiming(0.6, { duration: 250 }), withTiming(0, { duration: 250 }));
    const id = setTimeout(() => setOldLevel(null), 260);
    return () => clearTimeout(id);
  }, [level, reduced, pulse, fresh, ring]);

  const pulseStyle = useAnimatedStyle(() => ({ transform: [{ scale: Number.isFinite(pulse.value) ? pulse.value : 1 }] }));
  const newStyle = useAnimatedStyle(() => ({ opacity: Number.isFinite(fresh.value) ? fresh.value : 1 }));
  const oldStyle = useAnimatedStyle(() => ({ opacity: Number.isFinite(fresh.value) ? 1 - fresh.value : 0 }));
  const ringStyle = useAnimatedStyle(() => ({ opacity: Number.isFinite(ring.value) ? ring.value : 0 }));

  return (
    <View style={[styles.wrap, dir.row]}>
      <Animated.View style={[styles.levelDisc, pulseStyle]}>
        <Animated.Text style={[styles.levelNum, newStyle]}>{level}</Animated.Text>
        {oldLevel !== null ? <Animated.Text style={[styles.levelNum, styles.oldLevel, oldStyle]}>{oldLevel}</Animated.Text> : null}
      </Animated.View>
      <View style={styles.left}>
        <View style={[styles.row, dir.row]}>
          <Text style={[styles.label, dir.text]}>{t('wardrobe.lv', { n: level })}</Text>
          <Text style={styles.xp}>{maxed ? t('wardrobe.maxLevel') : t('wardrobe.xp', { into: xpIntoLevel, total: xpToNext })}</Text>
        </View>
        <XpBar height={6} fraction={maxed ? 1 : xpIntoLevel / xpToNext} levelUps={levelUps} />
        {xpToday != null && xpTodayCap != null ? (
          <Text style={[styles.label, dir.text]}>
            {xpToday >= xpTodayCap
              ? t('wardrobe.todayFull')
              : t('wardrobe.today', { used: xpToday, cap: xpTodayCap })}
          </Text>
        ) : null}
      </View>
      <View style={[styles.coinPill, dir.row]} accessibilityLabel={t('wardrobe.coins', { n: coins })}>
        <Animated.View pointerEvents="none" style={[styles.ring, ringStyle]} />
        <View style={styles.disc} />
        <CoinCount value={coins} />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { flexDirection: 'row', alignItems: 'center', gap: 16 },
  left: { flex: 1, gap: 7 },
  row: { flexDirection: 'row', alignItems: 'baseline', gap: 10 },
  levelDisc: {
    width: 64,
    height: 64,
    borderRadius: 32,
    borderWidth: 3,
    borderColor: GOLD,
    backgroundColor: 'rgba(20,26,51,0.55)',
    justifyContent: 'center',
    alignItems: 'center',
    shadowColor: GOLD,
    shadowOpacity: 0.5,
    shadowRadius: 12,
    shadowOffset: { width: 0, height: 0 },
    elevation: 6,
  },
  levelNum: { fontFamily: fonts.ui, fontSize: 34, lineHeight: 40, fontWeight: '700', color: GOLD, textAlign: 'center' },
  oldLevel: { position: 'absolute', left: 0, right: 0, top: 0, bottom: 0, textAlign: 'center' },
  label: { fontFamily: fonts.ui, fontSize: 13, color: tide.textDim },
  xp: { fontFamily: fonts.ui, fontSize: 13, color: tide.textDim },
  coinPill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 7,
    height: 44,
    paddingHorizontal: 13,
    borderRadius: 22,
    backgroundColor: 'rgba(20,26,51,0.55)',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.10)',
  },
  ring: { position: 'absolute', left: 0, right: 0, top: 0, bottom: 0, borderRadius: 22, borderWidth: 2, borderColor: GOLD },
  disc: { width: 14, height: 14, borderRadius: 7, backgroundColor: GOLD, borderWidth: 1.5, borderColor: 'rgba(150,95,0,0.35)' },
  coinText: { fontFamily: fonts.ui, fontSize: 15, fontWeight: '600', color: tide.text, padding: 0, minWidth: 24 },
  track: { backgroundColor: XP_TRACK, overflow: 'hidden' },
  fill: { height: '100%', backgroundColor: GOLD },
  highlight: { height: 1, backgroundColor: XP_HIGHLIGHT },
});
