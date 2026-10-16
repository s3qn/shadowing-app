import * as Haptics from 'expo-haptics';
import { Stack, useRouter } from 'expo-router';
import { SymbolView } from 'expo-symbols';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { ACTION_H, ActionBar } from '@/components/cat/action-bar';
import { CatStage, STAGE_H, WATER_H } from '@/components/cat/cat-stage';
import { ItemGrid } from '@/components/cat/item-grid';
import { LevelHeader } from '@/components/cat/level-header';
import { SlotTabs } from '@/components/cat/slot-tabs';
import { PrismButton } from '@/components/prism';
import type { Slot } from '@/constants/cosmetics';
import { fonts } from '@/constants/fonts';
import { Spacing, tide } from '@/constants/theme';
import { useGaze } from '@/hooks/use-gaze';
import { buyCosmetic, equipCosmetic } from '@/lib/api';
import { resetBlink } from '@/lib/cat-blink';
import { hapticNotify, hapticSelection } from '@/lib/haptics';
import { useT } from '@/lib/i18n';
import { requestLoader } from '@/lib/loading-overlay';
import { equippedArt, itemArt, itemState, useProgress, type CosmeticItem, type Progress } from '@/lib/progression';

const PAGE = '#0B1020';
const BAR_GAP = 24;

