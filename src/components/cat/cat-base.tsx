import { useIsFocused } from 'expo-router';
import { useContext, useEffect, useState } from 'react';
import { AppState, StyleSheet, View } from 'react-native';
import Animated, { cancelAnimation, useAnimatedStyle, useReducedMotion, useSharedValue, withSequence, withTiming } from 'react-native-reanimated';

import { BlinkEnabled, onBlinkReset } from '@/lib/cat-blink';

import { CAT_BOX } from '@/constants/cosmetics';
import { tide, verb } from '@/constants/theme';

const FUR = '#15131C';
const RIM = 'rgba(255,255,255,0.08)';
const WHISKER = 'rgba(255,255,255,0.35)';

// Tail: four chained segments from the right hip, each tilted further.
const TAIL_ANGLES = [0, 25, 50, 80];
const SEG_W = 18;
const SEG_LEN = 34;
const TAIL_SEGMENTS = (() => {
  const out: { cx: number; cy: number; a: number }[] = [];
  let px = 156;
  let py = 208;
  for (const a of TAIL_ANGLES) {
    const r = (a * Math.PI) / 180;
    const dx = Math.sin(r);
    const dy = -Math.cos(r);
    out.push({ cx: px + (dx * SEG_LEN) / 2, cy: py + (dy * SEG_LEN) / 2, a });
    px += dx * SEG_LEN;
    py += dy * SEG_LEN;
  }
  return out;
})();

const WHISKERS = [-14, 0, 14];

/**
 * The occasional blink: eye scaleY 1 to 0.1 and back over 140ms, on a 4 to 7s
 * timer that is rescheduled once per tick (no UI-thread loop). Only where
 * BlinkEnabled, only focused and foregrounded, restarted by any equip or buy.
 */
function useBlink() {
  const enabled = useContext(BlinkEnabled);
  const focused = useIsFocused();
  const reduced = useReducedMotion();
  const [active, setActive] = useState(AppState.currentState === 'active');
  const blink = useSharedValue(1);
  useEffect(() => {
    const sub = AppState.addEventListener('change', (st) => setActive(st === 'active'));
    return () => sub.remove();
  }, []);
  useEffect(() => {
    if (!enabled || !focused || !active || reduced) return;
    let id: ReturnType<typeof setTimeout>;
    const schedule = () => {
      id = setTimeout(() => {
        blink.value = withSequence(withTiming(0.1, { duration: 70 }), withTiming(1, { duration: 70 }));
        schedule();
      }, 4000 + Math.random() * 3000);
    };
    schedule();
    const off = onBlinkReset(() => {
      clearTimeout(id);
      cancelAnimation(blink);
      blink.value = 1;
      schedule();
    });
    return () => {
      clearTimeout(id);
      off();
      cancelAnimation(blink);
      blink.value = 1;
    };
  }, [enabled, focused, active, reduced, blink]);
  return useAnimatedStyle(() => ({ transform: [{ scaleY: Number.isFinite(blink.value) ? blink.value : 1 }] }));
}

/** Option A "Round Kageneko": the placeholder cat, drawn in CAT_BOX units from plain Views. */
export function CatBase() {
  const blinkStyle = useBlink();
  return (
    <View style={styles.box} pointerEvents="none">
      <View style={styles.shadow} />
      {TAIL_SEGMENTS.map((s, i) => (
        <View
          key={i}
          style={[styles.fur, { left: s.cx - SEG_W / 2, top: s.cy - SEG_LEN / 2, width: SEG_W, height: SEG_LEN, borderRadius: SEG_W / 2, transform: [{ rotate: `${s.a}deg` }] }]}
        />
      ))}
      <View style={[styles.fur, styles.body]} />
      {[70, 130].map((cx) => (
        <View key={cx} style={[styles.fur, { left: cx - 17, top: 18, width: 34, height: 34, borderRadius: 6, transform: [{ rotate: '45deg' }] }]} />
      ))}
      <View style={[styles.fur, styles.head]} />
      {[82, 118].map((cx) => (
        <Animated.View key={cx} style={[styles.eye, { left: cx - 9 }, blinkStyle]}>
          <View style={styles.pupil} />
        </Animated.View>
      ))}
      <View style={styles.nose} />
      {[48, 152].map((cx) =>
        WHISKERS.map((deg, i) => (
          <View key={`${cx}-${i}`} style={[styles.whisker, { left: cx - 1, top: 103 + i * 7 - 13, transform: [{ rotate: `${cx < 100 ? 90 + deg : 90 - deg}deg` }] }]} />
        )),
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  box: { position: 'absolute', left: 0, top: 0, width: CAT_BOX.w, height: CAT_BOX.h },
  fur: { position: 'absolute', backgroundColor: FUR },
  shadow: { position: 'absolute', left: 40, top: 226, width: 120, height: 16, borderRadius: 8, backgroundColor: 'rgba(0,0,0,0.35)' },
  body: {
    left: 45,
    top: 120,
    width: 110,
    height: 100,
    borderTopLeftRadius: 50,
    borderTopRightRadius: 50,
    borderBottomLeftRadius: 36,
    borderBottomRightRadius: 36,
    borderTopWidth: 1,
    borderTopColor: RIM,
  },
  head: { left: 52, top: 52, width: 96, height: 96, borderRadius: 48, borderTopWidth: 1, borderTopColor: RIM },
  eye: { position: 'absolute', top: 77, width: 18, height: 22, borderRadius: 11, backgroundColor: verb.read.c1, alignItems: 'center', justifyContent: 'center', boxShadow: '0 0 12px 3px rgba(255,200,87,0.55)' },
  pupil: { width: 8, height: 8, borderRadius: 4, backgroundColor: FUR },
  nose: {
    position: 'absolute',
    left: 94,
    top: 102,
    width: 0,
    height: 0,
    borderLeftWidth: 6,
    borderRightWidth: 6,
    borderTopWidth: 6,
    borderLeftColor: 'transparent',
    borderRightColor: 'transparent',
    borderTopColor: tide.lang.ja,
  },
  whisker: { position: 'absolute', width: 2, height: 26, backgroundColor: WHISKER },
});
