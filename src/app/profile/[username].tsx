import { Stack, useLocalSearchParams } from 'expo-router';
import { useCallback, useMemo, useState } from 'react';
import { ScrollView, StyleSheet, Text, View } from 'react-native';
import Animated from 'react-native-reanimated';
import { useFocusEffect } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { CatAvatar } from '@/components/cat/cat-avatar';
import { GOLD, LevelChip } from '@/components/cat/leaderboard-row';
import { PrismButton } from '@/components/prism';
import { fonts } from '@/constants/fonts';
import { Radius, Spacing, tide } from '@/constants/theme';
import { getProfile, type Profile } from '@/lib/api';
import { useDir, useT } from '@/lib/i18n';
import { requestLoader } from '@/lib/loading-overlay';
import { equippedArtFromIds, useProgress } from '@/lib/progression';
import { useSkyStyle } from '@/lib/sky';

const CARD_BG = 'rgba(34,58,94,0.72)';
const CARD_BORDER = 'rgba(255,255,255,0.12)';

type TFn = ReturnType<typeof useT>['t'];

function formatDuration(seconds: number, t: TFn): string {
  const mins = Math.round(seconds / 60);
  if (mins < 60) return t('profile.minutes', { n: mins });
  return t('profile.hoursMinutes', { h: Math.floor(mins / 60), m: mins % 60 });
}

function StatTile({ label, value, big }: { label: string; value: string; big?: boolean }) {
  const dir = useDir();
  return (
    <View style={[styles.tile, big ? null : styles.tileSmall]}>
      <Text style={[styles.tileLabel, dir.text]}>{label}</Text>
      <Text style={[big ? styles.tileValueBig : styles.tileValue, dir.text]}>{value}</Text>
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
  const { t, locale } = useT();
  const dir = useDir();
  const sky = useSkyStyle();
  const insets = useSafeAreaInsets();
  const { catalog } = useProgress();
  const { username } = useLocalSearchParams<{ username: string }>();
  const [profile, setProfile] = useState<Profile | null>(null);
  const [failed, setFailed] = useState(false);

  const load = useCallback(async () => {
    setFailed(false);
    requestLoader(true);
    try {
      setProfile(await getProfile(username));
    } catch {
      setFailed(true);
    } finally {
      requestLoader(false);
    }
  }, [username]);

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
    body = (
      <ScrollView contentContainerStyle={{ padding: Spacing.lg, paddingBottom: insets.bottom + Spacing.xl }} showsVerticalScrollIndicator={false}>
        <View style={[styles.hero, dir.row]}>
          <CatAvatar size={150} equipped={art} />
          <View style={styles.heroInfo}>
            <Text numberOfLines={1} style={[styles.name, { writingDirection: 'ltr', textAlign: 'left' }]}>{`@${p.username}`}</Text>
            <Text style={[styles.serial, { writingDirection: 'ltr', textAlign: 'left' }]}>{`#${String(p.serial).padStart(3, '0')}`}</Text>
            <Text style={[styles.since, dir.text]}>{t('profile.memberSince', { date: memberSince })}</Text>
            <View style={styles.chipRow}>
              <LevelChip level={p.level} tone="gold" />
            </View>
            {p.rank !== null ? <Text style={[styles.since, dir.text]}>{t('profile.rank', { n: p.rank })}</Text> : null}
          </View>
        </View>

        <Text style={[styles.header, dir.text]}>{t('profile.immersion')}</Text>
        <StatTile big label={t('profile.total')} value={formatDuration(p.immersion_seconds, t)} />
        <View style={styles.tiles}>
          <StatTile label={t('profile.youtube')} value={formatDuration(p.video_seconds, t)} />
          <StatTile label={t('profile.podcast')} value={formatDuration(p.podcast_seconds, t)} />
          <StatTile label={t('profile.shadowing')} value={formatDuration(p.shadow_seconds, t)} />
        </View>

        <Text style={[styles.header, dir.text]}>{t('profile.practice')}</Text>
        <StatCard
          rows={[
            [t('profile.linesPracticed'), String(p.lines_practiced)],
            [t('profile.linesMastered'), String(p.lines_mastered)],
            [t('profile.accuracy'), accuracy],
            [t('profile.islandsStarted'), String(p.islands_started)],
            [t('profile.islandsMastered'), String(p.islands_mastered)],
          ]}
        />

        <Text style={[styles.header, dir.text]}>{t('profile.progress')}</Text>
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

        <Text style={[styles.header, dir.text]}>{t('profile.wardrobe')}</Text>
        <StatCard rows={[[t('profile.cosmetics'), `${p.cosmetics_owned}/${p.cosmetics_total}`]]} />
      </ScrollView>
    );
  }

  return (
    <View style={[styles.fill, { backgroundColor: sky.top }]}>
      <Stack.Screen options={{ title: `@${username}` }} />
      <View style={[StyleSheet.absoluteFill, sky.from]} />
      <Animated.View style={[StyleSheet.absoluteFill, sky.to, sky.fadeStyle]} />
      {body}
    </View>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1 },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: Spacing.lg, padding: Spacing.xl },
  msg: { fontFamily: fonts.ui, fontSize: 15, color: tide.text, textAlign: 'center' },
  hero: {
    alignItems: 'center',
    gap: Spacing.md,
    padding: Spacing.md,
    borderRadius: Radius.lg,
    overflow: 'hidden',
    backgroundColor: 'rgba(34,58,94,0.78)',
    borderWidth: 1,
    borderColor: CARD_BORDER,
  },
  heroInfo: { flex: 1, minWidth: 0, gap: 4 },
  name: { fontFamily: fonts.ui, fontSize: 22, lineHeight: 30, color: tide.text },
  serial: { fontFamily: fonts.uiMedium, fontSize: 14, lineHeight: 20, letterSpacing: 1.2, color: GOLD },
  since: { fontFamily: fonts.ui, fontSize: 12, lineHeight: 16, color: tide.textDim },
  chipRow: { flexDirection: 'row', paddingVertical: 2 },
  header: { fontFamily: fonts.uiMedium, fontSize: 12, lineHeight: 16, letterSpacing: 1.2, textTransform: 'uppercase', color: tide.textDim, marginTop: Spacing.lg, marginBottom: Spacing.sm },
  tiles: { flexDirection: 'row', gap: Spacing.sm, marginTop: Spacing.sm },
  tile: { backgroundColor: CARD_BG, borderWidth: 1, borderColor: CARD_BORDER, borderRadius: Radius.lg, padding: Spacing.md, gap: 4 },
  tileSmall: { flex: 1 },
  tileLabel: { fontFamily: fonts.ui, fontSize: 12, lineHeight: 16, color: tide.textDim },
  tileValueBig: { fontFamily: fonts.uiMedium, fontSize: 32, lineHeight: 40, color: GOLD },
  tileValue: { fontFamily: fonts.uiMedium, fontSize: 22, lineHeight: 28, color: tide.text },
  card: { backgroundColor: CARD_BG, borderWidth: 1, borderColor: CARD_BORDER, borderRadius: Radius.lg, paddingHorizontal: Spacing.md, overflow: 'hidden' },
  statRow: { height: 44, alignItems: 'center', justifyContent: 'space-between' },
  sep: { borderTopWidth: 1, borderTopColor: 'rgba(255,255,255,0.08)' },
  rowLabel: { fontFamily: fonts.ui, fontSize: 15, color: tide.text },
  rowValue: { fontFamily: fonts.uiMedium, fontSize: 17, color: tide.text },
});
