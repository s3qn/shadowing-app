import { useCallback, useMemo, useRef, useState } from 'react';
import { FlatList, Image, Pressable, StyleSheet, Text, View, type ViewToken } from 'react-native';
import Animated from 'react-native-reanimated';
import { useFocusEffect, useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { CatAvatar } from '@/components/cat/cat-avatar';
import { GOLD, LeaderboardRow, ROW_H, type EquippedIds } from '@/components/cat/leaderboard-row';
import { PrismButton } from '@/components/prism';
import { Segmented } from '@/components/segmented';
import { ITEM_IMAGES } from '@/constants/cosmetic-images';
import { SLOTS, type Equipped } from '@/constants/cosmetics';
import { fonts } from '@/constants/fonts';
import { Radius, Spacing, prism, tide } from '@/constants/theme';
import { getPracticeLog, streakDays } from '@/lib/practice';
import { getLeaderboard, getWeeklyLeaderboard, type Leaderboard, type WeeklyEntry, type WeeklyLeaderboard } from '@/lib/api';
import { useGuideAnchor, useGuideStep } from '@/lib/guide';
import { useDir, useT } from '@/lib/i18n';
import { requestLoader } from '@/lib/loading-overlay';
import { itemArt, useProgress } from '@/lib/progression';
import { getSettingsSync, toIslandLanguage } from '@/lib/settings';
import { useSkyStyle } from '@/lib/sky';

const SPOT_CAT = 104;
const GAP = Spacing.sm;
const PIN_H = 72;

type Tab = 'level' | 'week';

export default function LeaderboardScreen() {
  const { t } = useT();
  const dir = useDir();
  const sky = useSkyStyle();
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const openProfile = useCallback((username: string) => router.push({ pathname: '/profile/[username]', params: { username } }), [router]);
  const { progress, catalog } = useProgress();
  // Opens on Level every time; each tab keeps its own board, so switching back
  // shows the cached one without a reload.
  const [tab, setTab] = useState<Tab>('level');
  const tabRef = useRef<Tab>('level');
  tabRef.current = tab;
  const [board, setBoard] = useState<Leaderboard | null>(null);
  const [weekly, setWeekly] = useState<WeeklyLeaderboard | null>(null);
  const [failedTab, setFailedTab] = useState<Record<Tab, boolean>>({ level: false, week: false });
  const [loadingTab, setLoadingTab] = useState<Record<Tab, boolean>>({ level: true, week: false });

  const load = useCallback(async (which: Tab) => {
    setLoadingTab((s) => ({ ...s, [which]: true }));
    setFailedTab((s) => ({ ...s, [which]: false }));
    requestLoader(true);
    try {
      if (which === 'level') setBoard(await getLeaderboard());
      else setWeekly(await getWeeklyLeaderboard(toIslandLanguage(getSettingsSync().learningLanguage)));
    } catch {
      setFailedTab((s) => ({ ...s, [which]: true }));
    } finally {
      setLoadingTab((s) => ({ ...s, [which]: false }));
      requestLoader(false);
    }
  }, []);

  // The viewer's own streak comes from the local log so it matches Home.
  const [myStreak, setMyStreak] = useState<number | null>(null);
  useFocusEffect(
    useCallback(() => {
      void load(tabRef.current);
      void getPracticeLog().then((log) => setMyStreak(streakDays(log, new Date())), () => {});
      return () => requestLoader(false);
    }, [load]),
  );

  const weeklyRef = useRef(weekly);
  weeklyRef.current = weekly;
  const onTab = useCallback(
    (next: Tab) => {
      setTab(next);
      if (next === 'week' && !weeklyRef.current) void load('week');
    },
    [load],
  );

  const week = tab === 'week';
  const failed = failedTab[tab];
  const loading = loadingTab[tab];
  const shown: Leaderboard | WeeklyLeaderboard | null = week ? weekly : board;
  const entries = shown?.entries ?? [];
  const me = shown?.me ?? null;
  const top = entries[0] ?? null;
  const myRank = me?.rank ?? null;
  const ptsLabel = t('leaderboard.pts');
  const scoreOf = (i: number) => (weekly && week ? (weekly.entries[i]?.score ?? 0) : 0);
  // The viewer sits inside the list at their real rank (rank 1 shows in the spotlight).
  const meInList = myRank !== null && myRank >= 2 && !!me?.username;
  const mineEquipped: EquippedIds = progress?.equipped ?? {};
  // BL-64: the guide's ranks step keeps the spotlight and the viewer's row in full light.
  const ranks = useGuideStep() === 'ranks' && !week;
  const topAnchor = useGuideAnchor('ranksTop', ranks);
  const meAnchor = useGuideAnchor('ranksMe', ranks);

  // Pin a copy of the viewer's row to the bottom only while their real row is
  // scrolled off-screen. Start assuming it is visible (true) so a viewer near the
  // top never sees the pinned bar flash on load.
  const [meVisible, setMeVisible] = useState(true);
  const myRankRef = useRef<number | null>(myRank);
  myRankRef.current = myRank;
  const viewConfigRef = useRef({ itemVisiblePercentThreshold: 55 });
  const onViewRef = useRef(({ viewableItems }: { viewableItems: ViewToken[] }) => {
    const r = myRankRef.current;
    if (r === null) return;
    setMeVisible(viewableItems.some((v) => (v.item as { rank?: number } | null)?.rank === r));
  });

  const nextLine = useMemo(() => {
    if (week) return weekly?.me.top_pct != null ? t('leaderboard.topPct', { n: weekly.me.top_pct }) : null;
    if (!me || myRank === null || myRank < 2) return null;
    const next = entries[myRank - 2];
    if (!next || next.level <= me.level) return null;
    return t('leaderboard.next', { name: next.username, n: next.level - me.level });
  }, [entries, me, myRank, t, week, weekly]);

  const spotEquipped = useMemo<Equipped>(() => {
    const out: Equipped = {};
    if (!top || !catalog) return out;
    for (const slot of SLOTS) {
      const id = top.equipped[slot];
      const item = id ? catalog.find((i) => i.id === id) : undefined;
      out[slot] = item ? itemArt(item) : null;
    }
    return out;
  }, [top, catalog]);

  // The list holds ranks 2 and below, including the viewer at their real position.
  const rows = useMemo(
    () => entries.map((e, i) => ({ ...e, rank: i + 1, score: 'score' in e ? (e as WeeklyEntry).score : null })).slice(1),
    [entries],
  );

  const header = top ? (
    <View ref={week || myRank !== 1 ? undefined : meAnchor.ref} onLayout={week || myRank !== 1 ? undefined : meAnchor.onLayout} collapsable={false}>
    <Pressable ref={week ? undefined : topAnchor.ref} onLayout={week ? undefined : topAnchor.onLayout} accessibilityRole="button" onPress={() => openProfile(top.username)} style={({ pressed }) => [styles.spot, dir.row, pressed && { opacity: 0.8 }]}>
      <View style={styles.spotCat} pointerEvents="none">
        <CatAvatar size={SPOT_CAT} equipped={spotEquipped} />
      </View>
      <View style={styles.spotInfo}>
        <Text style={[styles.spotKicker, dir.text, dir.rtl && { letterSpacing: 0 }]}>{`1 · ${t(week ? 'leaderboard.weekTop' : 'leaderboard.highest').toUpperCase()}`}</Text>
        <Text numberOfLines={1} ellipsizeMode="tail" style={[styles.spotName, { writingDirection: 'ltr', textAlign: dir.rtl ? 'right' : 'left' }]}>{`@${top.username}`}</Text>
        <View style={[styles.spotBottom, dir.row]}>
          <View style={[styles.chips, dir.row]}>
            {(['head', 'face', 'body', 'accessory'] as const).map((slot) => {
              const id = top.equipped[slot];
              const src = id ? ITEM_IMAGES[id] : undefined;
              return (
                <View key={slot} style={styles.itemChip}>
                  {src !== undefined ? <Image source={src} resizeMode="contain" style={styles.itemImg} /> : null}
                </View>
              );
            })}
          </View>
          {week ? (
            <View style={styles.spotScore}>
              <Text style={styles.spotPts}>{ptsLabel}</Text>
              <Text style={styles.spotLevel}>{scoreOf(0)}</Text>
            </View>
          ) : (
            <Text style={styles.spotLevel}>{top.level}</Text>
          )}
        </View>
      </View>
    </Pressable>
    </View>
  ) : null;

  let body;
  if (failed) {
    body = (
      <View style={styles.center}>
        <Text style={styles.msg}>{t('leaderboard.failed')}</Text>
        <PrismButton shape="pill" verb="tools" label={t('leaderboard.retry')} accessibilityLabel={t('leaderboard.retry')} onPress={() => void load(tab)} />
      </View>
    );
  } else if (loading && !shown) {
    body = null;
  } else if (entries.length === 0) {
    body = (
      <View style={styles.center}>
        <Text style={styles.msg}>{t(week ? 'leaderboard.weeklyEmpty' : 'leaderboard.empty')}</Text>
      </View>
    );
  } else {
    body = (
      <FlatList
        data={rows}
        key={tab}
        keyExtractor={(e) => String(e.rank)}
        ListHeaderComponent={header}
        ListFooterComponent={
          week && myRank === null ? <Text style={[styles.join, dir.text]}>{t('leaderboard.weeklyJoin')}</Text> : null
        }
        ItemSeparatorComponent={() => <View style={{ height: GAP }} />}
        renderItem={({ item, index }) => (
          <LeaderboardRow
            rank={item.rank}
            username={item.username}
            level={item.level}
            equipped={item.rank === myRank ? mineEquipped : item.equipped}
            mine={item.rank === myRank}
            nextLine={item.rank === myRank ? nextLine : null}
            streak={item.rank === myRank ? (myStreak ?? item.streak_days) : item.streak_days}
            index={index}
            onOpen={openProfile}
            chip={item.score !== null ? { label: ptsLabel, value: item.score } : undefined}
          />
        )}
        getItemLayout={(_, index) => ({ length: ROW_H + GAP, offset: Spacing.lg + HEADER_H + index * (ROW_H + GAP), index })}
        initialNumToRender={8}
        windowSize={7}
        maxToRenderPerBatch={8}
        removeClippedSubviews
        onViewableItemsChanged={onViewRef.current}
        viewabilityConfig={viewConfigRef.current}
        contentContainerStyle={{ padding: Spacing.lg, paddingBottom: (meInList ? PIN_H + Spacing.xl : Spacing.lg) + insets.bottom + Spacing.lg }}
        showsVerticalScrollIndicator={false}
      />
    );
  }

  return (
    <View style={[styles.fill, { backgroundColor: sky.top }]}>
      <View style={[StyleSheet.absoluteFill, sky.from]} />
      <Animated.View style={[StyleSheet.absoluteFill, sky.to, sky.fadeStyle]} />
      <View style={styles.tabs}>
        <Segmented<Tab>
          options={[
            { value: 'level', label: t('leaderboard.tabLevel') },
            { value: 'week', label: t('leaderboard.tabWeek') },
          ]}
          value={tab}
          onChange={onTab}
        />
      </View>
      {body}
      {/* During the guide's ranks step the pin stays up so the cat can point at "you". */}
      {meInList && me && me.username && (!meVisible || ranks) ? (
        <View ref={week ? undefined : meAnchor.ref} onLayout={week ? undefined : meAnchor.onLayout} collapsable={false} style={[styles.pin, { bottom: insets.bottom + Spacing.sm }]}>
          <LeaderboardRow
            key={tab}
            rank={myRank as number}
            username={me.username}
            level={me.level}
            equipped={mineEquipped}
            mine
            pinned
            nextLine={nextLine}
            streak={myStreak ?? 0}
            onOpen={openProfile}
            chip={week && weekly ? { label: ptsLabel, value: weekly.me.score } : undefined}
          />
        </View>
      ) : null}
    </View>
  );
}

// Spotlight band height plus its gap, so getItemLayout can place rows without measuring.
const SPOT_H = 172;
const HEADER_H = SPOT_H + GAP * 2;

const styles = StyleSheet.create({
  fill: { flex: 1 },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: Spacing.lg, padding: Spacing.xl },
  msg: { fontFamily: fonts.ui, fontSize: 15, color: tide.text, textAlign: 'center' },
  spot: {
    flexDirection: 'row',
    height: SPOT_H,
    paddingVertical: Spacing.md,
    marginBottom: GAP * 2,
    alignItems: 'center',
    gap: Spacing.md,
    paddingHorizontal: Spacing.md,
    borderRadius: prism.panel.radius,
    overflow: 'hidden',
    backgroundColor: prism.panel.fill,
    borderWidth: 1,
    borderColor: prism.panel.rim,
  },
  spotCat: { width: SPOT_CAT, height: SPOT_CAT },
  spotInfo: { flex: 1, minWidth: 0, justifyContent: 'center', gap: 4 },
  spotKicker: { fontFamily: fonts.uiMedium, fontSize: 12, lineHeight: 16, letterSpacing: 1.2, color: GOLD },
  spotName: { fontFamily: fonts.ui, fontSize: 22, lineHeight: 30, color: tide.text },
  spotBottom: { flexDirection: 'row', alignItems: 'flex-end', justifyContent: 'space-between', gap: Spacing.md },
  chips: { flexDirection: 'row', gap: 4, flexShrink: 1 },
  itemChip: { width: 28, height: 28, borderRadius: Radius.sm, alignItems: 'center', justifyContent: 'center', backgroundColor: 'rgba(255,200,87,0.12)', borderWidth: 1, borderColor: 'rgba(255,200,87,0.4)' },
  itemImg: { width: 22, height: 22 },
  spotLevel: { fontFamily: fonts.uiMedium, fontSize: 44, lineHeight: 48, color: GOLD },
  pin: { position: 'absolute', left: Spacing.lg, right: Spacing.lg },
  tabs: { paddingHorizontal: Spacing.lg, paddingTop: Spacing.md },
  spotScore: { alignItems: 'center' },
  spotPts: { fontFamily: fonts.uiMedium, fontSize: 11, letterSpacing: 1, color: GOLD },
  join: { fontFamily: fonts.ui, fontSize: 13, color: tide.textDim, textAlign: 'center', marginTop: Spacing.lg },
});
