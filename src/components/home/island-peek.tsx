import { BlurView } from 'expo-blur';
import { SymbolView } from 'expo-symbols';
import { useImperativeHandle, useMemo, useRef, useState, type Ref } from 'react';
import { Modal, Platform, Pressable, StyleSheet, Text, View } from 'react-native';
import Animated, {
  Easing,
  runOnJS,
  useAnimatedProps,
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
  withDelay,
  withSpring,
  withTiming,
} from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { useDownloadAction } from '@/components/home/island-menu-sheet';
import { TIER_COLOR } from '@/components/lantern-row';
import { SessionLines } from '@/components/tide/session-lines';
import { fonts } from '@/constants/fonts';
import { tide, verb } from '@/constants/theme';
import type * as api from '@/lib/api';
import { prefetchSessionLines } from '@/lib/api';
import { useDir, useT } from '@/lib/i18n';
import { weakestLine, type LineTier } from '@/lib/takes';

/** What the card already knows about its island: the strings it renders and its line tiers. */
export type IslandPeekContext = { meta: string; due: boolean; tiers: LineTier[] | null };
export type IslandPeekHandle = { open: (item: api.IslandSummary, ctx: IslandPeekContext) => void; close: () => void };

type Props = {
  ref: Ref<IslandPeekHandle>;
  /** Runs once the peek has closed: opens the rename sheet. */
  onRename: (item: api.IslandSummary) => void;
  /** Runs once the peek has closed: confirmDelete shows its own confirm. */
  onDelete: (item: api.IslandSummary) => Promise<void> | void;
};

const DELETE_RED = '#FF8A80';
const GLASS = Platform.select({ ios: 'rgba(28,58,74,0.72)', default: 'rgba(28,58,74,0.94)' });
const MENU_GLASS = Platform.select({ ios: 'rgba(28,58,74,0.8)', default: 'rgba(28,58,74,0.96)' });
const SPRING = { damping: 18, stiffness: 200, mass: 1 };
const AnimatedBlur = Animated.createAnimatedComponent(BlurView);

