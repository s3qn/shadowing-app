/**
 * The streak sheets (BL-80, mocks M1-4 and M3-3): the Streak sheet Home's
 * flame opens (the streak, freezes held, buy one) and the sheet that says a
 * streak ended. Both buy through `buyFreezeFlow`, the one place a freeze is sold.
 * Buy closes the sheet first and opens it again once the confirm settles: on
 * iOS a confirm Modal raised over a still-open sheet Modal can fail to show.
 */

import { useRouter } from 'expo-router';
import { useEffect, useRef, useState } from 'react';
import { Pressable, StyleSheet, Text, useWindowDimensions, View } from 'react-native';

import { PrismButton } from '@/components/prism/prism-button';
import { BottomSheet } from '@/components/sheet/bottom-sheet';
import { fonts } from '@/constants/fonts';
import { tide } from '@/constants/theme';
import { hapticImpact } from '@/lib/haptics';
import { useDir, useT } from '@/lib/i18n';
import { clearStreakMoment } from '@/lib/level-up-store';
import { setSeenStreak } from '@/lib/practice';
import { useProgressCache } from '@/lib/progression';
import { buyFreezeFlow, freezeInfo } from '@/lib/streak-freeze';

const ICE = '#9CD6FF';
const PALE = '#FFE3A0';

/** "150 🪙" in the gold chip the buy pill carries. */
function CoinChip({ n }: { n: number }) {
  return (
    <View style={styles.coin}>
      <Text style={styles.coinText}>{`${n} 🪙`}</Text>
    </View>
  );
}

/** One freeze slot: lit ice when held, a dashed outline when free. */
function Pip({ on }: { on: boolean }) {
  return (
    <View style={[styles.pip, on ? styles.pipOn : styles.pipOff]}>
      <Text style={[styles.pipGlyph, { color: on ? ICE : 'rgba(156,214,255,0.35)' }]}>❄</Text>
    </View>
  );
}

export function StreakSheet({ open, onClose, streak, longest }: { open: boolean; onClose: () => void; streak: number; longest: number }) {
  const { t, locale } = useT();
  const { width: screenW } = useWindowDimensions();
  const dir = useDir();
  const { progress } = useProgressCache();
  const info = freezeInfo(progress);
  // True from the Buy tap until the confirm settles: the sheet steps aside for it.
  const [buying, setBuying] = useState(false);
  const frozen = progress?.frozen_days ?? [];
  const lastUsed = frozen.length > 0 ? frozen[frozen.length - 1] : null;
  const buyHint =
    info.reason === 'cap' ? t('streak.atCap') : info.reason === 'coins' ? t('streak.needCoins', { n: Math.max(0, info.price - (progress?.coins ?? 0)) }) : null;

  return (
    <BottomSheet
      open={open && !buying}
      onClose={onClose}
      onDismissed={() => {
        if (!buying) return;
        void buyFreezeFlow().finally(() => setBuying(false));
      }}
      title={t('streak.title')}>
      <View style={styles.body}>
        <View style={[styles.hero, dir.row]}>
          <Text style={styles.heroFlame}>🔥</Text>
          <Text style={styles.heroNum}>{streak}</Text>
          <View>
            <Text style={[styles.heroLabel, dir.text]}>{t('streak.dayStreak', { n: streak })}</Text>
            <Text style={[styles.heroSub, dir.text]}>{t('streak.longest', { n: Math.max(longest, streak) })}</Text>
          </View>
        </View>
        <View style={[styles.held, dir.row]} accessible accessibilityLabel={t('streak.held', { held: info.held, cap: info.cap })}>
          <View style={styles.pips}>
            {Array.from({ length: info.cap }, (_, i) => (
              <Pip key={i} on={i < info.held} />
            ))}
          </View>
          <Text style={styles.heldText}>{t('streak.held', { held: info.held, cap: info.cap })}</Text>
        </View>
        {lastUsed ? (
          <Text style={styles.hint}>
            {t('streak.lastUsed', { date: new Date(`${lastUsed}T12:00:00`).toLocaleDateString(locale, { month: 'short', day: 'numeric' }) })}
          </Text>
        ) : null}
        {/* Disabled at the mock's 0.55, not PrismButton's own 0.35. */}
        <View style={!info.canBuy && styles.off} pointerEvents={info.canBuy ? 'auto' : 'none'}>
          <PrismButton
            shape="pill"
            flat
            verb="tools"
            width={screenW - 40}
            height={44}
            accessibilityLabel={t('streak.buy', { n: info.price })}
            accessibilityState={{ disabled: !info.canBuy }}
            containerStyle={styles.stretch}
            style={styles.buyFace}
            onPress={() => setBuying(true)}>
            <Text style={styles.buyText}>{t('streak.buyLabel')}</Text>
            <CoinChip n={info.price} />
          </PrismButton>
        </View>
        {buyHint ? <Text style={styles.hint}>{buyHint}</Text> : null}
        <Text style={styles.how}>{t('streak.how')}</Text>
      </View>
    </BottomSheet>
  );
}

