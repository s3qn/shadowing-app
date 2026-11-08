/**
 * The empty-energy moment (research/energy-support/empty, design L; motion
 * V6 "Ring follows the sheet"). A paid tap at 0 ⚡ opens a short sheet led by
 * a countdown ring: the share of the day already waited, drawn from
 * BottomSheet's own open amount, so it grows as the sheet rises and unwinds
 * under a finger. Under it what stays free, Practice as the main button and,
 * once StoreKit has the products, the Support row, which steps this sheet
 * back and hands over to support sheet F.
 *
 * `NoEnergyHost` mounts once in _layout.tsx next to ConfirmSheetHost and
 * shows the sheet for `requestEnergy()`. EnergySheet was checked: the same
 * shell, but its body is the meter, the costs and the spend, none of which
 * this moment shows, so this is a sibling on BottomSheet.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { Canvas, Circle, Path, Skia } from '@shopify/react-native-skia';
import { useRouter } from 'expo-router';
import Animated, {
  Easing,
  type SharedValue,
  useAnimatedStyle,
  useDerivedValue,
  useReducedMotion,
  useSharedValue,
  withDelay,
  withSequence,
  withSpring,
  withTiming,
} from 'react-native-reanimated';

import { BoltGlyph } from '@/components/energy-bolt';
import { Odometer } from '@/components/home/odometer';
import { PrismButton } from '@/components/prism/prism-button';
import { BottomSheet, type SheetMotion } from '@/components/sheet/bottom-sheet';
import { fonts } from '@/constants/fonts';
import type { Energy } from '@/lib/api';
import { canAfford, clearNoEnergy, refillCountdown, useEnergy, useMinute, useNoEnergy } from '@/lib/energy';
import { useDir, useT } from '@/lib/i18n';
import { openSupportSheet, useIapReady } from '@/lib/iap';

const RING = 132;
const STROKE = 8;
const RING_COLOUR = '#7CC8FF';
const TRACK = 'rgba(255,255,255,0.14)';
const BOLT_DASH = '#8896A0';
const COUNT_H = 26;
const OUT_CUBIC = Easing.out(Easing.cubic);
const OUT_QUAD = Easing.out(Easing.quad);
const ROW_SPRING = { damping: 18, stiffness: 200 };
const CHECK_SPRING = { damping: 14, stiffness: 260 };
const STACK_SPRING = { damping: 22, stiffness: 220 };
/** The step back runs this long before the sheet leaves and support sheet F rises. */
const STEP_BACK_MS = 100;
const FREE_KEYS = ['energy.empty.free.practice', 'energy.empty.free.review', 'energy.empty.free.playback'] as const;

function clamp01(raw: number) {
  'worklet';
  return Number.isFinite(raw) ? Math.min(1, Math.max(0, raw)) : 0;
}

/** Mounted once at the root; `requestEnergy()` shows the sheet. */
export function NoEnergyHost() {
  const req = useNoEnergy();
  const energy = useEnergy();
  const [open, setOpen] = useState(false);
  const shown = useRef(0);

  useEffect(() => {
    if (req && req.seq !== shown.current) {
      shown.current = req.seq;
      setOpen(true);
    }
  }, [req]);

  // The meter changed under the sheet (a pack from support sheet F, the midnight refill, a simulate key)
  // and the action is affordable now: the sheet has nothing left to say.
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (open && req && canAfford(energy, req.kind)) setOpen(false);
  }, [energy, open, req]);

  return <EnergyEmptySheet open={open} energy={energy} onClose={() => setOpen(false)} onDismissed={clearNoEnergy} />;
}

type SheetProps = { open: boolean; energy: Energy | null; onClose: () => void; onDismissed: () => void };

export function EnergyEmptySheet({ open, energy, onClose, onDismissed }: SheetProps) {
  const router = useRouter();
  // The Support row shows only once StoreKit has the products (never on web, Expo Go or Android).
  const iapReady = useIapReady();
  // The sheet's motion values, handed over once on mount: state for the body's render, and the same
  // object in a ref for the handlers, which write `stepBack` (a write through state would be a mutation).
  const motionRef = useRef<SheetMotion | null>(null);
  const [motion, setMotion] = useState<SheetMotion | null>(null);
  const toPractice = useRef(false);
  const toSupport = useRef(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // The countdown is read once a minute while the sheet is open, and fresh on open.
  const now = useMinute(open) * 60_000;

  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );

  const onProgress = (handed: SheetMotion) => {
    motionRef.current = handed;
    setMotion(handed);
  };

  const onPractice = () => {
    if (toPractice.current || toSupport.current) return;
    toPractice.current = true;
    onClose();
  };

  // V6: the panel steps back (scale 0.96, 10 pt up) and support sheet F takes over. iOS shows one
  // RN Modal at a time (the EnergySheet hand-off has the same shape), so this sheet leaves first and
  // F opens in onDismissed.
  const onSupport = () => {
    if (toPractice.current || toSupport.current) return;
    toSupport.current = true;
    const motion = motionRef.current;
    if (motion) motion.stepBack.value = withSpring(1, STACK_SPRING);
    timer.current = setTimeout(onClose, STEP_BACK_MS);
  };

  const dismissed = () => {
    const practice = toPractice.current;
    const support = toSupport.current;
    toPractice.current = false;
    toSupport.current = false;
    const motion = motionRef.current;
    if (motion) motion.stepBack.value = 0;
    onDismissed();
    // Home lists the saved islands; from record.tsx this pops back to it, on Home it is a no-op.
    if (practice) router.navigate('/(tabs)');
    else if (support) openSupportSheet();
  };

  return (
    <BottomSheet open={open} onClose={onClose} onDismissed={dismissed} onProgress={onProgress} title="">
      {motion ? <EmptyBody open={open} motion={motion} energy={energy} now={now} showSupport={iapReady} onPractice={onPractice} onSupport={onSupport} /> : null}
    </BottomSheet>
  );
}