/** The floating peek a hold on a Home card opens: the island's sentences and its three actions on a glass card. One overlay, mounted once; opening swaps its data. */
export function IslandPeek({ ref, onRename, onDelete }: Props) {
  const { t } = useT();
  const dir = useDir();
  const insets = useSafeAreaInsets();
  const reduced = useReducedMotion();
  const [data, setData] = useState<{ item: api.IslandSummary; ctx: IslandPeekContext } | null>(null);
  // p drives the scrim and card, menuP the menu (it lands 80ms later), closing picks the smaller close travel.
  const p = useSharedValue(0);
  const menuP = useSharedValue(0);
  const closing = useSharedValue(0);
  const motion = reduced ? 0 : 1;
  const after = useRef<(() => void) | null>(null);

  function finish() {
    setData(null);
    const fn = after.current;
    after.current = null;
    // The peek's own Modal is still leaving: a sheet or confirm opened this frame would race its dismissal on iOS.
    if (fn) setTimeout(fn, 80);
  }
  function closeThen(fn?: () => void) {
    if (!data) return;
    after.current = fn ?? null;
    closing.value = 1;
    const out = { duration: reduced ? 120 : 220, easing: Easing.in(Easing.quad) };
    menuP.value = withTiming(0, out);
    p.value = withTiming(0, out, (done) => {
      'worklet';
      if (done) runOnJS(finish)();
    });
  }
  useImperativeHandle(
    ref,
    () => ({
      open: (item, ctx) => {
        after.current = null;
        closing.value = 0;
        setData({ item, ctx });
        if (reduced) {
          p.value = withTiming(1, { duration: 120 });
          menuP.value = withTiming(1, { duration: 120 });
        } else {
          p.value = withSpring(1, SPRING);
          menuP.value = withDelay(80, withSpring(1, SPRING));
        }
      },
      close: () => closeThen(),
    }),
    // closeThen reads `data` of the latest render, so the handle follows it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [data, reduced],
  );

  const scrimStyle = useAnimatedStyle(() => ({ opacity: Math.min(1, Math.max(0, p.value)) }));
  const blurProps = useAnimatedProps(() => ({ intensity: 40 * Math.min(1, Math.max(0, p.value)) }));
  const cardStyle = useAnimatedStyle(() => {
    const k = p.value;
    const start = 1 - 0.12 * motion + 0.08 * closing.value * motion;
    const rise = 30 * motion - 18 * closing.value * motion;
    return {
      opacity: Math.min(1, Math.max(0, k * 2.5)),
      transform: [{ translateY: rise * (1 - k) }, { scale: start + (1 - start) * k }],
    };
  });
  const menuStyle = useAnimatedStyle(() => {
    const k = menuP.value;
    return {
      opacity: Math.min(1, Math.max(0, k * 2.5)),
      transform: [{ translateY: -10 * motion * (1 - k) }, { scale: 1 - 0.06 * motion * (1 - k) }],
    };
  });

  // The same colour the card's lantern i takes: the weakest line wears the language colour.
  const barColors = useMemo(() => {
    const tiers = data?.ctx.tiers;
    if (!tiers) return undefined;
    const weakest = weakestLine(tiers);
    return tiers.map((tier, i) => (i === weakest ? tide.lang.ja : TIER_COLOR[tier]));
  }, [data]);
  const item = data?.item ?? null;
  const ready = item?.status === 'ready';
  const top = Math.max(insets.top + 16, 96);

  return (
    // A transparent Modal sits above the header and the tab bar, so the scrim and blur cover the whole phone and a tap anywhere closes the peek.
    <Modal visible={!!data} transparent animationType="none" statusBarTranslucent onRequestClose={() => closeThen()}>
    <View style={styles.overlay}>
      {data && item ? (
        <>
          <Animated.View style={[StyleSheet.absoluteFill, scrimStyle]}>
            {Platform.OS === 'ios' ? (
              <AnimatedBlur style={StyleSheet.absoluteFill} tint="dark" intensity={0} animatedProps={blurProps} />
            ) : null}
            <View style={[StyleSheet.absoluteFill, { backgroundColor: Platform.OS === 'ios' ? 'rgba(3,12,18,0.5)' : 'rgba(3,12,18,0.72)' }]} />
          </Animated.View>
          <Pressable style={StyleSheet.absoluteFill} onPress={() => closeThen()} accessibilityRole="button" accessibilityLabel={t('common.cancel')} />
          <View style={[styles.stack, { top }]} pointerEvents="box-none">
            <Animated.View style={[styles.cardShadow, cardStyle]}>
              <View style={[styles.card, { backgroundColor: GLASS }]}>
                {Platform.OS === 'ios' ? <BlurView style={StyleSheet.absoluteFill} tint="dark" intensity={60} /> : null}
                <Text style={[styles.title, dir.content]} numberOfLines={2}>
                  {item.title || t('home.untitledIsland')}
                </Text>
                <View style={[styles.metaRow, dir.row]}>
                  {data.ctx.due ? (
                    <>
                      <Text style={[styles.meta, { color: verb.read.c2 }]}>{t('home.dueToday')}</Text>
                      <Text style={[styles.meta, { color: verb.read.c2 }]}>·</Text>
                    </>
                  ) : null}
                  <Text style={[styles.meta, { color: tide.textDim }]}>{data.ctx.meta}</Text>
                </View>
                {ready ? <SessionLines key={item.id} islandId={item.id} picked={[]} variant="peek" barColors={barColors} expectRows={item.line_count} /> : null}
              </View>
            </Animated.View>
            <Animated.View
              style={[styles.menuShadow, { alignSelf: dir.rtl ? 'flex-start' : 'flex-end', transformOrigin: dir.rtl ? '0% 0%' : '100% 0%' }, menuStyle]}>
              <View style={[styles.menu, { backgroundColor: MENU_GLASS }]}>
                {Platform.OS === 'ios' ? <BlurView style={StyleSheet.absoluteFill} tint="dark" intensity={60} /> : null}
                <MenuRow
                  label={t('home.rename')}
                  icon={{ ios: 'pencil', android: 'edit' }}
                  onPress={() => closeThen(() => onRename(item))}
                />
                {ready ? <DownloadRow id={item.id} closeThen={closeThen} /> : null}
                <MenuRow
                  label={t('common.delete')}
                  icon={{ ios: 'trash', android: 'delete' }}
                  color={DELETE_RED}
                  divider
                  onPress={() => closeThen(() => void onDelete(item))}
                />
              </View>
            </Animated.View>
          </View>
        </>
      ) : null}
    </View>
    </Modal>
  );
}

