import { useCallback, useMemo, useRef, useState } from 'react';
import { FlatList, Image, Pressable, StyleSheet, Text, View, type ViewToken } from 'react-native';
import Animated from 'react-native-reanimated';
import { useFocusEffect, useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { CatAvatar } from '@/components/cat/cat-avatar';
import { GOLD, LeaderboardRow, ROW_H, type EquippedIds } from '@/components/cat/leaderboard-row';
import { PrismButton } from '@/components/prism';
import { ITEM_IMAGES } from '@/constants/cosmetic-images';
import { SLOTS, type Equipped } from '@/constants/cosmetics';
import { fonts } from '@/constants/fonts';
import { Radius, Spacing, prism, tide } from '@/constants/theme';
import { getLeaderboard, type Leaderboard } from '@/lib/api';
import { useDir, useT } from '@/lib/i18n';
import { requestLoader } from '@/lib/loading-overlay';
import { itemArt, useProgress } from '@/lib/progression';
import { useSkyStyle } from '@/lib/sky';

const SPOT_CAT = 104;
const GAP = Spacing.sm;
const PIN_H = 72;

export default function LeaderboardScreen() {
  const { t } = useT();
  const dir = useDir();
  const sky = useSkyStyle();
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const openProfile = useCallback((username: string) => router.push({ pathname: '/profile/[username]', params: { username } }), [router]);
  const { progress, catalog } = useProgress();
  const [board, setBoard] = useState<Leaderboard | null>(null);
  const [failed, setFailed] = useState(false);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    setFailed(false);
    requestLoader(true);
    try {
      setBoard(await getLeaderboard());
    } catch {
      setFailed(true);
    } finally {
      setLoading(false);
      requestLoader(false);
    }
  }, []);

  useFocusEffect(
    useCallback(() => {
      void load();
      return () => requestLoader(false);
    }, [load]),
  );

  const entries = board?.entries ?? [];
  const me = board?.me ?? null;
  const top = entries[0] ?? null;
  const myRank = me?.rank ?? null;
  // The viewer sits inside the list at their real rank (rank 1 shows in the spotlight).
  const meInList = myRank !== null && myRank >= 2 && !!me?.username;
  const mineEquipped: EquippedIds = progress?.equipped ?? {};

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
    if (!me || myRank === null || myRank < 2) return null;
    const next = entries[myRank - 2];
    if (!next || next.level <= me.level) return null;
    return t('leaderboard.next', { name: next.username, n: next.level - me.level });
  }, [entries, me, myRank, t]);

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
  const rows = useMemo(() => entries.map((e, i) => ({ ...e, rank: i + 1 })).slice(1), [entries]);

  const header = top ? (
    <Pressable accessibilityRole="button" onPress={() => openProfile(top.username)} style={({ pressed }) => [styles.spot, dir.row, pressed && { opacity: 0.8 }]}>
      <View style={styles.spotCat} pointerEvents="none">
        <CatAvatar size={SPOT_CAT} equipped={spotEquipped} />
      </View>
      <View style={styles.spotInfo}>
        <Text style={[styles.spotKicker, dir.text]}>{`1 · ${t('leaderboard.highest').toUpperCase()}`}</Text>
        <Text numberOfLines={1} ellipsizeMode="tail" style={[styles.spotName, { writingDirection: 'ltr', textAlign: 'left' }]}>{`@${top.username}`}</Text>
        <View style={styles.spotBottom}>
          <View style={styles.chips}>
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
          <Text style={styles.spotLevel}>{top.level}</Text>
        </View>
      </View>
    </Pressable>
  ) : null;

  let body;
  if (failed) {
    body = (
      <View style={styles.center}>
        <Text style={styles.msg}>{t('leaderboard.failed')}</Text>
        <PrismButton shape="pill" verb="tools" label={t('leaderboard.retry')} accessibilityLabel={t('leaderboard.retry')} onPress={() => void load()} />
      </View>
    );
  } else if (loading && !board) {
    body = null;
  } else if (entries.length === 0) {
    body = (
      <View style={styles.center}>
        <Text style={styles.msg}>{t('leaderboard.empty')}</Text>
      </View>
    );
  } else {
    body = (
      <FlatList
        data={rows}
        keyExtractor={(e) => String(e.rank)}
        ListHeaderComponent={header}
        ItemSeparatorComponent={() => <View style={{ height: GAP }} />}
        renderItem={({ item, index }) => (
          <LeaderboardRow
            rank={item.rank}
            username={item.username}
            level={item.level}
            equipped={item.rank === myRank ? mineEquipped : item.equipped}
            mine={item.rank === myRank}
            index={index}
            onOpen={openProfile}
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
      {body}
      {meInList && me && me.username && !meVisible ? (
        <View style={[styles.pin, { bottom: insets.bottom + Spacing.sm }]}>
          <LeaderboardRow rank={myRank as number} username={me.username} level={me.level} equipped={mineEquipped} mine pinned nextLine={nextLine} onOpen={openProfile} />
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
  spotBottom: { flexDirection: 'row', alignItems: 'flex-end', justifyContent: 'space-between' },
  chips: { flexDirection: 'row', gap: 4, flexShrink: 1 },
  itemChip: { width: 28, height: 28, borderRadius: Radius.sm, alignItems: 'center', justifyContent: 'center', backgroundColor: 'rgba(255,200,87,0.12)', borderWidth: 1, borderColor: 'rgba(255,200,87,0.4)' },
  itemImg: { width: 22, height: 22 },
  spotLevel: { fontFamily: fonts.uiMedium, fontSize: 44, lineHeight: 48, color: GOLD },
  pin: { position: 'absolute', left: Spacing.lg, right: Spacing.lg },
});