/** M3-3: the streak ended. Start a new one (the review run), buy a freeze for it, or Not now. */
export function StreakBrokenSheet({ lost }: { lost: number }) {
  const { t } = useT();
  const { width: screenW } = useWindowDimensions();
  const router = useRouter();
  const { progress } = useProgressCache();
  const info = freezeInfo(progress);
  const [open, setOpen] = useState(true);
  const [bought, setBought] = useState(false);
  const after = useRef<'start' | 'buy' | null>(null);

  useEffect(() => {
    // Seen once it is on screen: a kill before this shows it again next time.
    void setSeenStreak(0);
    void hapticImpact();
  }, []);

  const longest = Math.max(progress?.longest_streak ?? 0, lost);
  const close = () => setOpen(false);

  return (
    <BottomSheet
      open={open}
      onClose={close}
      onDismissed={() => {
        if (after.current === 'buy') {
          // The moment stays pending while the confirm is up, then comes back.
          after.current = null;
          void buyFreezeFlow()
            .catch(() => false)
            .then((ok) => {
              if (ok) setBought(true);
              setOpen(true);
            });
          return;
        }
        clearStreakMoment();
        if (after.current === 'start') router.push('/review');
      }}>
      <View style={styles.body}>
        <View style={styles.brokenFlame}>
          <Text style={styles.brokenEmoji}>🔥</Text>
          {/* Darkens the emoji the way the mock's brightness filter does. */}
          <View pointerEvents="none" style={styles.brokenShade} />
        </View>
        <Text style={styles.brokenTitle}>{t('streak.endedTitle', { n: lost })}</Text>
        <Text style={styles.brokenLongest}>{t('streak.longest', { n: longest })}</Text>
        <Text style={styles.tip}>{t('streak.freezeTip')}</Text>
        <View style={styles.stack}>
          <PrismButton
            shape="pill"
            verb="along"
            on
            width={screenW - 40}
            height={48}
            label={t('streak.startNew')}
            containerStyle={styles.stretch}
            onPress={() => {
              after.current = 'start';
              close();
            }}
          />
          {bought ? (
            <View style={styles.ready}>
              <Text style={styles.readyText}>{t('streak.freezeReady')}</Text>
            </View>
          ) : info.canBuy ? (
            <PrismButton
              shape="pill"
              flat
              verb="tools"
              width={screenW - 40}
              height={44}
              label={t('streak.buyFreeze', { n: info.price })}
              containerStyle={styles.stretch}
              onPress={() => {
                after.current = 'buy';
                close();
              }}
            />
          ) : null}
          <Pressable onPress={close} accessibilityRole="button" style={styles.notNow} hitSlop={6}>
            <Text style={styles.notNowText}>{t('streak.notNow')}</Text>
          </Pressable>
        </View>
      </View>
    </BottomSheet>
  );
}

