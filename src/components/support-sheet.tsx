/**
 * support-packs: the "Support the developer" sheet (board-support card F).
 * Sean's note first, the packs line, three pack pills with Apple's price in a
 * tag, the trust line and Restore. One component for web and native; the only
 * platform branch is the store seam in lib/iap.ts. `SupportSheetHost` mounts
 * once in _layout.tsx and `openSupportSheet()` shows it, like the confirm
 * sheet, so no sheet is ever opened over another Modal.
 *
 * Purchase motion is V5 "The pack charges up" of
 * research/energy-support/motion-support/recipe.md: a Listen-blue wash fills
 * the tapped pill from its start edge while Apple works, fully on success,
 * drains on cancel and holds amber at half while an Ask to Buy waits.
 */
import * as Haptics from 'expo-haptics';
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import Animated, {
  Easing,
  interpolateColor,
  type SharedValue,
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
  withDelay,
  withSequence,
  withTiming,
} from 'react-native-reanimated';

import { BottomSheet } from '@/components/sheet/bottom-sheet';
import { ShimmerText } from '@/components/shimmer-text';
import { fonts } from '@/constants/fonts';
import { PACKS, type Pack } from '@/constants/iap';
import { tide, verb } from '@/constants/theme';
import { hapticNotify } from '@/lib/haptics';
import { useDir, useT } from '@/lib/i18n';
import {
  applyGrant,
  buyPack,
  closeSupportSheet,
  fetchPackPrices,
  type Grant,
  initIap,
  packPrice,
  restorePacks,
  subscribeIap,
  subscribeSupportSheet,
  supportSheetOpen,
  useIapReady,
} from '@/lib/iap';
import type { Key } from '@/locales/en';

/** A label change: the label and its tag fade out, the text swaps, they fade in (180 ms in all). */
const SWAP_MS = 90;
const DIM_MS = 180;
/** V5: the wash while Apple works, on success, on cancel, and its pending hold. */
const WASH_WORKING = 0.35;
const WASH_WORKING_MS = 1100;
const WASH_DONE_MS = 420;
const WASH_DRAIN_MS = 260;
const WASH_PENDING = 0.5;
/** The thank you lands this long after the wash starts filling; the other pills dim with it. */
const THANKS_DELAY_MS = 160;
/** The sheet closes itself 1,100 ms after the thank you; the meter plays V7 80 ms after the sheet has left. */
const CLOSE_AFTER_MS = THANKS_DELAY_MS + 1100;
const HANDOFF_MS = 80;
const CANCELLED_SHOWN_MS = 1400;
const LIMITED_SHOWN_MS = 3000;
const RESTORE_SHOWN_MS = 3000;
const DIM = 0.5;
const THANKS_DIM = 0.45;
const AMBER = '#FFE9A8';
const WASH_BLUE = 'rgba(124,200,255,0.20)';
const WASH_AMBER = 'rgba(255,200,87,0.18)';
const EASE = Easing.out(Easing.quad);
const OUT_CUBIC = Easing.out(Easing.cubic);

type Status = { key: Key; error: boolean } | null;
/** The tapped pill: Apple's sheet or the verify, an Ask to Buy wait, the thank you, paid but not yet verified,
 * just cancelled, or a test purchase over today's allowance. */
type Phase = 'buying' | 'pending' | 'thanks' | 'offline' | 'cancelled' | 'limited';
type Busy = { packId: string; phase: Phase } | null;
type Restore = 'idle' | 'busy' | 'some' | 'none';

/** Mounted once at the root; `openSupportSheet()` shows the sheet. Starts the store on mount. */
export function SupportSheetHost() {
  const open = useSyncExternalStore(subscribeSupportSheet, supportSheetOpen, supportSheetOpen);
  useEffect(() => {
    void initIap();
  }, []);
  return <SupportSheet open={open} onClose={closeSupportSheet} />;
}

