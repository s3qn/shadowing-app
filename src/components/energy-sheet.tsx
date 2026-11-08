/**
 * The energy sheet Home's chip opens (board-energy card A, "Tap opens"): the
 * meter as the lead, when the day refills, what the three paid actions cost,
 * what is free, what was spent today and, once StoreKit has the products, the
 * "Support the developer" row. The same BottomSheet shell as StreakSheet with
 * its own body, so a sibling of it rather than a mode.
 *
 * Open motion is V9 of research/energy-support/motion-sheet/recipe.md: the
 * rows slide 18 pt in from the start edge 45 ms apart, then the Spent today
 * bar builds (the spent part grows, Left fills in the V7 refill order) with
 * each legend item after its segment.
 */
import { useEffect, useRef } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import Animated, { Easing, type SharedValue, useAnimatedStyle, useReducedMotion, useSharedValue, withDelay, withSpring, withTiming } from 'react-native-reanimated';

import { BoltGlyph, EnergyMeter } from '@/components/energy-bolt';
import { BottomSheet } from '@/components/sheet/bottom-sheet';
import { SheetAction } from '@/components/sheet/sheet-rows';
import { fonts } from '@/constants/fonts';
import type { Energy } from '@/lib/api';
import { priceOf, untilRefill, useMinute, type EnergyKind } from '@/lib/energy';
import { useDir, useT } from '@/lib/i18n';
import { openSupportSheet, useIapReady } from '@/lib/iap';

const KINDS: EnergyKind[] = ['create', 'regenerate', 'import'];
const KIND_COLOUR: Record<EnergyKind, string> = { create: '#7CC8FF', regenerate: '#A58BFF', import: '#FFC857' };
const LEFT_COLOUR = '#FFC857';
const COST_KEY = { create: 'energy.cost.create', regenerate: 'energy.cost.regenerate', import: 'energy.cost.import' } as const;
const SPENT_KEY = { create: 'energy.spent.create', regenerate: 'energy.spent.regenerate', import: 'energy.spent.import' } as const;
const EMPTY_SPENT: Energy['spent_today'] = { units: 0, by_kind: {} };

/** V9: how far a row slides in, and the curves of the bar build. */
const ROW_SLIDE = 18;
const OUT_CUBIC = Easing.out(Easing.cubic);
const OUT_QUAD = Easing.out(Easing.quad);

type Props = {
  open: boolean;
  onClose: () => void;
  energy: Energy | null;
  /** What the Support row opens once this sheet has left. Defaults to the support sheet (support-packs). */
  onSupport?: () => void;
};

export function EnergySheet({ open, onClose, energy, onSupport = openSupportSheet }: Props) {
  const { t } = useT();
  // support-packs: the Support row shows only once StoreKit has the products (never on web, Expo Go or Android).
  const iapReady = useIapReady();
  // The Support row closes this sheet first and opens the next one in `onDismissed`:
  // a Modal opened over a closing Modal never shows on iOS (streak-sheet.tsx).
  const toSupport = useRef(false);
  const onSupportRow = () => {
    toSupport.current = true;
    onClose();
  };
  const onDismissed = () => {
    if (!toSupport.current) return;
    toSupport.current = false;
    onSupport();
  };
  // The refill countdown is read once a minute while the sheet is open, and fresh on open.
  const now = useMinute(open) * 60_000;

  return (
    <BottomSheet open={open} onClose={onClose} onDismissed={onDismissed} title={t('energy.sheet.title')}>
      {energy ? <EnergyBody open={open} energy={energy} now={now} showSupport={iapReady} onSupport={onSupportRow} /> : null}
    </BottomSheet>
  );
}

/** One row's V9 entrance: opacity and a slide from the start edge (`sign` 1 from the left, -1 from the right in RTL). */
function useRowStyle(v: SharedValue<number>, sign: number) {
  return useAnimatedStyle(() => {
    const raw = v.value;
    const s = Number.isFinite(raw) ? raw : 1;
    return { opacity: Math.min(1, Math.max(0, s)), transform: [{ translateX: -(1 - s) * ROW_SLIDE * sign }] };
  });
}

/** A bar segment growing from the bar's left edge (the bar reads left to right in every language). */
function useGrowStyle(v: SharedValue<number>) {
  return useAnimatedStyle(() => {
    const raw = v.value;
    const s = Number.isFinite(raw) ? raw : 1;
    return { transform: [{ scaleX: Math.min(1.02, Math.max(0, s)) }] };
  });
}

function useFadeStyle(v: SharedValue<number>) {
  return useAnimatedStyle(() => {
    const raw = v.value;
    return { opacity: Number.isFinite(raw) ? Math.min(1, Math.max(0, raw)) : 1 };
  });
}

