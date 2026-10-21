import { Stack, useFocusEffect, useLocalSearchParams } from 'expo-router';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import Animated from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { CatAvatar } from '@/components/cat/cat-avatar';
import { ItemDisc } from '@/components/cat/item-grid';
import { ItemSheet } from '@/components/cat/item-sheet';
import { GOLD, LevelChip } from '@/components/cat/leaderboard-row';
import { formatHours } from '@/components/cat/level-header';
import { PrismButton } from '@/components/prism';
import { fonts } from '@/constants/fonts';
import { Spacing, prism, tide } from '@/constants/theme';
import { getProfile, getUsername, type Achievement, type Profile } from '@/lib/api';
import { hapticSelection } from '@/lib/haptics';
import { useDir, useT } from '@/lib/i18n';
import { requestLoader } from '@/lib/loading-overlay';
import { equippedArtFromIds, itemState, useProgress, type CosmeticItem, type Progress } from '@/lib/progression';
import { useSkyStyle } from '@/lib/sky';


type TFn = ReturnType<typeof useT>['t'];

function formatDuration(seconds: number, t: TFn): string {
  const mins = Math.round(seconds / 60);
  if (mins < 60) return t('profile.minutes', { n: mins });
  return t('profile.hoursMinutes', { h: Math.floor(mins / 60), m: mins % 60 });
}

/** Rewards card order; a source this build does not know follows, in catalog order. */
const SOURCE_ORDER = ['level', 'hours', 'achievement'];

type RewardGroup = { source: string; title: string; items: CosmeticItem[] };

/**
 * Catalog items grouped by how they unlock, titled by the server's `group`.
 * Grant items are never listed, nor items without `unlock` (an old server).
 * Level and hours groups sort by requirement; the rest keep catalog order.
 */
function rewardGroups(catalog: CosmeticItem[]): RewardGroup[] {
  const groups = new Map<string, RewardGroup>();
  for (const item of catalog) {
    const u = item.unlock;
    if (!u || u.source === 'grant') continue;
    let g = groups.get(u.source);
    if (!g) {
      g = { source: u.source, title: u.group, items: [] };
      groups.set(u.source, g);
    }
    g.items.push(item);
  }
  const rank = (s: string) => {
    const i = SOURCE_ORDER.indexOf(s);
    return i === -1 ? SOURCE_ORDER.length : i;
  };
  const out = [...groups.values()].sort((a, b) => rank(a.source) - rank(b.source));
  for (const g of out) {
    if (g.source === 'level' || g.source === 'hours') g.items.sort((a, b) => Number(a.unlock?.need) - Number(b.unlock?.need));
  }
  return out;
}

/** One Rewards card: the group title, `n / total owned`, and a disc per item with its `short` caption. Any cell opens the item sheet. */
function RewardsCard({ group, progress, first, t, onPick }: { group: RewardGroup; progress: Progress; first: boolean; t: TFn; onPick: (item: CosmeticItem) => void }) {
  const dir = useDir();
  const states = group.items.map((i) => itemState(i, progress));
  const owned = states.filter((s) => s === 'owned' || s === 'equipped').length;
  return (
    <View style={[styles.card, !first && styles.cardGap]}>
      <View style={[styles.statRow, dir.row]}>
        <Text style={styles.rowLabel}>{group.title}</Text>
        <Text style={styles.since}>{t('profile.ownedOf', { n: owned, total: group.items.length })}</Text>
      </View>
      <View style={[styles.rewards, dir.row]}>
        {group.items.map((item, i) => {
          const has = states[i] === 'owned' || states[i] === 'equipped';
          return (
            <Pressable key={item.id} onPress={() => onPick(item)} accessibilityRole="button" accessibilityLabel={item.name} style={styles.rewardCell}>
              <ItemDisc item={item} locked={states[i] === 'locked'} size={44} />
              <Text numberOfLines={1} style={[styles.rewardCaption, has && styles.rewardCaptionOwned, dir.writing]}>{item.unlock?.short ?? ''}</Text>
            </Pressable>
          );
        })}
      </View>
    </View>
  );
}

function languageLabel(code: string, t: TFn): string {
  if (code === 'ja') return t('language.ja');
  if (code === 'es') return t('language.es');
  if (code === 'en') return t('language.en');
  return code.toUpperCase();
}

