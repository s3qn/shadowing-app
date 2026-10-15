import { useEffect, useMemo, useState } from 'react';
import { StyleSheet, Text, View, useWindowDimensions } from 'react-native';
import Animated, {
  Easing,
  cancelAnimation,
  runOnJS,
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
  withDelay,
  withSpring,
  withTiming,
} from 'react-native-reanimated';

import { CatAvatar } from '@/components/cat/cat-avatar';
import { PrismButton } from '@/components/prism';
import { fonts } from '@/constants/fonts';
import { tide } from '@/constants/theme';
import { useT } from '@/lib/i18n';
import { clearLevelUp, type PendingLevelUp } from '@/lib/level-up-store';
import { equippedArt, useProgressCache } from '@/lib/progression';

const GOLD = '#FFC857';
const WATER = '#3C78C8';
const OUT_MS = 220;
const EASE = Easing.bezier(0.2, 0.8, 0.2, 1);
const SPRING = { damping: 11, stiffness: 150 } as const;
const NUM = 72;
const CAT = 200;
// Static gold stars as fractions of the screen (x, y), from the design.
const STARS: [number, number][] = [
  [0.15, 0.24], [0.85, 0.27], [0.23, 0.45], [0.79, 0.47], [0.51, 0.14],
  [0.1, 0.38], [0.9, 0.4], [0.38, 0.2], [0.64, 0.19],
];

/** Mounts at t0 and animates everything off it. Tap Continue retargets to the exit. */
export function LevelUpModal({ levelUp }: { levelUp: PendingLevelUp }) {
  const { t } = useT();
  const reduced = useReducedMotion();
  const { width, height } = useWindowDimensions();
  const { progress, catalog } = useProgressCache();
  const [leaving, setLeaving] = useState(false);
  const equipped = useMemo(() => (progress && catalog ? equippedArt(progress, catalog) : {}), [progress, catalog]);

  const scrim = useSharedValue(0);
  const water = useSharedValue(0);
  const line = useSharedValue(0);
  const cat = useSharedValue(0);
  const ring = useSharedValue(0);
  const kicker = useSharedValue(0);
  const numeral = useSharedValue(0);
  const roll = useSharedValue(reduced ? 1 : 0);
  const coinsV = useSharedValue(0);
  const cta = useSharedValue(0);
  const settle = useSharedValue(0);

  useEffect(() => {
    const fade = (d: number) => withDelay(d, withTiming(1, { duration: 200, easing: Easing.linear }));
    if (reduced) {
      [scrim, water, line, cat, kicker, numeral, coinsV, cta].forEach((v) => (v.value = fade(0)));
      return;
    }
    const out = { duration: 250, easing: EASE };
    scrim.value = withTiming(1, { duration: 200, easing: Easing.linear });
    line.value = withTiming(1, { duration: 350, easing: EASE });
    water.value = withTiming(1, { duration: 400, easing: EASE });
    cat.value = withSpring(1, SPRING);
    ring.value = withDelay(380, withTiming(1, { duration: 700, easing: Easing.out(Easing.quad) }));
    kicker.value = withDelay(100, withTiming(1, out));
    numeral.value = withDelay(180, withSpring(1, { damping: 12, stiffness: 170 }));
    roll.value = withDelay(360, withSpring(1, { damping: 14, stiffness: 150 }));
    coinsV.value = withDelay(260, withTiming(1, out));
    cta.value = withDelay(320, withTiming(1, { duration: 300, easing: EASE }));
  }, [reduced, scrim, water, line, cat, ring, kicker, numeral, roll, coinsV, cta]);

  const leave = () => {
    if (leaving) return;
    setLeaving(true);
    [water, line, cat, ring, kicker, numeral, coinsV, cta].forEach(cancelAnimation);
    const d = reduced ? 200 : OUT_MS;
    [water, line, cat, kicker, numeral, coinsV, cta].forEach((v) => (v.value = withTiming(0, { duration: d, easing: EASE })));
    ring.value = 0;
    settle.value = withTiming(1, { duration: d, easing: EASE });
    scrim.value = withTiming(0, { duration: d, easing: Easing.linear }, (done) => {
      if (done) runOnJS(clearLevelUp)();
    });
  };

  const waterY = height * 0.5;
  const rise = (v: typeof cat, from: number) => ({
    opacity: Math.min(1, v.value),
    transform: [{ translateY: (1 - v.value) * from }],
  });
  const scrimStyle = useAnimatedStyle(() => ({ opacity: scrim.value }));
  const waterStyle = useAnimatedStyle(() => ({ opacity: water.value }));
  const lineStyle = useAnimatedStyle(() => ({ opacity: line.value, transform: [{ scaleX: line.value }] }));
  const catStyle = useAnimatedStyle(() => ({
    opacity: Math.min(1, cat.value),
    transform: [{ translateY: reduced ? 0 : (1 - cat.value) * 56 + settle.value * 16 }],
  }));
  const ringStyle = useAnimatedStyle(() => ({
    opacity: 0.7 * (1 - ring.value),
    transform: [{ scale: 0.3 + 1.6 * ring.value }],
  }));
  const kickerStyle = useAnimatedStyle(() => rise(kicker, reduced ? 0 : 16));
  const numStyle = useAnimatedStyle(() => ({
    opacity: Math.min(1, numeral.value),
    transform: [{ scale: reduced ? 1 : 0.86 + 0.14 * numeral.value }],
  }));
  const coinStyle = useAnimatedStyle(() => rise(coinsV, reduced ? 0 : 16));
  const ctaStyle = useAnimatedStyle(() => rise(cta, reduced ? 0 : 16));
  // The digit column holds N-1 above N in a 1em clip; it slides up one row.
  const colStyle = useAnimatedStyle(() => ({ transform: [{ translateY: -NUM * roll.value }] }));

  return (
    <View style={StyleSheet.absoluteFill} pointerEvents="auto" accessibilityViewIsModal>
      <Animated.View style={[StyleSheet.absoluteFill, styles.scrim, scrimStyle]} />
      <Animated.View style={[styles.water, { top: waterY }, waterStyle]} />
      <Animated.View style={[styles.line, { top: waterY }, lineStyle]} />
      {STARS.map(([x, y], i) => (
        <View key={i} style={[styles.star, { left: x * width, top: y * height }]} />
      ))}
      <Animated.View style={[styles.ring, { top: waterY - 12, left: width / 2 - 60 }, ringStyle]} />
      <Animated.View style={[styles.cat, { top: waterY - CAT * 1.1, width }, catStyle]}>
        <CatAvatar size={CAT} equipped={equipped} />
      </Animated.View>
      <View style={[styles.text, { top: waterY + 74 }]}>
        <Animated.Text style={[styles.kicker, kickerStyle]}>{t('levelUp.kicker').toUpperCase()}</Animated.Text>
        {levelUp.level > 1 ? (
          <Animated.View style={[styles.numRow, numStyle]} accessible accessibilityLabel={t('levelUp.level', { n: levelUp.level })}>
            <Text style={styles.num}>{t('levelUp.level', { n: '' }).trim()} </Text>
            <View style={styles.clip}>
              <Animated.View style={colStyle}>
                <Text style={[styles.num, styles.digit]}>{levelUp.prevLevel}</Text>
                <Text style={[styles.num, styles.digit]}>{levelUp.level}</Text>
              </Animated.View>
            </View>
          </Animated.View>
        ) : null}
        {levelUp.coins > 0 ? (
          <Animated.View style={[styles.coinRow, coinStyle]}>
            <View style={styles.coinDot} />
            <Text style={styles.coinText}>{t('levelUp.coins', { n: levelUp.coins })}</Text>
          </Animated.View>
        ) : null}
      </View>
      <Animated.View style={[styles.cta, ctaStyle]}>
        <PrismButton shape="pill" verb="tools" on width={width - 48} height={56} label={t('levelUp.continue')} onPress={leave} />
      </Animated.View>
    </View>
  );
}