/** A row's entrance: fades in and rises 10 pt. */
function useRise(v: SharedValue<number>) {
  return useAnimatedStyle(() => {
    const s = clamp01(v.value);
    return { opacity: s, transform: [{ translateY: (1 - s) * 10 }] };
  });
}

/** A check's pop: from 0.6 scale, fading in. */
function usePop(v: SharedValue<number>) {
  return useAnimatedStyle(() => {
    const s = clamp01(v.value);
    return { opacity: s, transform: [{ scale: 0.6 + 0.4 * s }] };
  });
}

type BodyProps = {
  open: boolean;
  motion: SheetMotion;
  energy: Energy | null;
  now: number;
  showSupport: boolean;
  onPractice: () => void;
  onSupport: () => void;
};

/** The sheet's content, mounted with the Modal, so every motion value starts fresh on each open. */
function EmptyBody({ open, motion, energy, now, showSupport, onPractice, onSupport }: BodyProps) {
  const { t } = useT();
  const dir = useDir();
  const reduced = useReducedMotion();
  const { progress, drag, panelHeight } = motion;
  const from = reduced ? 1 : 0;
  const sweep = useSharedValue(from);
  const l0 = useSharedValue(from);
  const l1 = useSharedValue(from);
  const l2 = useSharedValue(from);
  const l3 = useSharedValue(from);
  const c0 = useSharedValue(from);
  const c1 = useSharedValue(from);
  const c2 = useSharedValue(from);
  const chev = useSharedValue(0);
  const { h, m, waited } = refillCountdown(energy?.refill_at, now);
  // The Odometers mount at 0 and get the real time 200 ms in, so they play their built roll once;
  // the minute ticks after that go down, which Odometer shows at once.
  const [rolled, setRolled] = useState(reduced);
  useEffect(() => {
    const id = setTimeout(() => setRolled(true), reduced ? 0 : 200);
    return () => clearTimeout(id);
  }, [reduced]);

  useEffect(() => {
    const rows = [l0, l1, l2, l3];
    const checks = [c0, c1, c2];
    // Reduced motion: everything in place, the ring stands at the waited share; BottomSheet fades the panel.
    if (reduced) {
      [...rows, ...checks, sweep].forEach((v) => {
        v.value = 1;
      });
      return;
    }
    if (!open) {
      // Close: the rows fade back out together; the ring unwinds with the panel on its own.
      rows.forEach((v) => {
        v.value = withTiming(0, { duration: 120, easing: OUT_QUAD });
      });
      return;
    }
    // Every value retargets from where it is, so a reopen mid-close picks up from there.
    sweep.value = withDelay(120, withTiming(1, { duration: 620, easing: OUT_CUBIC }));
    rows.forEach((v, i) => {
      v.value = withDelay(60 + 40 * i, withSpring(1, ROW_SPRING));
    });
    checks.forEach((v, i) => {
      v.value = withDelay(320 + 60 * i, withSpring(1, CHECK_SPRING));
    });
    // The support row's chevron nudges 3 pt once, then never again.
    chev.value = withDelay(1100, withSequence(withTiming(1, { duration: 160, easing: OUT_QUAD }), withSpring(0, { damping: 12, stiffness: 220 })));
  }, [open, reduced, sweep, l0, l1, l2, l3, c0, c1, c2, chev]);

  // The ring is the time already waited: its sweep, scaled by how open the sheet is, less the share a
  // finger has pulled it down. All on the UI thread, nothing per frame on JS.
  const ringEnd = useDerivedValue(() => {
    const p = clamp01(progress.value);
    const height = panelHeight.value;
    const pulled = height > 0 ? clamp01(1 - drag.value / height) : 1;
    return waited * clamp01(sweep.value) * p * pulled;
  }, [waited]);

  // Built per mount, not at import: Skia is not loaded when the web static export imports this module.
  const ringPath = useMemo(() => {
    try {
      const p = Skia.Path.Make();
      p.addArc(Skia.XYWHRect(STROKE / 2, STROKE / 2, RING - STROKE, RING - STROKE), -90, 359.99);
      return p;
    } catch {
      return null;
    }
  }, []);

  const r0 = useRise(l0);
  const r1 = useRise(l1);
  const r2 = useRise(l2);
  const r3 = useRise(l3);
  const pops = [usePop(c0), usePop(c1), usePop(c2)];
  const sign = dir.rtl ? -1 : 1;
  const chevStyle = useAnimatedStyle(() => ({
    transform: [{ translateX: 3 * chev.value * sign }, { scaleX: sign }],
  }));

  const time = h > 0 ? `${h}h ${m}m` : `${m}m`;

  return (
    <View style={styles.body}>
      <Animated.View style={[styles.lead, r0]} accessibilityLabel={t('energy.sheet.refill', { time })}>
        <View style={styles.ringBox}>
          <Canvas style={styles.ring} pointerEvents="none">
            <Circle cx={RING / 2} cy={RING / 2} r={(RING - STROKE) / 2} style="stroke" strokeWidth={STROKE} color={TRACK} />
            {ringPath ? <Path path={ringPath} style="stroke" strokeWidth={STROKE} color={RING_COLOUR} start={0} end={ringEnd} /> : null}
          </Canvas>
          <View style={styles.kin}>
            <BoltGlyph size={22} color={BOLT_DASH} dashed />
            <View style={styles.countdown}>
              {h > 0 ? (
                <>
                  <Odometer value={rolled ? h : 0} reducedMotion={reduced} textStyle={styles.count} h={COUNT_H} />
                  <Text style={styles.count}>h </Text>
                </>
              ) : null}
              <Odometer value={rolled ? m : 0} reducedMotion={reduced} textStyle={styles.count} h={COUNT_H} />
              <Text style={styles.count}>m</Text>
            </View>
          </View>
        </View>
        <Text style={[styles.note, dir.writing]}>{t('energy.empty.refill')}</Text>
      </Animated.View>
      <Animated.View style={[styles.free, r1]}>
        {FREE_KEYS.map((key, i) => (
          <View key={key} style={[styles.frow, dir.row]}>
            <Animated.View style={[styles.ck, pops[i]]}>
              <Text style={styles.ckText}>✓</Text>
            </Animated.View>
            <Text style={[styles.frowText, dir.text]}>{t(key)}</Text>
          </View>
        ))}
      </Animated.View>
      <Animated.View style={[styles.cta, r2]}>
        <PrismButton shape="pill" verb="speak" on height={50} label={t('energy.empty.practice')} fitLabel onPress={onPractice} accessibilityRole="button" containerStyle={styles.stretch} />
      </Animated.View>
      {showSupport ? (
        <Animated.View style={r3}>
          <Pressable onPress={onSupport} accessibilityRole="button" style={({ pressed }) => [styles.support, dir.row, pressed && styles.pressed]}>
            <Text style={[styles.supportText, dir.writing]}>{`${t('energy.getMore')} · ${t('energy.getMoreSub')}`}</Text>
            <Animated.Text style={[styles.chev, chevStyle]}>›</Animated.Text>
          </Pressable>
        </Animated.View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  body: { alignSelf: 'stretch', marginTop: 2 },
  lead: { alignItems: 'center', marginBottom: 10 },
  ringBox: { width: RING, height: RING, alignItems: 'center', justifyContent: 'center' },
  ring: { position: 'absolute', top: 0, left: 0, width: RING, height: RING },
  kin: { alignItems: 'center', gap: 6, paddingHorizontal: 14 },
  // The time reads left to right in every language, like the chip's number.
  countdown: { flexDirection: 'row', alignItems: 'center', direction: 'ltr' },
  count: { fontFamily: fonts.ui, fontSize: 22, fontWeight: '700', color: '#FFFFFF', fontVariant: ['tabular-nums'] },
  note: { fontFamily: fonts.ui, fontSize: 15, lineHeight: 22, color: '#CFD8DE', textAlign: 'center', marginTop: 10 },
  free: { paddingVertical: 8, paddingHorizontal: 14, borderRadius: 16, backgroundColor: 'rgba(255,255,255,0.05)' },
  frow: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingVertical: 5 },
  frowText: { fontFamily: fonts.ui, fontSize: 15, color: '#E3EAEE', flexShrink: 1 },
  ck: { width: 20, height: 20, borderRadius: 10, backgroundColor: 'rgba(124,200,255,0.18)', alignItems: 'center', justifyContent: 'center' },
  ckText: { fontFamily: fonts.ui, fontSize: 12, lineHeight: 14, fontWeight: '700', color: RING_COLOUR },
  cta: { marginTop: 14 },
  stretch: { alignSelf: 'stretch' },
  support: {
    marginTop: 10,
    height: 46,
    borderRadius: 23,
    backgroundColor: 'rgba(255,255,255,0.07)',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.1)',
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    paddingHorizontal: 16,
  },
  pressed: { opacity: 0.7 },
  supportText: { fontFamily: fonts.ui, fontSize: 15, color: '#CFD8DE', flexShrink: 1 },
  chev: { fontSize: 20, lineHeight: 24, color: '#9FB0BB' },
});