/** Earned: gold border. Unearned: dim name. Secret and unearned: "???". */
function AwardChip({ a, t }: { a: Achievement; t: TFn }) {
  const earned = a.earned_at !== null;
  return (
    <View style={[styles.award, earned ? styles.awardEarned : styles.awardDim]}>
      <Text style={[styles.awardText, earned ? styles.awardTextEarned : null]}>{a.name ?? t('profile.mystery')}</Text>
    </View>
  );
}

function StatTile({ label, value, big }: { label: string; value: string; big?: boolean }) {
  const dir = useDir();
  return (
    <View style={[styles.tile, big ? null : styles.tileSmall]}>
      <Text style={[styles.tileLabel, dir.text]}>{label}</Text>
      <Text numberOfLines={1} adjustsFontSizeToFit minimumFontScale={0.6} style={[big ? styles.tileValueBig : styles.tileValue, dir.text]}>{value}</Text>
    </View>
  );
}

function StatCard({ rows }: { rows: [string, string][] }) {
  const dir = useDir();
  return (
    <View style={styles.card}>
      {rows.map(([label, value], i) => (
        <View key={label} style={[styles.statRow, dir.row, i > 0 && styles.sep]}>
          <Text style={styles.rowLabel}>{label}</Text>
          <Text style={styles.rowValue}>{value}</Text>
        </View>
      ))}
    </View>
  );
}