const styles = StyleSheet.create({
  scrim: { backgroundColor: 'rgba(5,8,16,0.82)' },
  water: { position: 'absolute', left: 0, right: 0, bottom: 0, backgroundColor: 'rgba(60,120,200,0.10)' },
  line: {
    position: 'absolute',
    left: 0,
    right: 0,
    height: 1,
    backgroundColor: 'rgba(124,200,255,0.8)',
    shadowColor: WATER,
    shadowOpacity: 0.9,
    shadowRadius: 12,
    shadowOffset: { width: 0, height: 0 },
  },
  star: {
    position: 'absolute',
    width: 4,
    height: 4,
    borderRadius: 2,
    backgroundColor: GOLD,
    opacity: 0.85,
    shadowColor: GOLD,
    shadowOpacity: 1,
    shadowRadius: 5,
    shadowOffset: { width: 0, height: 0 },
  },
  ring: {
    position: 'absolute',
    width: 120,
    height: 24,
    borderRadius: 60,
    borderWidth: 2,
    borderColor: 'rgba(124,200,255,0.7)',
  },
  cat: { position: 'absolute', alignItems: 'center' },
  text: { position: 'absolute', left: 0, right: 0, alignItems: 'center', gap: 8 },
  kicker: { fontFamily: fonts.uiMedium, fontSize: 13, fontWeight: '600', letterSpacing: 2.4, color: GOLD },
  numRow: { flexDirection: 'row', alignItems: 'flex-start', height: NUM },
  clip: { height: NUM, overflow: 'hidden' },
  num: {
    fontFamily: fonts.ui,
    fontSize: NUM,
    fontWeight: '800',
    letterSpacing: -2,
    color: GOLD,
    textShadowColor: 'rgba(255,200,87,0.35)',
    textShadowRadius: 18,
    textShadowOffset: { width: 0, height: 0 },
  },
  digit: { height: NUM, lineHeight: NUM },
  coinRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  coinDot: { width: 12, height: 12, borderRadius: 6, backgroundColor: GOLD },
  coinText: { fontFamily: fonts.uiMedium, fontSize: 17, fontWeight: '600', color: tide.text },
  cta: { position: 'absolute', left: 24, right: 24, bottom: 48, alignItems: 'center' },
});
