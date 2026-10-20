import { useFocusEffect, useRouter } from 'expo-router';
import { useCallback, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';

import { CatAvatar } from '@/components/cat/cat-avatar';
import { XpBar } from '@/components/cat/level-header';
import { PressScale } from '@/components/press-scale';
import { GlassPanel } from '@/components/prism';
import type { Equipped } from '@/constants/cosmetics';
import { fonts } from '@/constants/fonts';
import { tide } from '@/constants/theme';
import { getUsername } from '@/lib/api';
import { useGuideAnchor } from '@/lib/guide';
import { useDir, useT } from '@/lib/i18n';
import { equippedArt, useProgress } from '@/lib/progression';

export type CatBadgeViewProps = {
  level: number;
  xpIntoLevel: number;
  xpToNext: number;
  coins: number;
  equipped: Equipped;
  /** The account handle without the @. Null until known; a placeholder shows. */
  username?: string | null;
  /** Founder serial (the 7 in #007). Hidden when absent. */
  serial?: number | null;
  onPress: () => void;
};

/** Step the handle size by length so long names fit without an ellipsis. */
function nameSize(len: number) {
  return len <= 8 ? 25 : len <= 12 ? 22 : 19;
}

/** The Home entry row: the cat, level, XP bar and coins as one control. */
function CatBadgeView({ level, xpIntoLevel, xpToNext, coins, equipped, username, serial, onPress }: CatBadgeViewProps) {
  const { t } = useT();
  const dir = useDir();
  const name = username || 'you';
  const size = nameSize(name.length);
  return (
    <PressScale onPress={onPress} accessibilityRole="button" accessibilityLabel={t('wardrobe.title')} style={styles.wrap}>
      <GlassPanel radius={34} style={[styles.panel, dir.row]}>
        <View pointerEvents="none" style={styles.sheen} />
        <View pointerEvents="none" style={styles.glow} />
        <CatAvatar size={56} equipped={equipped} frameRate={30} />
        <View style={styles.mid}>
          <View style={[styles.handleRow, dir.row]}>
            <Text numberOfLines={1} style={[styles.handle, { fontSize: size, lineHeight: size + 4 }]}>
              <Text style={styles.at}>@</Text>
              {name}
            </Text>
            {serial != null && serial > 0 ? (
              <Text style={styles.serial}>#{String(serial).padStart(3, '0')}</Text>
            ) : null}
          </View>
          <View style={[styles.lvRow, dir.row]}>
            <Text style={styles.level}>{t('wardrobe.lv', { n: level })}</Text>
            <View style={styles.bar}>
              <XpBar height={6} fraction={xpToNext > 0 ? xpIntoLevel / xpToNext : 1} />
            </View>
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

/** Connected to the shared progress cache; reserves its height until the first load lands. */
export function CatBadge({ anchorGuide = false }: { anchorGuide?: boolean }) {
  const router = useRouter();
  const { progress, catalog } = useProgress();
  const [username, setName] = useState<string | null>(null);
  // BL-64: the guide's cat step lights the card. PressScale forwards no ref, so the box comes from a wrapper.
  const anchor = useGuideAnchor('catBadge', anchorGuide);
  // Refetch on focus so a handle picked in the gate shows on return to Home.
  useFocusEffect(
    useCallback(() => {
      let alive = true;
      getUsername()
        .then((n) => alive && setName(n))
        .catch(() => undefined);
      return () => {
        alive = false;
      };
    }, []),
  );
  // Reserve the row height so Home does not jump when progress lands (or never does, offline).
  if (!progress || !catalog) return <View style={styles.placeholder} />;
  return (
    <View ref={anchor.ref} onLayout={anchor.onLayout} collapsable={false}>
      <CatBadgeView
        level={progress.level}
        xpIntoLevel={progress.xp_into_level}
        xpToNext={progress.xp_to_next}
        coins={progress.coins}
        equipped={equippedArt(progress, catalog)}
        username={username}
        onPress={() => router.push('/wardrobe')}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: {},
  placeholder: { height: 68 },
  panel: { flexDirection: 'row', alignItems: 'center', height: 68, paddingStart: 10, paddingEnd: 14, gap: 12, overflow: 'hidden' },
  sheen: { ...StyleSheet.absoluteFill, backgroundColor: 'rgba(255,255,255,0.04)' },
  glow: { position: 'absolute', start: -2, top: -6, width: 80, height: 80, borderRadius: 40, backgroundColor: 'rgba(185,198,255,0.34)' },
  mid: { flex: 1, gap: 3 },
  handleRow: { flexDirection: 'row', alignItems: 'baseline', gap: 6 },
  handle: { flexShrink: 1, fontFamily: fonts.ui, fontWeight: '800', letterSpacing: -0.5, color: '#ECE8F4', textAlign: 'left' },
  at: { fontWeight: '600', color: 'rgba(185,198,255,0.75)' },
  serial: { flexGrow: 0, flexShrink: 0, fontFamily: fonts.ui, fontSize: 13, fontWeight: '700', color: '#FFC857', fontVariant: ['tabular-nums'] },
  lvRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  level: { fontFamily: fonts.ui, fontSize: 13, fontWeight: '700', color: '#B7B1C6' },
  bar: { flex: 1, borderRadius: 3, overflow: 'hidden' },
  coins: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  disc: { width: 12, height: 12, borderRadius: 6, backgroundColor: '#FFC857' },
  coinText: { fontFamily: fonts.uiMedium, fontSize: 14, color: tide.textDim },
  go: { width: 32, height: 32, borderRadius: 16, alignItems: 'center', justifyContent: 'center', backgroundColor: 'rgba(255,255,255,0.08)' },
  goText: { fontFamily: fonts.ui, fontSize: 18, color: '#ECE8F4' },
});