export default function ProfileScreen() {
  const { t, locale, lang } = useT();
  const dir = useDir();
  const sky = useSkyStyle();
  const insets = useSafeAreaInsets();
  const { catalog, progress, listenedHours } = useProgress();
  const { username } = useLocalSearchParams<{ username: string }>();
  const [profile, setProfile] = useState<Profile | null>(null);
  const [failed, setFailed] = useState(false);
  // The Rewards cards need the own progress, so they render on the own profile only.
  const [me, setMe] = useState<string | null>(null);
  const own = me !== null && me.toLowerCase() === String(username ?? '').toLowerCase();
  // The sheet keeps its item id through the exit slide and re-reads it from a refreshed catalog.
  const [sheetId, setSheetId] = useState<string | null>(null);
  const [sheetOpen, setSheetOpen] = useState(false);
  const sheetItem = useMemo(() => catalog?.find((i) => i.id === sheetId) ?? null, [catalog, sheetId]);
  const groups = useMemo(() => (catalog ? rewardGroups(catalog) : []), [catalog]);

  useEffect(() => {
    let alive = true;
    getUsername()
      .then((name) => {
        if (alive) setMe(name);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, []);

  const pick = useCallback((item: CosmeticItem) => {
    void hapticSelection();
    setSheetId(item.id);
    setSheetOpen(true);
  }, []);

  const load = useCallback(async () => {
    setFailed(false);
    requestLoader(true);
    try {
      setProfile(await getProfile(username, lang));
    } catch {
      setFailed(true);
    } finally {
      requestLoader(false);
    }
  }, [username, lang]);

  useFocusEffect(
    useCallback(() => {
      void load();
      return () => requestLoader(false);
    }, [load]),
  );

  const art = useMemo(() => (profile && catalog ? equippedArtFromIds(profile.equipped, catalog) : {}), [profile, catalog]);

  const memberSince = useMemo(() => {
    if (!profile) return '';
    const [y, m] = profile.member_since.split('-').map(Number);
    return new Date(y, (m || 1) - 1, 1).toLocaleDateString(locale, { month: 'long', year: 'numeric' });
  }, [profile, locale]);

  let body = null;
  if (failed) {
    body = (
      <View style={styles.center}>
        <Text style={styles.msg}>{t('profile.failed')}</Text>
        <PrismButton shape="pill" verb="tools" label={t('profile.retry')} accessibilityLabel={t('profile.retry')} onPress={() => void load()} />
      </View>
    );
  } else if (profile) {
    const p = profile;
    const accuracy = p.average_accuracy === null ? '–' : `${Math.round(p.average_accuracy * 100)}%`;
    // Rows from immersion lane 1: an older server sends none of these keys.
    const langs = p.by_language ? Object.entries(p.by_language).filter(([, s]) => s > 0).sort((a, b) => b[1] - a[1]) : [];
    const awards = p.achievements ?? null;
    const secretLeft = awards ? awards.filter((a) => a.secret && a.earned_at === null).length : 0;
    body = (
      <ScrollView contentContainerStyle={{ padding: Spacing.lg, paddingBottom: insets.bottom + Spacing.xl }} showsVerticalScrollIndicator={false}>
        <View style={[styles.hero, dir.row]}>
          <CatAvatar size={150} equipped={art} />
          <View style={styles.heroInfo}>
            <Text numberOfLines={1} style={[styles.name, { writingDirection: 'ltr', textAlign: dir.rtl ? 'right' : 'left' }]}>{`@${p.username}`}</Text>
            <Text style={[styles.serial, { writingDirection: 'ltr', textAlign: dir.rtl ? 'right' : 'left' }]}>{`#${String(p.serial).padStart(3, '0')}`}</Text>
            <Text style={[styles.since, dir.text]}>{t('profile.memberSince', { date: memberSince })}</Text>
            <View style={[styles.chipRow, dir.row]}>
              <LevelChip level={p.level} tone="gold" />
            </View>
            {p.rank !== null ? <Text style={[styles.since, dir.text]}>{t('profile.rank', { n: p.rank })}</Text> : null}
          </View>
        </View>

        <Text style={[styles.header, dir.text, dir.rtl && styles.noTrack]}>{t('profile.immersion')}</Text>
        <StatTile big label={t('profile.listened')} value={t('wardrobe.listened', { h: formatHours(p.immersion_seconds) })} />
        <View style={[styles.tiles, dir.row]}>
          <StatTile label={t('profile.youtube')} value={formatDuration(p.video_seconds, t)} />
          <StatTile label={t('profile.podcast')} value={formatDuration(p.podcast_seconds, t)} />
          <StatTile label={t('profile.shadowing')} value={formatDuration(p.shadow_seconds, t)} />
        </View>
        {langs.length > 0 ? (
          <>
            <Text style={[styles.header, dir.text, dir.rtl && styles.noTrack]}>{t('profile.byLanguage')}</Text>
            <StatCard rows={langs.map(([code, secs]) => [languageLabel(code, t), formatDuration(secs, t)] as [string, string])} />
          </>
        ) : null}

        <Text style={[styles.header, dir.text, dir.rtl && styles.noTrack]}>{t('profile.practice')}</Text>
        <StatCard
          rows={[
            [t('profile.linesPracticed'), String(p.lines_practiced)],
            [t('profile.linesMastered'), String(p.lines_mastered)],
            [t('profile.accuracy'), accuracy],
            [t('profile.islandsStarted'), String(p.islands_started)],
            [t('profile.islandsMastered'), String(p.islands_mastered)],
          ]}
        />

        <Text style={[styles.header, dir.text, dir.rtl && styles.noTrack]}>{t('profile.progress')}</Text>
        <StatCard
          rows={[
            [t('profile.xp'), String(p.xp)],
            [t('profile.daysActive'), String(p.days_active)],
            [t('profile.streak'), String(p.streak_days)],
            [t('profile.longestStreak'), String(p.longest_streak)],
            [t('profile.bestDay'), String(p.best_xp_day)],
            [t('profile.capDays'), String(p.cap_days)],
            [t('profile.milestones'), `${p.milestones.length}/${p.milestones_total}`],
          ]}
        />

        <Text style={[styles.header, dir.text, dir.rtl && styles.noTrack]}>{t('profile.wardrobe')}</Text>
        <StatCard rows={[[t('profile.cosmetics'), `${p.cosmetics_owned}/${p.cosmetics_total}`]]} />

        {awards ? (
          <>
            <Text style={[styles.header, dir.text, dir.rtl && styles.noTrack]}>{t('profile.achievements')}</Text>
            <View style={[styles.awards, dir.row]}>
              {awards.map((a) => (
                <AwardChip key={a.id} a={a} t={t} />
              ))}
            </View>
            {secretLeft > 0 ? <Text style={[styles.since, styles.secretLeft, dir.text]}>{t('profile.secretLeft', { n: secretLeft })}</Text> : null}
          </>
        ) : null}

        {own && progress && groups.length > 0 ? (
          <>
            <Text style={[styles.header, dir.text, dir.rtl && styles.noTrack]}>{t('profile.rewards')}</Text>
            {groups.map((g, i) => (
              <RewardsCard key={g.source} group={g} progress={progress} first={i === 0} t={t} onPick={pick} />
            ))}
          </>
        ) : null}
      </ScrollView>
    );
  }

  return (
    <View style={[styles.fill, { backgroundColor: sky.top }]}>
      <Stack.Screen options={{ title: `@${username}` }} />
      <View style={[StyleSheet.absoluteFill, sky.from]} />
      <Animated.View style={[StyleSheet.absoluteFill, sky.to, sky.fadeStyle]} />
      {body}
      {progress ? <ItemSheet item={sheetItem} open={sheetOpen} onClose={() => setSheetOpen(false)} progress={progress} hours={listenedHours} /> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1 },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: Spacing.lg, padding: Spacing.xl },
  msg: { fontFamily: fonts.ui, fontSize: 15, color: tide.text, textAlign: 'center' },
  hero: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.md,
    padding: Spacing.md,
    borderRadius: prism.panel.radius,
    overflow: 'hidden',
    backgroundColor: prism.panel.fill,
    borderWidth: 1,
    borderColor: prism.panel.rim,
  },
  heroInfo: { flex: 1, minWidth: 0, gap: 4 },
  name: { fontFamily: fonts.ui, fontSize: 22, lineHeight: 30, color: tide.text },
  serial: { fontFamily: fonts.uiMedium, fontSize: 14, lineHeight: 20, letterSpacing: 1.2, color: GOLD },
  since: { fontFamily: fonts.ui, fontSize: 12, lineHeight: 16, color: tide.textDim },
  chipRow: { flexDirection: 'row', paddingVertical: 2 },
  header: { fontFamily: fonts.uiMedium, fontSize: 12, lineHeight: 16, letterSpacing: 1.2, textTransform: 'uppercase', color: tide.textDim, marginTop: Spacing.lg, marginBottom: Spacing.sm },
  tiles: { flexDirection: 'row', gap: Spacing.sm, marginTop: Spacing.sm },
  tile: { backgroundColor: prism.panel.fill, borderWidth: 1, borderColor: prism.panel.rim, borderRadius: prism.panel.radius, padding: Spacing.md, gap: 4 },
  tileSmall: { flex: 1 },
  tileLabel: { fontFamily: fonts.ui, fontSize: 12, lineHeight: 16, color: tide.textDim },
  tileValueBig: { fontFamily: fonts.uiMedium, fontSize: 32, lineHeight: 40, color: GOLD },
  noTrack: { letterSpacing: 0 },
  tileValue: { fontFamily: fonts.uiMedium, fontSize: 22, lineHeight: 28, color: tide.text },
  card: { backgroundColor: prism.panel.fill, borderWidth: 1, borderColor: prism.panel.rim, borderRadius: prism.panel.radius, paddingHorizontal: Spacing.md, overflow: 'hidden' },
  statRow: { flexDirection: 'row', height: 44, alignItems: 'center', justifyContent: 'space-between' },
  sep: { borderTopWidth: 1, borderTopColor: prism.panel.rim },
  rowLabel: { fontFamily: fonts.ui, fontSize: 15, color: tide.text },
  rowValue: { fontFamily: fonts.uiMedium, fontSize: 17, color: tide.text },
  cardGap: { marginTop: Spacing.sm },
  rewards: { flexDirection: 'row', flexWrap: 'wrap', gap: 6, paddingBottom: Spacing.md },
  rewardCell: { width: 48, alignItems: 'center', gap: 2 },
  rewardCaption: { fontFamily: fonts.ui, fontSize: 10, lineHeight: 12, color: tide.textDim, textAlign: 'center' },
  rewardCaptionOwned: { color: tide.text },
  awards: { flexDirection: 'row', flexWrap: 'wrap', gap: Spacing.sm },
  award: { borderWidth: 1, borderRadius: 14, paddingHorizontal: 10, paddingVertical: 5 },
  awardEarned: { borderColor: GOLD, backgroundColor: 'rgba(255,200,87,0.14)' },
  awardDim: { borderColor: prism.panel.rim, backgroundColor: prism.panel.fill },
  awardText: { fontFamily: fonts.ui, fontSize: 13, lineHeight: 18, color: tide.textDim },
  awardTextEarned: { fontFamily: fonts.uiMedium, color: GOLD },
  secretLeft: { marginTop: Spacing.sm },
});
