import { Canvas, Fill, LinearGradient, vec } from '@shopify/react-native-skia';
import { useEffect, useMemo, useState } from 'react';
import { ScrollView, StyleSheet, Text, View } from 'react-native';
import Animated, { Easing, useAnimatedStyle, useReducedMotion, useSharedValue, withTiming } from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { CatAvatar } from '@/components/cat/cat-avatar';
import { OnboardingSky } from '@/components/onboarding/onboarding-sky';
import { fonts } from '@/constants/fonts';
import { tide, verb } from '@/constants/theme';
import type { CosmeticItem } from '@/lib/api';
import { isolate } from '@/lib/bidi';
import { useDir, useT } from '@/lib/i18n';
import { type Progress, equippedArt, itemArt } from '@/lib/progression';

const frac = (into: number, toNext: number) => (toNext > 0 ? Math.min(1, Math.max(0, into / (into + toNext))) : 1);
/** The disc behind each cat (F2c-6): the dark fur needs it to read on the night sky. */
const disc = (size: number) => ({ width: size + 16, height: size + 16, borderRadius: (size + 16) / 2 });

/**
 * The level-up screen after the first practice: level before and after, the
 * cat before and after wearing the gift (each on a disc) and the XP bar. Covers everything (the
 * guide host mounts it on top); the guide layer over it carries the tap to leave.
 */
export function StarterFinish({
  before,
  after,
  catalog,
  itemId,
}: {
  before: Progress | null;
  after: Progress;
  catalog: CosmeticItem[];
  itemId: string;
}) {
  const { t, locale } = useT();
  const dir = useDir();
  const insets = useSafeAreaInsets();
  const reduced = useReducedMotion();

  const leveled = !!before && after.level > before.level;
  const gift = catalog.find((c) => c.id === itemId) ?? null;
  const beforeArt = useMemo(() => (before ? equippedArt(before, catalog) : {}), [before, catalog]);
  const afterArt = useMemo(() => {
    const art = equippedArt(after, catalog);
    return gift ? { ...art, [gift.slot]: itemArt(gift) } : art;
  }, [after, catalog, gift]);

  const toFrac = frac(after.xp_into_level, after.xp_to_next);
  const fromFrac = leveled || !before ? 0 : frac(before.xp_into_level, before.xp_to_next);
  const fill = useSharedValue(reduced ? toFrac : fromFrac);
  useEffect(() => {
    fill.value = reduced ? toFrac : withTiming(toFrac, { duration: 900, easing: Easing.out(Easing.cubic) });
  }, [fill, toFrac, reduced]);
  const fillStyle = useAnimatedStyle(() => ({ width: `${Math.round((Number.isFinite(fill.value) ? fill.value : 0) * 100)}%` }));
  const [trackW, setTrackW] = useState(0);

  const num = (n: number) => n.toLocaleString(locale);
  const xpRight = after.xp_to_next > 0 ? `${num(after.xp_into_level)} / ${num(after.xp_into_level + after.xp_to_next)} XP` : `${num(after.xp)} XP`;

  return (
    <View style={styles.root}>
      <OnboardingSky />
      <ScrollView contentContainerStyle={[styles.content, { paddingTop: insets.top + 24, paddingBottom: insets.bottom + 24 }]}>
        <Text style={[styles.kicker, dir.rtl && styles.kickerRtl]}>{leveled ? t('intro.finish.levelUp') : t('intro.finish.level', { n: after.level })}</Text>
        <Text style={styles.heading}>{leveled ? isolate(dir.rtl ? `${after.level} ← ${before.level}` : `${before.level} → ${after.level}`) : isolate(String(after.level))}</Text>

        <View style={[styles.cats, dir.row]}>
          <View style={styles.catCol}>
            <View style={[styles.disc, disc(130)]}>
              <CatAvatar size={130} equipped={beforeArt} />
            </View>
            <Text style={[styles.caption, { color: tide.textDim }]}>{t('intro.finish.before')}</Text>
          </View>
          <Text style={styles.arrow}>{dir.rtl ? '←' : '→'}</Text>
          <View style={styles.catCol}>
            <View style={[styles.disc, disc(140)]}>
              <CatAvatar size={140} equipped={afterArt} emotion="proud" />
            </View>
            {gift ? <Text style={[styles.caption, { color: verb.read.c1 }]}>{t('intro.finish.on', { item: gift.id === 'face.blush_pink' ? t('intro.finish.blush') : gift.name })}</Text> : null}
          </View>
        </View>

        <View style={[styles.xpRow, dir.row]}>
          <Text style={styles.xpText}>{t('intro.finish.xpLevel', { n: after.level })}</Text>
          <Text style={styles.xpText}>{xpRight}</Text>
        </View>
        <View style={styles.track} onLayout={(e) => setTrackW(e.nativeEvent.layout.width)}>
          <Animated.View style={[styles.fillClip, fillStyle]}>
            {trackW > 0 ? (
              <Canvas style={{ width: trackW, height: 10 }}>
                <Fill>
                  <LinearGradient start={vec(0, 0)} end={vec(trackW, 0)} colors={[verb.read.c1, '#FFE9A8']} />
                </Fill>
              </Canvas>
            ) : null}
          </Animated.View>
        </View>
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { ...StyleSheet.absoluteFill, backgroundColor: tide.water },
  content: { paddingHorizontal: 24, gap: 0 },
  kicker: { fontFamily: fonts.uiMedium, fontSize: 12, letterSpacing: 2, textTransform: 'uppercase', color: verb.read.c1, textAlign: 'center' },
  // Hebrew has no capitals and reads oddly letter-spaced.
  kickerRtl: { letterSpacing: 0 },
  heading: { fontFamily: fonts.ui, fontSize: 40, fontWeight: '700', color: tide.text, textAlign: 'center', marginTop: 8 },
  cats: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 14, marginTop: 28 },
  catCol: { alignItems: 'center', gap: 8 },
  arrow: { fontFamily: fonts.ui, fontSize: 26, color: tide.textDim },
  disc: { alignItems: 'center', justifyContent: 'center', backgroundColor: 'rgba(124,200,255,0.12)' },
  caption: { fontFamily: fonts.uiMedium, fontSize: 12 },
  xpRow: { flexDirection: 'row', justifyContent: 'space-between', marginTop: 28 },
  xpText: { fontFamily: fonts.ui, fontSize: 12, color: tide.textDim },
  track: { height: 10, borderRadius: 5, backgroundColor: 'rgba(255,255,255,0.10)', overflow: 'hidden', marginTop: 8 },
  fillClip: { height: 10, borderRadius: 5, overflow: 'hidden' },
});