/** Starts the lines fetch on touch start, so the peek usually opens with its rows cached. */
export function prefetchPeek(item: api.IslandSummary): void {
  if (item.status === 'ready') prefetchSessionLines(item.id);
}

function DownloadRow({ id, closeThen }: { id: string; closeThen: (fn?: () => void) => void }) {
  const { label, onPress, done } = useDownloadAction(id, closeThen);
  return (
    <MenuRow
      divider
      label={label}
      icon={done ? { ios: 'arrow.down.circle.fill', android: 'download' } : { ios: 'arrow.down.circle', android: 'download' }}
      onPress={onPress}
    />
  );
}

function MenuRow({
  label,
  icon,
  onPress,
  color = tide.text,
  divider = false,
}: {
  label: string;
  icon: { ios: 'pencil' | 'trash' | 'arrow.down.circle' | 'arrow.down.circle.fill'; android: 'edit' | 'delete' | 'download' };
  onPress: () => void;
  color?: string;
  /** A hairline above the row, between two rows. */
  divider?: boolean;
}) {
  const dir = useDir();
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      style={({ pressed }) => [styles.row, dir.row, divider && styles.rowDivider, pressed && styles.rowPressed]}>
      <SymbolView name={icon} size={16} weight="regular" tintColor={color} />
      <Text style={[styles.rowLabel, dir.text, { color }]} numberOfLines={2}>
        {label}
      </Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  overlay: { position: 'absolute', top: 0, bottom: 0, start: 0, end: 0, zIndex: 50, elevation: 50 },
  stack: { position: 'absolute', start: 20, end: 20 },
  cardShadow: {
    transformOrigin: '50% 0%',
    borderRadius: 26,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 24 },
    shadowOpacity: 0.45,
    shadowRadius: 30,
    elevation: 18,
  },
  card: {
    borderRadius: 26,
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.2)',
    overflow: 'hidden',
    paddingTop: 16,
    paddingHorizontal: 14,
    paddingBottom: 14,
  },
  title: { marginHorizontal: 4, fontFamily: fonts.ui, fontSize: 21, fontWeight: '600', color: tide.text },
  metaRow: { flexDirection: 'row', gap: 6, marginHorizontal: 4, marginTop: 2, marginBottom: 12 },
  meta: { fontFamily: fonts.ui, fontSize: 13 },
  menuShadow: {
    width: 208,
    marginTop: 12,
    borderRadius: 20,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 18 },
    shadowOpacity: 0.45,
    shadowRadius: 20,
    elevation: 12,
  },
  menu: {
    borderRadius: 20,
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.2)',
    overflow: 'hidden',
    padding: 5,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    minHeight: 48,
    paddingVertical: 4,
    paddingHorizontal: 14,
    borderRadius: 14,
  },
  rowDivider: { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: 'rgba(255,255,255,0.12)', borderTopLeftRadius: 0, borderTopRightRadius: 0 },
  rowPressed: { backgroundColor: 'rgba(255,255,255,0.08)' },
  rowLabel: { flex: 1, fontFamily: fonts.ui, fontSize: 15 },
});