const styles = StyleSheet.create({
  body: { alignSelf: 'stretch' },
  stretch: { alignSelf: 'stretch' },
  hero: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 12, marginTop: 12, marginBottom: 4 },
  heroFlame: { fontSize: 40, lineHeight: 48, textShadowColor: 'rgba(255,150,60,0.55)', textShadowRadius: 22, textShadowOffset: { width: 0, height: 0 } },
  heroNum: {
    fontFamily: fonts.ui,
    fontSize: 44,
    lineHeight: 50,
    fontWeight: '700',
    color: PALE,
    fontVariant: ['tabular-nums'],
    textShadowColor: 'rgba(245,196,81,0.30)',
    textShadowRadius: 18,
    textShadowOffset: { width: 0, height: 0 },
  },
  heroLabel: { fontFamily: fonts.ui, fontSize: 13, fontWeight: '600', color: tide.textDim },
  heroSub: { fontFamily: fonts.ui, fontSize: 12, color: tide.textDim },
  held: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 12, marginTop: 10, marginBottom: 6 },
  // The slots read left to right in every language, like a counter.
  pips: { flexDirection: 'row', gap: 8, direction: 'ltr' },
  pip: { width: 36, height: 42, borderRadius: 14, alignItems: 'center', justifyContent: 'center' },
  pipOn: {
    borderWidth: 1,
    borderColor: 'rgba(156,214,255,0.55)',
    backgroundColor: 'rgba(156,214,255,0.14)',
    shadowColor: ICE,
    shadowOpacity: 0.25,
    shadowRadius: 7,
    shadowOffset: { width: 0, height: 0 },
  },
  pipOff: { borderWidth: 1.5, borderStyle: 'dashed', borderColor: 'rgba(156,214,255,0.35)' },
  pipGlyph: { fontSize: 18 },
  heldText: { fontFamily: fonts.uiMedium, fontSize: 15, fontWeight: '500', color: tide.text },
  off: { opacity: 0.55 },
  buyFace: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  buyText: { fontFamily: fonts.ui, fontSize: 15, fontWeight: '700', color: tide.text },
  coin: {
    paddingHorizontal: 9,
    paddingVertical: 3,
    borderRadius: 999,
    backgroundColor: 'rgba(255,200,87,0.12)',
    borderWidth: 1,
    borderColor: 'rgba(255,200,87,0.3)',
  },
  coinText: { fontFamily: fonts.ui, fontSize: 12, fontWeight: '600', color: PALE, writingDirection: 'ltr' },
  hint: { fontFamily: fonts.ui, fontSize: 12, color: tide.textDim, textAlign: 'center', marginTop: 8 },
  how: { fontFamily: fonts.ui, fontSize: 12, lineHeight: 17, color: tide.textDim, textAlign: 'center', marginTop: 16, marginHorizontal: 6 },
  brokenFlame: { alignSelf: 'center', marginTop: 14, marginBottom: 6 },
  brokenEmoji: { fontSize: 56, lineHeight: 64, opacity: 0.4 },
  brokenShade: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, backgroundColor: 'rgba(11,10,16,0.45)' },
  brokenTitle: { fontFamily: fonts.ui, fontSize: 20, lineHeight: 26, fontWeight: '700', color: tide.text, textAlign: 'center' },
  brokenLongest: { fontFamily: fonts.ui, fontSize: 14, color: tide.textDim, textAlign: 'center', marginTop: 6 },
  tip: { fontFamily: fonts.ui, fontSize: 14, lineHeight: 20, color: ICE, textAlign: 'center', marginTop: 14, marginHorizontal: 8, marginBottom: 18 },
  stack: { gap: 10 },
  ready: {
    height: 44,
    borderRadius: 999,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(156,214,255,0.08)',
    borderWidth: 1,
    borderColor: 'rgba(156,214,255,0.25)',
  },
  readyText: { fontFamily: fonts.ui, fontSize: 14, fontWeight: '600', color: tide.textDim },
  notNow: { alignItems: 'center', padding: 8 },
  notNowText: { fontFamily: fonts.ui, fontSize: 14, color: tide.textDim },
});