export default function WardrobeScreen() {
  const { t } = useT();
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { progress, catalog, error, reload, apply } = useProgress();
  const [slot, setSlot] = useState<Slot>('head');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [dipKey, setDipKey] = useState(0);
  const [notice, setNotice] = useState<string | null>(null);
  const [retrying, setRetrying] = useState(false);
  const latest = useRef<Progress | null>(progress);
  latest.current = progress;
  const noticeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const loading = !progress || !catalog;
  useEffect(() => {
    requestLoader((loading && !error) || retrying);
  }, [loading, error, retrying]);
  useEffect(
    () => () => {
      requestLoader(false);
      if (noticeTimer.current) clearTimeout(noticeTimer.current);
    },
    [],
  );

  const fail = useCallback((e: unknown) => {
    void hapticNotify(Haptics.NotificationFeedbackType.Error);
    setNotice(e instanceof Error ? e.message : t('wardrobe.failed'));
    if (noticeTimer.current) clearTimeout(noticeTimer.current);
    noticeTimer.current = setTimeout(() => setNotice(null), 3500);
  }, [t]);

  const items = useMemo(() => (catalog ? catalog.filter((i) => i.slot === slot) : []), [catalog, slot]);
  const equipped = useMemo(() => (progress && catalog ? equippedArt(progress, catalog) : {}), [progress, catalog]);
  const selected = useMemo(() => catalog?.find((i) => i.id === selectedId) ?? null, [catalog, selectedId]);
  const selectedState = selected && progress ? itemState(selected, progress) : null;
  // A try-on only for items you do not own; owned items equip on tap.
  const preview = selected && selectedState && selectedState !== 'equipped' && selectedState !== 'owned' ? { slot: selected.slot, art: itemArt(selected) } : null;

  const landed = useCallback(() => {
    resetBlink();
    setDipKey((k) => k + 1);
  }, []);

  const setEquipped = useCallback(
    async (s: Slot, id: string | null) => {
      const prev = latest.current;
      if (!prev) return;
      landed();
      apply({ ...prev, equipped: { ...prev.equipped, [s]: id } });
      try {
        apply(await equipCosmetic(s, id));
      } catch (e) {
        apply(prev);
        fail(e);
      }
    },
    [apply, fail, landed],
  );

  const buy = useCallback(async () => {
    const item = selected;
    const prev = latest.current;
    if (!item || !prev || busy) return;
    setBusy(true);
    setSelectedId(null);
    landed();
    apply({
      ...prev,
      coins: prev.coins - item.price,
      owned: prev.owned.includes(item.id) ? prev.owned : [...prev.owned, item.id],
      equipped: { ...prev.equipped, [item.slot]: item.id },
    });
    try {
      const bought = await buyCosmetic(item.id);
      void hapticNotify(Haptics.NotificationFeedbackType.Success);
      apply(bought);
      if (bought.equipped[item.slot] !== item.id) apply(await equipCosmetic(item.slot, item.id));
    } catch (e) {
      apply(prev);
      setSelectedId(item.id);
      fail(e);
    } finally {
      setBusy(false);
    }
  }, [selected, busy, apply, fail, landed]);

  const onSelect = (item: CosmeticItem) => {
    if (!progress) return;
    void hapticSelection();
    const st = itemState(item, progress);
    if (st === 'equipped') void setEquipped(item.slot, null);
    else if (st === 'owned') void setEquipped(item.slot, item.id);
    else setSelectedId(item.id === selectedId ? null : item.id);
  };

  const gaze = useGaze();

  if (error && loading) {
    return (
      <View style={[styles.fill, styles.center]}>
        <Text style={styles.failed}>{t('wardrobe.failed')}</Text>
        <PrismButton
          shape="pill"
          verb="tools"
          label={t('wardrobe.retry')}
          accessibilityLabel={t('wardrobe.retry')}
          onPress={() => {
            setRetrying(true);
            void reload().finally(() => setRetrying(false));
          }}
        />
      </View>
    );
  }
  if (!progress || !catalog) return <View style={styles.fill} />;

  const label = !selected || !selectedState
    ? null
    : selectedState === 'buyable'
      ? selected.price === 0
        ? t('wardrobe.claim')
        : t('wardrobe.buyPlain')
      : selectedState === 'locked'
        ? t('wardrobe.reachLevel', { n: selected.level_req })
        : selectedState === 'unaffordable'
          ? t('wardrobe.needCoins', { n: selected.price })
          : null;
  const barBottom = insets.bottom + Spacing.sm;
  const hint = notice ?? (progress.coins === 0 && progress.owned.length === 0 && !label ? t('wardrobe.earnHint') : null);

  return (
    <View style={styles.fill} {...gaze.handlers}>
      <Stack.Screen
        options={{
          headerRight: () => (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={t('leaderboard.open')}
              hitSlop={10}
              onPress={() => {
                void hapticSelection();
                router.push('/leaderboard');
              }}
            >
              <SymbolView name={{ ios: 'trophy.fill', android: 'emoji_events' }} size={22} tintColor={tide.pos.verb} />
            </Pressable>
          ),
        }}
      />
      <View style={StyleSheet.absoluteFill} pointerEvents="box-none">
        <CatStage equipped={equipped} preview={preview} dipKey={dipKey} gaze onCatRect={gaze.setCatRect} />
      </View>
      <View style={[styles.header, { top: Spacing.md }]}>
        <LevelHeader level={progress.level} xpIntoLevel={progress.xp_into_level} xpToNext={progress.xp_to_next} coins={progress.coins} xpToday={progress.xp_today} xpTodayCap={progress.xp_today_cap} />
      </View>
      <View style={[styles.body, { paddingTop: STAGE_H + WATER_H }]}>
        <View style={styles.gutter}>
          <SlotTabs
            slot={slot}
            onChange={(s) => {
              void hapticSelection();
              setSlot(s);
              setSelectedId(null);
            }}
          />
        </View>
        <View style={[styles.grid, { paddingHorizontal: Spacing.lg }]}>
          <ItemGrid items={items} progress={progress} selectedId={selectedId} slotKey={slot} onSelect={onSelect} bottomPad={ACTION_H + BAR_GAP + barBottom} />
        </View>
      </View>
      <View
        pointerEvents="none"
        style={[styles.fade, { experimental_backgroundImage: `linear-gradient(180deg, transparent, ${PAGE} 62%)` }]}
      />
      {hint ? <Text style={[styles.hint, { bottom: barBottom + ACTION_H + 6 }, notice ? styles.notice : null]}>{hint}</Text> : null}
      <View style={[styles.action, { bottom: barBottom }]}>
        <ActionBar
          label={label}
          price={selectedState === 'buyable' && selected && selected.price > 0 ? selected.price : undefined}
          busy={busy}
          disabled={selectedState === 'locked' || selectedState === 'unaffordable'}
          onPress={() => void buy()}
        />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1, backgroundColor: PAGE },
  center: { alignItems: 'center', justifyContent: 'center', gap: Spacing.lg },
  failed: { fontFamily: fonts.ui, fontSize: 15, color: tide.text },
  header: { position: 'absolute', left: Spacing.lg, right: Spacing.lg, zIndex: 5 },
  body: { flex: 1 },
  gutter: { paddingHorizontal: Spacing.lg },
  grid: { flex: 1, marginTop: Spacing.sm },
  fade: { position: 'absolute', left: 0, right: 0, bottom: 0, height: 112 },
  hint: { position: 'absolute', left: Spacing.lg, right: Spacing.lg, textAlign: 'center', fontFamily: fonts.ui, fontSize: 13, color: tide.textDim },
  notice: { color: tide.record },
  action: { position: 'absolute', left: Spacing.lg, right: Spacing.lg },
});