type BodyProps = { open: boolean; energy: Energy; now: number; showSupport: boolean; onSupport: () => void };

/** The sheet's content, mounted with the Modal, so every motion value starts fresh on each open. */
function EnergyBody({ open, energy, now, showSupport, onSupport }: BodyProps) {
  const { t } = useT();
  const dir = useDir();
  const reduced = useReducedMotion();
  const from = reduced ? 1 : 0;
  const row0 = useSharedValue(from);
  const row1 = useSharedValue(from);
  const row2 = useSharedValue(from);
  const row3 = useSharedValue(from);
  const row4 = useSharedValue(from);
  const seg0 = useSharedValue(from);
  const seg1 = useSharedValue(from);
  const seg1Ghost = useSharedValue(from);
  const leg0 = useSharedValue(from);
  const leg1 = useSharedValue(from);

  useEffect(() => {
    const rows = [row0, row1, row2, row3, row4];
    const all = [...rows, seg0, seg1, seg1Ghost, leg0, leg1];
    // Reduced motion: rows and bar in place; BottomSheet fades the panel.
    if (reduced) {
      all.forEach((v) => {
        v.value = 1;
      });
      return;
    }
    if (!open) {
      // Close: the rows fade back out together; a half-built bar leaves with the panel.
      rows.forEach((v) => {
        v.value = withTiming(0, { duration: 120, easing: OUT_QUAD });
      });
      return;
    }
    // Every value retargets from where it is, so a reopen mid-close picks up from there.
    rows.forEach((v, i) => {
      v.value = withDelay(40 + 45 * i, withSpring(1, { damping: 20, stiffness: 220 }));
    });
    seg0.value = withDelay(300, withTiming(1, { duration: 260, easing: OUT_CUBIC }));
    leg0.value = withDelay(420, withTiming(1, { duration: 160, easing: OUT_QUAD }));
    // Left is V7's refill: the pale part leads, the solid follows on a spring.
    seg1Ghost.value = withDelay(460, withTiming(1, { duration: 220, easing: OUT_CUBIC }));
    seg1.value = withDelay(580, withSpring(1, { damping: 18, stiffness: 180 }));
    leg1.value = withDelay(640, withTiming(1, { duration: 160, easing: OUT_QUAD }));
  }, [open, reduced, row0, row1, row2, row3, row4, seg0, seg1, seg1Ghost, leg0, leg1]);

  const sign = dir.rtl ? -1 : 1;
  const r0 = useRowStyle(row0, sign);
  const r1 = useRowStyle(row1, sign);
  const r2 = useRowStyle(row2, sign);
  const r3 = useRowStyle(row3, sign);
  const r4 = useRowStyle(row4, sign);
  const spentGrow = useGrowStyle(seg0);
  const leftGrow = useGrowStyle(seg1);
  const ghostGrow = useGrowStyle(seg1Ghost);
  // The pale part shows only while it leads the solid fill.
  const ghostShow = useAnimatedStyle(() => {
    const g = seg1Ghost.value;
    const s = seg1.value;
    return { opacity: Number.isFinite(g) && Number.isFinite(s) && g > s + 0.002 ? 0.35 : 0 };
  });
  const lg0 = useFadeStyle(leg0);
  const lg1 = useFadeStyle(leg1);

  // An older server sends no `spent_today`: read it as nothing spent.
  const spent = energy.spent_today ?? EMPTY_SPENT;
  const spentKinds = KINDS.filter((k) => (spent.by_kind[k] ?? 0) > 0);
  const left = Math.max(0, energy.daily_left + energy.granted_left);
  // `by_kind` holds units; the legend counts items at today's price.
  const legend = spentKinds.map((k) => t(SPENT_KEY[k], { n: Math.max(1, Math.round((spent.by_kind[k] ?? 0) / priceOf(energy, k))) })).join(', ');

  return (
    <View style={styles.body}>
      <Animated.View style={[styles.lead, r0]}>
        <EnergyMeter variant="sheet" left={left} max={energy.daily_max} />
      </Animated.View>
      <Animated.View style={[styles.refill, dir.row, r1]}>
        <View style={styles.dot} />
        <Text style={[styles.refillText, dir.text]}>{t('energy.sheet.refill', { time: untilRefill(energy.refill_at, now) })}</Text>
      </Animated.View>
      <Animated.View style={r2}>
        <Text style={[styles.sec, dir.text]}>{t('energy.sheet.costs')}</Text>
        <View style={[styles.grid, dir.row]}>
          {KINDS.map((k) => (
            <View key={k} style={[styles.cost, dir.row]}>
              <Text style={styles.costLabel}>{t(COST_KEY[k])}</Text>
              <View style={[styles.price, dir.row]}>
                <Text style={styles.priceNum}>{priceOf(energy, k)}</Text>
                <BoltGlyph size={12} color="#FFFFFF" />
              </View>
            </View>
          ))}
        </View>
        <Text style={[styles.free, dir.text]}>{t('energy.sheet.free')}</Text>
      </Animated.View>
      <Animated.View style={r3}>
        <View style={[styles.secRow, dir.row]}>
          <Text style={styles.sec}>{t('energy.sheet.spent')}</Text>
          <Text style={styles.total}>{spent.units}</Text>
        </View>
        {spent.units > 0 ? (
          <>
            <View style={styles.stack}>
              {spentKinds.map((k) => (
                <View key={k} style={[styles.seg, { flex: spent.by_kind[k] ?? 0 }]}>
                  <Animated.View style={[styles.segFill, { backgroundColor: KIND_COLOUR[k] }, spentGrow]} />
                </View>
              ))}
              {left > 0 ? (
                <View style={[styles.seg, { flex: left }]}>
                  <Animated.View style={[styles.segFill, { backgroundColor: LEFT_COLOUR }, ghostGrow, ghostShow]} />
                  <Animated.View style={[styles.segFill, { backgroundColor: LEFT_COLOUR }, leftGrow]} />
                </View>
              ) : null}
            </View>
            <View style={[styles.legendRow, dir.row]}>
              <Animated.Text style={[styles.legend, dir.text, lg0]}>{legend}</Animated.Text>
              {left > 0 ? <Animated.Text style={[styles.legend, dir.text, lg1]}>{t('energy.spent.left', { n: left })}</Animated.Text> : null}
            </View>
          </>
        ) : (
          <Text style={[styles.legend, styles.legendAlone, dir.text]}>{t('energy.spent.none')}</Text>
        )}
      </Animated.View>
      {showSupport ? (
        <Animated.View style={[styles.action, r4]}>
          <SheetAction label={t('energy.getMore')} hint={t('energy.getMoreSub')} icon={{ ios: 'bolt.fill', android: 'bolt' }} onPress={onSupport} />
        </Animated.View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  body: { alignSelf: 'stretch', marginTop: 4 },
  lead: { paddingVertical: 12, paddingHorizontal: 14, borderRadius: 16, backgroundColor: 'rgba(255,255,255,0.05)' },
  refill: { flexDirection: 'row', alignItems: 'center', gap: 8, marginVertical: 10, marginHorizontal: 2 },
  dot: { width: 8, height: 8, borderRadius: 4, backgroundColor: '#7CC8FF' },
  refillText: { fontFamily: fonts.ui, fontSize: 14, color: '#CFD8DE', flexShrink: 1 },
  sec: { fontFamily: fonts.ui, fontSize: 12, textTransform: 'uppercase', letterSpacing: 0.72, color: '#8FA0AB', marginTop: 12, marginBottom: 6, marginHorizontal: 2 },
  secRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-end' },
  total: { fontFamily: fonts.ui, fontSize: 14, color: '#FFFFFF', marginBottom: 6, marginHorizontal: 2, fontVariant: ['tabular-nums'] },
  grid: { flexDirection: 'row', flexWrap: 'wrap', gap: 6 },
  cost: {
    width: '48.5%',
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingVertical: 7,
    paddingHorizontal: 10,
    borderRadius: 10,
    backgroundColor: 'rgba(255,255,255,0.05)',
  },
  costLabel: { fontFamily: fonts.ui, fontSize: 13, color: '#CFD8DE', flexShrink: 1 },
  price: { flexDirection: 'row', alignItems: 'center', gap: 3 },
  priceNum: { fontFamily: fonts.ui, fontSize: 13, fontWeight: '700', color: '#FFFFFF', fontVariant: ['tabular-nums'] },
  free: { fontFamily: fonts.ui, fontSize: 13, lineHeight: 18, color: '#9FB0BB', marginTop: 8, marginHorizontal: 2 },
  // The shares read left to right in every language, like the bar in the chip; the track shows while it builds.
  stack: { flexDirection: 'row', height: 8, borderRadius: 4, overflow: 'hidden', gap: 2, direction: 'ltr', backgroundColor: 'rgba(255,255,255,0.08)' },
  seg: { height: 8 },
  segFill: { position: 'absolute', top: 0, right: 0, bottom: 0, left: 0, borderRadius: 4, transformOrigin: 'left' },
  legendRow: { flexDirection: 'row', flexWrap: 'wrap', columnGap: 12, marginTop: 6, marginHorizontal: 2 },
  legend: { fontFamily: fonts.ui, fontSize: 12.5, color: '#9FB0BB' },
  legendAlone: { marginTop: 6, marginHorizontal: 2 },
  action: { marginTop: 14 },
});
