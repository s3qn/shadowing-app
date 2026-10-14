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
      <GlassPanel radius={34} style={[styles.panel, dir.row]}>
        <View pointerEvents="none" style={styles.sheen} />
        <View pointerEvents="none" style={styles.glow} />
        <CatAvatar size={56} equipped={equipped} frameRate={30} />
        <View style={styles.mid}>
          <Text style={styles.level}>{t('wardrobe.lv', { n: level })}</Text>
          <View style={styles.bar}>
            <XpBar height={6} fraction={xpToNext > 0 ? xpIntoLevel / xpToNext : 1} />
          </View>
        </View>
        <View style={[styles.coins, dir.row]}>
          <View style={styles.disc} />
          <Text style={styles.coinText}>{coins}</Text>
        </View>
        <View style={styles.go}>
          <Text style={styles.goText}>{dir.chevron}</Text>
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
  panel: { flexDirection: 'row', alignItems: 'center', height: 68, paddingStart: 10, paddingEnd: 14, gap: 12, overflow: 'hidden' },
  sheen: { ...StyleSheet.absoluteFill, backgroundColor: 'rgba(255,255,255,0.04)' },
  glow: { position: 'absolute', start: -2, top: -6, width: 80, height: 80, borderRadius: 40, backgroundColor: 'rgba(185,198,255,0.34)' },
  mid: { flex: 1, gap: 6 },
  level: { fontFamily: fonts.ui, fontSize: 22, fontWeight: '700', color: '#ECE8F4' },
  bar: { alignSelf: 'stretch', borderRadius: 3, overflow: 'hidden' },
  coins: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  disc: { width: 12, height: 12, borderRadius: 6, backgroundColor: '#FFC857' },
  coinText: { fontFamily: fonts.uiMedium, fontSize: 14, color: tide.textDim },
  go: { width: 32, height: 32, borderRadius: 16, alignItems: 'center', justifyContent: 'center', backgroundColor: 'rgba(255,255,255,0.08)' },
  goText: { fontFamily: fonts.ui, fontSize: 18, color: '#ECE8F4' },
});
