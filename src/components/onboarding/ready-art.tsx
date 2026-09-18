/**
 * The two pieces the ready screen (artifact `s12`) adds around its copy: the
 * "Your first island" placeholder card with its ladder pips, and the confetti
 * drifting down behind everything.
 *
 * The confetti is eight plain Views on one looping translate each, no blur
 * and no per-frame JS: the whole loop runs on the UI thread. Reduced motion
 * drops it rather than freezing pieces mid-screen.
 */

import { useEffect } from 'react';
import { StyleSheet, Text, View, useWindowDimensions, type DimensionValue } from 'react-native';
import Animated, {
  Easing,
  cancelAnimation,
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
  withDelay,
  withRepeat,
  withTiming,
} from 'react-native-reanimated';

import { fonts } from '@/constants/fonts';
import { Radius, Spacing, tide, verb, withAlpha } from '@/constants/theme';
import { useDir, useT } from '@/lib/i18n';

const PIPS = 6;
const FALL_MS = 5200;

const PIECES = [
  { left: '4%', colour: verb.listen.c1 },
  { left: '16%', colour: verb.speak.c1 },
  { left: '28%', colour: verb.read.c1 },
  { left: '40%', colour: tide.pos.verb },
  { left: '52%', colour: verb.listen.c2 },
  { left: '64%', colour: verb.speak.c2 },
  { left: '76%', colour: verb.read.c1 },
  { left: '88%', colour: verb.listen.c1 },
] as const;

function Piece({ left, colour, delay, fall }: { left: DimensionValue; colour: string; delay: number; fall: number }) {
  const y = useSharedValue(0);
  useEffect(() => {
    y.value = withDelay(delay, withRepeat(withTiming(1, { duration: FALL_MS, easing: Easing.linear }), -1));
    // The loop never ends on its own, so leaving the ready screen has to stop
    // it: an unstopped repeat keeps ticking on the UI thread after unmount.
    return () => cancelAnimation(y);
  }, [delay, y]);
  const style = useAnimatedStyle(() => ({
    transform: [{ translateY: y.value * fall }],
  }));
  return <Animated.View style={[styles.piece, { left, backgroundColor: colour }, style]} />;
}

/** The drifting confetti, behind the ready screen's copy. */
export function Confetti() {
  const { height } = useWindowDimensions();
  const reducedMotion = useReducedMotion();
  if (reducedMotion) return null;
  return (
    <View pointerEvents="none" style={styles.confetti}>
      {PIECES.map((piece, i) => (
        <Piece key={piece.left} left={piece.left} colour={piece.colour} delay={i * 620} fall={height + 24} />
      ))}
    </View>
  );
}

/** The placeholder card standing in for the island the learner is about to
 * record, with the ladder pips under it. */
export function FirstIslandCard() {
  const { t } = useT();
  const dir = useDir();
  return (
    <View style={styles.card}>
      <Text style={[styles.cardTitle, dir.text]}>{t('settings.onboarding.firstIsland')}</Text>
      <Text style={[styles.cardHint, dir.text]}>{t('settings.onboarding.firstIslandHint')}</Text>
      <View style={[styles.pips, dir.row]}>
        {Array.from({ length: PIPS }, (_, i) => (
          <View key={i} style={[styles.pip, { opacity: 0.45 + i * 0.09 }]} />
        ))}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  confetti: {
    position: 'absolute',
    top: -12,
    left: 0,
    right: 0,
    bottom: 0,
    overflow: 'hidden',
  },
  piece: {
    position: 'absolute',
    top: 0,
    width: 6,
    height: 10,
    borderRadius: 2,
    opacity: 0.9,
  },
  card: {
    gap: 2,
    padding: Spacing.md,
    borderRadius: Radius.lg,
    borderWidth: 1,
    borderColor: tide.waterline,
    backgroundColor: tide.water,
  },
  cardTitle: {
    fontSize: 15,
    fontWeight: '600',
    color: tide.text,
    fontFamily: fonts.uiMedium,
  },
  cardHint: { fontSize: 13, color: tide.textDim, fontFamily: fonts.ui },
  pips: { flexDirection: 'row', gap: 5, marginTop: Spacing.sm },
  pip: { width: 7, height: 11, borderRadius: 3, backgroundColor: verb.read.c1 },
});

/** The soft red halo behind the record button, the artifact's glow under its
 * big mic. */
export function RecordGlow({ size }: { size: number }) {
  return (
    <View
      pointerEvents="none"
      style={{
        position: 'absolute',
        width: size,
        height: size,
        borderRadius: size / 2,
        backgroundColor: withAlpha(tide.record, 0.18),
      }}
    />
  );
}
