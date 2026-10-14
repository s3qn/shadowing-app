import { useRouter } from 'expo-router';
import { StyleSheet, Text, View } from 'react-native';

import { CatAvatar } from '@/components/cat/cat-avatar';
import { XpBar } from '@/components/cat/level-header';
import { PressScale } from '@/components/press-scale';
import { GlassPanel } from '@/components/prism';
import type { Equipped } from '@/constants/cosmetics';
import { fonts } from '@/constants/fonts';
import { tide } from '@/constants/theme';
import { useDir, useT } from '@/lib/i18n';
import { equippedArt, useProgress } from '@/lib/progression';

export type CatBadgeViewProps = {
  level: number;
  xpIntoLevel: number;
  xpToNext: number;
  coins: number;
  equipped: Equipped;
  onPress: () => void;
};

/** The Home entry row: the cat, level, XP bar and coins as one control. */
export function CatBadgeView({ level, xpIntoLevel, xpToNext, coins, equipped, onPress }: CatBadgeViewProps) {
  const { t } = useT();
  const dir = useDir();
  return (
    <PressScale onPress={onPress} accessibilityRole="button" accessibilityLabel={t('wardrobe.title')} style={styles.wrap}>
      <GlassPanel style={[styles.panel, dir.row]}>
        <CatAvatar size={44} equipped={equipped} frameRate={30} />
        <Text style={styles.level}>{t('wardrobe.lv', { n: level })}</Text>
        <View style={styles.bar}>
          <XpBar height={6} fraction={xpToNext > 0 ? xpIntoLevel / xpToNext : 1} />
        </View>
        <View style={[styles.coins, dir.row]}>
          <View style={styles.disc} />
          <Text style={styles.coinText}>{coins}</Text>
        </View>
      </GlassPanel>
    </PressScale>
  );
}

/** Connected to the shared progress cache; renders nothing until the first load lands. */
export function CatBadge() {
  const router = useRouter();
  const { progress, catalog } = useProgress();
  if (!progress || !catalog) return null;
  return (
    <CatBadgeView
      level={progress.level}
      xpIntoLevel={progress.xp_into_level}
      xpToNext={progress.xp_to_next}
      coins={progress.coins}
      equipped={equippedArt(progress, catalog)}
      onPress={() => router.push('/wardrobe')}
    />
  );
}

const styles = StyleSheet.create({
  wrap: {},
  panel: { flexDirection: 'row', alignItems: 'center', height: 60, paddingHorizontal: 12, gap: 12, overflow: 'hidden' },
  level: { fontFamily: fonts.ui, fontSize: 17, fontWeight: '700', color: tide.text },
  bar: { flex: 1 },
  coins: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  disc: { width: 12, height: 12, borderRadius: 6, backgroundColor: '#FFC857' },
  coinText: { fontFamily: fonts.ui, fontSize: 15, fontWeight: '700', color: tide.text },
});