export function SupportSheet({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { t, locale } = useT();
  const dir = useDir();
  const reduced = useReducedMotion();
  // From open until the Modal has left (`dismissed`): the window in which store events belong to this sheet.
  const [visible, setVisible] = useState(open);
  if (open && !visible) setVisible(true);
  const [busy, setBusy] = useState<Busy>(null);
  const [status, setStatus] = useState<Status>(null);
  const [restore, setRestore] = useState<Restore>('idle');
  const [restored, setRestored] = useState(0);
  // The grant the sheet holds until it has left, so the meter never plays under the backdrop.
  const grant = useRef<Grant | null>(null);
  const timers = useRef<ReturnType<typeof setTimeout>[]>([]);
  const cancelTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Which pill keeps full opacity and how far the rest dim. Handlers only set state;
  // the effect below is the only writer, so the UI thread never races a handler.
  const exempt = useSharedValue(-1);
  const dim = useSharedValue(1);
  // React state, like the Support rows that open this sheet: the pills and the "not available" line follow the store, not the last render.
  const ready = useIapReady();
  // A cancelled or limited pill shows its line but holds nothing: every pill can be tapped again.
  const held = busy && busy.phase !== 'cancelled' && busy.phase !== 'limited' ? busy : null;
  // -1 every pill whole (store ready, nothing held), -2 none (store unavailable), else the held pill.
  const lock = held ? PACKS.findIndex((p) => p.id === held.packId) : ready ? -1 : -2;
  const thanks = held?.phase === 'thanks';

  const later = useCallback((fn: () => void, ms: number) => {
    timers.current.push(setTimeout(fn, ms));
  }, []);

  const clearCancelled = () => {
    if (cancelTimer.current) clearTimeout(cancelTimer.current);
    cancelTimer.current = null;
  };

  useEffect(() => {
    // A launch without network left the prices empty: ask again on open.
    if (open) void fetchPackPrices();
  }, [open]);

  useEffect(() => {
    // On release `exempt` keeps the last pill while `dim` eases back to 1, so nothing snaps.
    if (lock !== -1) exempt.value = lock;
    const target = lock === -1 ? 1 : thanks ? THANKS_DIM : DIM;
    // Unavailable is a state, not a change, so it shows at once; a lock or release around a purchase moves over 180 ms.
    dim.value =
      reduced || lock === -2 ? target : withDelay(thanks ? THANKS_DELAY_MS : 0, withTiming(target, { duration: DIM_MS, easing: EASE }));
  }, [lock, thanks, reduced, exempt, dim]);

  useEffect(() => {
    if (!visible) return;
    return subscribeIap((e) => {
      switch (e.kind) {
        case 'status':
          return;
        case 'cancelled':
          clearCancelled();
          setBusy((b) => (b ? { packId: b.packId, phase: 'cancelled' } : null));
          setStatus(null);
          cancelTimer.current = setTimeout(() => {
            cancelTimer.current = null;
            setBusy((b) => (b?.phase === 'cancelled' ? null : b));
          }, CANCELLED_SHOWN_MS);
          return;
        case 'limited':
          // A test purchase over today's allowance: finished, nothing granted, so no thank you and no count-up.
          clearCancelled();
          setBusy({ packId: e.packId, phase: 'limited' });
          setStatus(null);
          cancelTimer.current = setTimeout(() => {
            cancelTimer.current = null;
            setBusy((b) => (b?.phase === 'limited' ? null : b));
          }, LIMITED_SHOWN_MS);
          return;
        case 'failed':
          clearCancelled();
          setBusy(null);
          setStatus({ key: 'support.failed', error: true });
          return;
        case 'pending':
          // A purchase delivered by the store's listener (not a tap here) holds its pill the same way.
          clearCancelled();
          setBusy({ packId: e.packId, phase: 'pending' });
          setStatus({ key: 'support.pending', error: false });
          return;
        case 'offline':
          clearCancelled();
          setBusy({ packId: e.packId, phase: 'offline' });
          setStatus({ key: 'support.offline', error: false });
          return;
        case 'granted':
          clearCancelled();
          grant.current = { amount: e.amount, energy: e.energy };
          setStatus(null);
          void hapticNotify(Haptics.NotificationFeedbackType.Success);
          setBusy({ packId: e.packId, phase: 'thanks' });
          later(onClose, CLOSE_AFTER_MS);
      }
    });
  }, [visible, onClose, later]);

  const tap = (pack: Pack) => {
    if (held || !ready) return;
    clearCancelled();
    setBusy({ packId: pack.id, phase: 'buying' });
    setStatus(null);
    void buyPack(pack);
  };

  const onRestore = async () => {
    if (restore === 'busy') return;
    setRestore('busy');
    let out: Grant;
    try {
      out = await restorePacks();
    } catch {
      setRestore('idle');
      setStatus({ key: 'support.unavailable', error: true });
      return;
    }
    if (out.amount > 0) grant.current = { amount: (grant.current?.amount ?? 0) + out.amount, energy: out.energy ?? grant.current?.energy ?? null };
    setRestored(out.amount);
    setRestore(out.amount > 0 ? 'some' : 'none');
    later(() => setRestore('idle'), RESTORE_SHOWN_MS);
  };

  const dismissed = () => {
    timers.current.forEach(clearTimeout);
    timers.current = [];
    clearCancelled();
    setVisible(false);
    setBusy(null);
    setStatus(null);
    setRestore('idle');
    const g = grant.current;
    grant.current = null;
    if (g) setTimeout(() => applyGrant(g), HANDOFF_MS);
  };

  const fmt = new Intl.NumberFormat(locale);
  const shown: Status = status ?? (ready ? null : { key: 'support.unavailable', error: true });
  const restoreLabel =
    restore === 'busy'
      ? t('support.restoring')
      : restore === 'some'
        ? t('support.restored', { n: fmt.format(restored) })
        : restore === 'none'
          ? t('support.nothingToRestore')
          : t('support.restore');

  return (
    <BottomSheet open={open} onClose={onClose} onDismissed={dismissed} title={t('support.title')}>
      <View style={styles.body}>
        <Text style={[styles.note, dir.text]}>{t('support.note')}</Text>
        <Text style={[styles.packsLine, dir.text]}>{t('support.packsLine')}</Text>
        <View style={styles.pills}>
          {PACKS.map((pack, i) => {
            const price = packPrice(pack);
            const pack_ = t('support.pack', { n: fmt.format(pack.amount) });
            return (
              <PackPill
                key={pack.id}
                index={i}
                phase={busy?.packId === pack.id ? busy.phase : null}
                labelFor={(p) =>
                  p === 'buying'
                    ? t('support.waitingApple')
                    : p === 'pending'
                      ? t('support.pendingPill')
                      : p === 'thanks'
                        ? t('support.thanks')
                        : p === 'cancelled'
                          ? t('support.cancelled')
                          : p === 'limited'
                            ? t('support.sandboxLimit')
                            : pack_
                }
                tagFor={(p) => (p === 'thanks' ? t('support.added') : p === 'pending' || p === 'limited' ? null : price)}
                locked={!ready || held !== null}
                a11y={t('support.a11yPack', { n: fmt.format(pack.amount), price })}
                exempt={exempt}
                dim={dim}
                rtl={dir.rtl}
                reduced={reduced}
                onPress={() => tap(pack)}
              />
            );
          })}
        </View>
        <Text style={styles.trust}>{t('support.trust')}</Text>
        <Pressable onPress={() => void onRestore()} disabled={restore === 'busy'} hitSlop={10} accessibilityRole="button" accessibilityLabel={t('support.restore')}>
          <Text style={styles.restore}>{restoreLabel}</Text>
        </Pressable>
        {shown ? <Text style={[styles.status, shown.error && styles.statusError]}>{t(shown.key)}</Text> : null}
      </View>
    </BottomSheet>
  );
}

type PillProps = {
  index: number;
  phase: Phase | null;
  labelFor: (p: Phase | null) => string;
  tagFor: (p: Phase | null) => string | null;
  locked: boolean;
  a11y: string;
  exempt: SharedValue<number>;
  dim: SharedValue<number>;
  rtl: boolean;
  reduced: boolean;
  onPress: () => void;
};

/** One pack pill (mock F): a flat pill, the label at its start, the price in a tag at its end, and the V5 wash under both. */
function PackPill({ index, phase, labelFor, tagFor, locked, a11y, exempt, dim, rtl, reduced, onPress }: PillProps) {
  // The phase the label shows; it trails `phase` by the swap so the text changes while faded out.
  const [shown, setShown] = useState<Phase | null>(phase);
  const op = useSharedValue(1);
  const wash = useSharedValue(0);
  const amber = useSharedValue(0);

  useEffect(() => {
    if (phase === shown) return;
    // The thank you waits for the wash to fill; everything else swaps at once. Reduced motion keeps the crossfade.
    const delay = phase === 'thanks' && !reduced ? THANKS_DELAY_MS : 0;
    op.value = withDelay(delay, withSequence(withTiming(0, { duration: SWAP_MS, easing: EASE }), withTiming(1, { duration: SWAP_MS, easing: EASE })));
    const id = setTimeout(() => setShown(phase), delay + SWAP_MS);
    return () => clearTimeout(id);
  }, [phase, shown, reduced, op]);

  useEffect(() => {
    // Reduced motion: no fill, only the label and tag crossfade.
    if (reduced) {
      wash.value = 0;
      amber.value = 0;
      return;
    }
    // Every target retargets from the current scale, so a result mid-fill never jumps.
    switch (phase) {
      case 'buying':
        wash.value = withTiming(WASH_WORKING, { duration: WASH_WORKING_MS, easing: EASE });
        amber.value = withTiming(0, { duration: WASH_DRAIN_MS });
        return;
      case 'thanks':
        wash.value = withTiming(1, { duration: WASH_DONE_MS, easing: OUT_CUBIC });
        amber.value = withTiming(0, { duration: WASH_DONE_MS, easing: OUT_CUBIC });
        return;
      case 'pending':
        wash.value = withTiming(WASH_PENDING, { duration: WASH_DRAIN_MS, easing: OUT_CUBIC });
        amber.value = withTiming(1, { duration: WASH_DRAIN_MS, easing: OUT_CUBIC });
        return;
      case 'offline':
        // Paid but not verified yet: the wash holds where it is.
        return;
      default:
        wash.value = withTiming(0, { duration: WASH_DRAIN_MS });
        amber.value = withTiming(0, { duration: WASH_DRAIN_MS });
    }
  }, [phase, reduced, wash, amber]);

  const wrap = useAnimatedStyle(() => {
    const d = dim.value;
    return { opacity: exempt.value === index ? 1 : Number.isFinite(d) ? d : 1 };
  });
  const fade = useAnimatedStyle(() => {
    const o = op.value;
    return { opacity: Number.isFinite(o) ? Math.min(1, Math.max(0, o)) : 1 };
  });
  const washStyle = useAnimatedStyle(() => {
    const w = wash.value;
    const a = amber.value;
    return {
      backgroundColor: interpolateColor(Number.isFinite(a) ? a : 0, [0, 1], [WASH_BLUE, WASH_AMBER]),
      transform: [{ scaleX: Number.isFinite(w) ? Math.min(1, Math.max(0, w)) : 0 }],
    };
  });

  const label = labelFor(shown);
  const tag = tagFor(shown);
  return (
    <Animated.View style={wrap}>
      <Pressable
        onPress={onPress}
        disabled={locked}
        accessibilityRole="button"
        accessibilityLabel={a11y}
        accessibilityState={{ disabled: locked }}
        style={[styles.pill, rtl ? styles.pillRtl : null]}>
        <Animated.View style={[styles.wash, rtl ? styles.washRtl : null, washStyle]} pointerEvents="none" />
        <Animated.View style={[styles.labelBox, rtl ? styles.labelBoxRtl : null, fade]}>
          {shown === 'buying' ? <ShimmerText style={styles.label}>{label}</ShimmerText> : (
            // The longer lines (cancelled, the test limit) shrink to fit the pill's one line.
            <Text style={[styles.label, rtl ? styles.textRtl : null]} numberOfLines={1} adjustsFontSizeToFit minimumFontScale={0.6}>
              {label}
            </Text>
          )}
        </Animated.View>
        {tag ? (
          <Animated.View style={[styles.tag, fade]}>
            <Text style={styles.tagText}>{tag}</Text>
          </Animated.View>
        ) : null}
      </Pressable>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  body: { alignSelf: 'stretch' },
  note: { fontFamily: fonts.ui, fontSize: 19, lineHeight: 28, color: '#FFFFFF', marginTop: 10, marginBottom: 14, marginHorizontal: 2 },
  packsLine: { fontFamily: fonts.ui, fontSize: 15, lineHeight: 21, color: tide.textDim, marginBottom: 14, marginHorizontal: 2 },
  pills: { gap: 10, alignSelf: 'stretch' },
  // Mock F: a flat pill, no Tide Drop face, so a disabled pill never sinks.
  pill: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    alignSelf: 'stretch',
    height: 56,
    borderRadius: 28,
    paddingLeft: 22,
    paddingRight: 8,
    backgroundColor: 'rgba(255,255,255,0.07)',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.14)',
    overflow: 'hidden',
  },
  pillRtl: { flexDirection: 'row-reverse', paddingLeft: 8, paddingRight: 22 },
  wash: { position: 'absolute', top: 0, right: 0, bottom: 0, left: 0, transformOrigin: 'left' },
  washRtl: { transformOrigin: 'right' },
  labelBox: { flex: 1, flexDirection: 'row', justifyContent: 'flex-start', marginRight: 8 },
  labelBoxRtl: { flexDirection: 'row-reverse', marginRight: 0, marginLeft: 8 },
  label: { fontFamily: fonts.ui, fontSize: 19, fontWeight: '600', color: '#FFFFFF', flexShrink: 1 },
  textRtl: { textAlign: 'right', writingDirection: 'rtl' },
  tag: { backgroundColor: 'rgba(124,200,255,0.22)', borderRadius: 22, paddingVertical: 11, paddingHorizontal: 18 },
  tagText: { fontFamily: fonts.ui, fontSize: 15, fontWeight: '700', color: '#FFFFFF', fontVariant: ['tabular-nums'] },
  trust: { fontFamily: fonts.ui, fontSize: 13, color: tide.textDim, textAlign: 'center', marginTop: 14 },
  restore: { fontFamily: fonts.ui, fontSize: 14, color: verb.listen.c1, textDecorationLine: 'underline', textAlign: 'center', marginTop: 8 },
  status: { fontFamily: fonts.ui, fontSize: 13, lineHeight: 18, color: tide.textDim, textAlign: 'center', marginTop: 10 },
  statusError: { color: AMBER },
});
