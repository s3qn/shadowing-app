import * as Haptics from 'expo-haptics';
import { useRouter } from 'expo-router';
import { useEffect, useMemo, useState } from 'react';
import { BackHandler, Pressable, ScrollView, StyleSheet, Text, TextInput, View, useWindowDimensions } from 'react-native';
import Animated, {
  Easing,
  cancelAnimation,
  runOnJS,
  useAnimatedProps,
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
  withDelay,
  withSequence,
  withTiming,
  type SharedValue,
} from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { CatAvatar } from '@/components/cat/cat-avatar';
import { ItemDisc } from '@/components/cat/item-grid';
import { Frost } from '@/components/frost';
import { GlassPanel, PrismButton } from '@/components/prism';
import { HeroGlow, HeroNumber, heroText } from '@/components/tide/hero-number';
import { Canvas, LinearGradient, RoundedRect, vec } from '@shopify/react-native-skia';

import { Tile as GradTile, type Look } from '@/components/tide/ladder-stage';
import { useEmotionPulse } from '@/hooks/use-emotion-pulse';
import { fonts } from '@/constants/fonts';
import { tide } from '@/constants/theme';
import { isolate } from '@/lib/bidi';
import { hapticImpact, hapticNotify } from '@/lib/haptics';
import { useDir, useT } from '@/lib/i18n';
import { clearCelebration, clearLevelUp, clearStreakMoment, clearXpToast, useXpToast, type Celebration, type PendingLevelUp, type RecapLine, type StreakMilestone } from '@/lib/level-up-store';
import { equippedArt, markUnlockSeen, useProgressCache } from '@/lib/progression';
import { EmberGlow, WEEKDAY_KEY } from '@/components/practice-card';
import { dayQualifies, devStreakActive, getPracticeLog, lastSevenDays } from '@/lib/practice';
import { getSettingsSync } from '@/lib/settings';

// BL-51, picked mock .claude/design/S4-r2.html: the session summary, the XP
// moment and the level-up, one screen in three states. Also the "+N XP" toast.

const GOLD = '#FFC857';
const PALE = '#FFE3A0';
const OUT_CUBIC = Easing.out(Easing.cubic);
const SUCCESS = Haptics.NotificationFeedbackType.Success;
const INOUT_QUAD = Easing.inOut(Easing.quad);
const OUT_QUAD = Easing.out(Easing.quad);

// The session cheer is in the language being learned. The level-up cheer is Japanese only for ja
// learners (flavour); everyone else gets it in the UI language.
const CHEER: Record<string, { done: string; level: string }> = {
  ja: { done: 'よくできました', level: 'レベルアップ！' },
  es: { done: '¡Bien hecho!', level: '¡Subiste de nivel!' },
  en: { done: 'Well done!', level: 'Level up!' },
};

type Band = 'strong' | 'steady' | 'building';
const band = (n: number): Band => (n >= 80 ? 'strong' : n >= 50 ? 'steady' : 'building');
const BAND_COLOR: Record<Band, string> = { strong: '#7FD8C4', steady: tide.text, building: tide.textDim };

// Tile tints as "r,g,b", from the mock's tile classes.
const KIND: Record<RecapLine['kind'], { emoji: string; tint: string; mix: string }> = {
  podcast: { emoji: '🎧', tint: '201,184,255', mix: '#C9B8FF' },
  video: { emoji: '🎬', tint: '124,200,255', mix: '#7CC8FF' },
  island: { emoji: '🏝️', tint: '255,200,87', mix: GOLD },
};

function Tile({ emoji, tint, size = 40 }: { emoji: string; tint: string; size?: number }) {
  const look: Look = { tint: `rgb(${tint})`, from: 0.4, to: 0.12, rim: 0.55 };
  return (
    <GradTile look={look} size={size} radius={size === 40 ? 12 : size >= 44 ? 14 : 12} fontSize={size === 40 ? 19 : 22}>
      {emoji}
    </GradTile>
  );
}

/** The mock's two-tone level bar: this session's new XP over the already-earned part, with the dashed start marker. */
function XpFill({ bar, base, ghost }: { bar: SharedValue<number>; base: SharedValue<number>; ghost: number }) {
  const { rtl } = useDir();
  const fresh = useAnimatedStyle(() => ({ transform: [{ scaleX: Number.isFinite(bar.value) ? Math.min(1, Math.max(0, bar.value)) : 0 }] }));
  const old = useAnimatedStyle(() => {
    const b = Number.isFinite(bar.value) ? bar.value : 0;
    const o = Number.isFinite(base.value) ? base.value : 0;
    return { transform: [{ scaleX: Math.min(1, Math.max(0, Math.min(b, o))) }] };
  });
  return (
    <>
      <Animated.View style={[styles.barFill, rtl && styles.barFillRtl, styles.barNew, fresh]}>
        <BarGrad from="rgba(255,200,87,0.55)" to="#FFE3A0" rtl={rtl} />
      </Animated.View>
      <Animated.View style={[styles.barFill, rtl && styles.barFillRtl, old]}>
        <BarGrad from="#C9962E" to="#FFC857" rtl={rtl} />
      </Animated.View>
      {ghost > 0 && ghost < 1 ? <View pointerEvents="none" style={[styles.ghost, rtl && styles.ghostRtl, { width: `${ghost * 100}%` }]} /> : null}
    </>
  );
}

function BarGrad({ from, to, rtl }: { from: string; to: string; rtl: boolean }) {
  const [w, setW] = useState(0);
  return (
    <View style={StyleSheet.absoluteFill} onLayout={(e) => setW(e.nativeEvent.layout.width)}>
      {w > 0 ? (
        <Canvas style={StyleSheet.absoluteFill} pointerEvents="none">
          <RoundedRect x={0} y={0} width={w} height={12} r={6}>
            <LinearGradient start={vec(0, 0)} end={vec(w, 0)} colors={rtl ? [to, from] : [from, to]} />
          </RoundedRect>
        </Canvas>
      ) : null}
    </View>
  );
}

const AnimatedInput = Animated.createAnimatedComponent(TextInput);
const clock = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
const frac = (into: number, toNext: number) => (toNext > 0 ? Math.min(1, Math.max(0, into / (into + toNext))) : 1);

/** One breakdown row, faded in on its own slot of the shared stagger clock `rc` (0 to 1 over `span` ms). */
function Rise({ rc, i, span, lift, children }: { rc: SharedValue<number>; i: number; span: number; lift: number; children: React.ReactNode }) {
  const style = useAnimatedStyle(() => {
    const p = Math.min(1, Math.max(0, (rc.value * span - 50 * Math.min(i, 6)) / 200));
    const e = 1 - (1 - p) ** 3;
    return { opacity: e, transform: [{ translateY: (1 - e) * lift }] };
  });
  return <Animated.View style={style}>{children}</Animated.View>;
}

type Props = { c: Celebration | null; levelUp: PendingLevelUp | null };

/** The full-screen summary. `c` null shows only the level-up (one earned outside a session). */
export function SessionCelebration({ c, levelUp }: Props) {
  const { t, locale } = useT();
  const dir = useDir();
  const reduced = useReducedMotion();
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const { width } = useWindowDimensions();
  const { progress, catalog } = useProgressCache();
  const cheer = CHEER[getSettingsSync().learningLanguage] ?? CHEER.en;
  const levelOnly = !c;
  const [stage, setStage] = useState<'summary' | 'xp'>(c?.recap ? 'summary' : 'xp');

  const xp = c?.xp ?? 0;
  const level = c?.after.level ?? levelUp?.level ?? 1;
  const prevLevel = c?.before.level ?? levelUp?.prevLevel ?? level - 1;
  const hoursOnly = levelOnly && !!levelUp?.hoursItem && levelUp.level === levelUp.prevLevel;
  const leveled = hoursOnly ? false : levelOnly || level > prevLevel;
  const [catEmotion, fireEmotion] = useEmotionPulse();
  const avgScore = c?.avgScore ?? null;
  useEffect(() => {
    if (leveled) fireEmotion(avgScore !== null && band(avgScore) === 'building' ? 'encouraging' : 'proud', 4000);
  }, [leveled, avgScore, fireEmotion]);
  const beforeFrac = c ? frac(c.before.into, c.before.toNext) : 0;
  const afterFrac = c ? frac(c.after.into, c.after.toNext) : progress ? frac(progress.xp_into_level, progress.xp_to_next) : 0;
  const equipped = useMemo(() => (progress && catalog ? equippedArt(progress, catalog) : {}), [progress, catalog]);
  const hoursItem = levelUp?.hoursItem;
  const unlocked = useMemo(
    () => {
      if (!catalog) return null;
      if (hoursItem) return catalog.find((it) => it.id === hoursItem) ?? null;
      return leveled ? catalog.find((it) => !it.grant_only && !it.hours_req && it.level_req > prevLevel && it.level_req <= level) ?? null : null;
    },
    [leveled, catalog, prevLevel, level, hoursItem],
  );

  const rows = useMemo(() => {
    if (!c) return [];
    const b = c.breakdown;
    const out: { emoji: string; tint: string; label: string; value: string }[] = [
      { emoji: '🗣️', tint: '124,200,255', label: t('summary.rowSentences', { n: c.sentences }), value: `+${b ? b.sentences : xp}` },
    ];
    if (b && b.score > 0) out.push({ emoji: '🎯', tint: '127,216,196', label: t('summary.rowScore'), value: `+${b.score}` });
    if (b && b.first > 0) out.push({ emoji: '🌅', tint: '255,200,87', label: t('summary.rowFirst'), value: `+${b.first}` });
    if (c.streak > 0) out.push({ emoji: '🔥', tint: '255,150,80', label: t('summary.rowStreak'), value: b && b.streak > 0 ? `+${b.streak}` : t('summary.days', { n: c.streak }) });
    if (c.coins > 0) out.push({ emoji: '🪙', tint: '255,200,87', label: t('summary.rowCoins'), value: `+${c.coins}` });
    return out;
  }, [c, xp, t]);
  const span = 200 + 50 * (Math.min(rows.length, 7) - 1);

  const flo = useSharedValue(0);
  const swap = useSharedValue(0);
  const v = useSharedValue(0);
  const bar = useSharedValue(0);
  const base = useSharedValue(beforeFrac);
  const refl = useSharedValue(0);
  const rc = useSharedValue(0);
  const lvl = useSharedValue(levelOnly ? 1 : 0);
  const reward = useSharedValue(0);
  const all = [flo, swap, v, bar, base, refl, rc, lvl, reward];

  const finals = () => {
    all.forEach(cancelAnimation);
    flo.value = 1;
    swap.value = 1;
    v.value = xp;
    bar.value = afterFrac;
    base.value = leveled ? 0 : beforeFrac;
    refl.value = 1;
    rc.value = 1;
    lvl.value = leveled || levelOnly ? 1 : 0;
    reward.value = 1;
  };

  // T0 is the mount of a stage. The summary only brings its flourish in.
  useEffect(() => {
    if (reduced) {
      const fade = { duration: 150, easing: Easing.linear };
      v.value = xp;
      bar.value = afterFrac;
      base.value = leveled ? 0 : beforeFrac;
      if (stage === 'xp' && (xp > 0 || leveled || hoursOnly)) {
        if (leveled) void hapticNotify(SUCCESS);
        else void hapticImpact();
      }
      [flo, swap, refl, rc, reward].forEach((s) => (s.value = withTiming(1, fade)));
      if (stage === 'summary') swap.value = 0;
      if (stage === 'xp' && leveled) lvl.value = withTiming(1, fade);
      return () => all.forEach(cancelAnimation);
    }
    flo.value = 0;
    flo.value = withTiming(1, { duration: 220, easing: OUT_CUBIC });
    if (stage === 'summary') return () => all.forEach(cancelAnimation);
    if (levelOnly) {
      if (hoursOnly) void hapticImpact();
      else void hapticNotify(SUCCESS);
      bar.value = withDelay(250, withTiming(afterFrac, { duration: 350, easing: OUT_CUBIC }));
      reward.value = withDelay(400, withTiming(1, { duration: 220, easing: OUT_CUBIC }));
      return () => all.forEach(cancelAnimation);
    }
    swap.value = withDelay(500, withTiming(1, { duration: 250, easing: INOUT_QUAD }));
    if (xp > 0) {
      v.value = withDelay(750, withTiming(xp, { duration: 600, easing: OUT_CUBIC }, (done) => {
        if (done && !leveled) runOnJS(hapticImpact)();
      }));
    }
    if (leveled) {
      const wrapped = (done?: boolean) => {
        'worklet';
        if (done) runOnJS(hapticNotify)(SUCCESS);
      };
      bar.value = withDelay(750, withSequence(
        withTiming(beforeFrac, { duration: 700, easing: OUT_CUBIC }),
        withTiming(1, { duration: 300, easing: OUT_CUBIC }, wrapped),
        withTiming(0, { duration: 0 }),
        withTiming(afterFrac, { duration: 350, easing: OUT_CUBIC }),
      ));
      base.value = withDelay(1750, withTiming(0, { duration: 0 }));
      lvl.value = withDelay(1750, withTiming(1, { duration: 160, easing: Easing.linear }));
      reward.value = withDelay(1910, withTiming(1, { duration: 220, easing: OUT_CUBIC }));
    } else {
      bar.value = withDelay(750, withTiming(afterFrac, { duration: 700, easing: OUT_CUBIC }));
    }
    refl.value = withDelay(1400, withTiming(1, { duration: 200, easing: OUT_QUAD }));
    rc.value = withDelay(1500, withTiming(1, { duration: span, easing: Easing.linear }));
    return () => all.forEach(cancelAnimation);
    // The shared values are stable; the stage is the trigger.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stage, reduced]);

  const lift = reduced ? 0 : 1;
  const floStyle = useAnimatedStyle(() => ({ opacity: flo.value, transform: [{ translateY: (1 - flo.value) * 6 * lift }] }));
  const scoreStyle = useAnimatedStyle(() => ({ opacity: 1 - swap.value, transform: [{ translateY: -8 * swap.value * lift }] }));
  const xpStyle = useAnimatedStyle(() => ({ opacity: swap.value, transform: [{ translateY: 8 * (1 - swap.value) * lift }] }));
  const glowStyle = useAnimatedStyle(() => ({ opacity: xp > 0 && Number.isFinite(v.value) ? 0.35 + 0.65 * Math.min(1, v.value / xp) : 0.35 }));
  const reflStyle = useAnimatedStyle(() => ({ opacity: refl.value }));
  const xpLayer = useAnimatedStyle(() => ({ opacity: 1 - lvl.value }));
  const lvlLayer = useAnimatedStyle(() => ({ opacity: lvl.value }));
  const rewardStyle = useAnimatedStyle(() => ({ opacity: reward.value, transform: [{ translateY: (1 - reward.value) * 10 * lift }] }));
  const xpProps = useAnimatedProps(() => {
    const text = `+${Math.round(Number.isFinite(v.value) ? v.value : 0)}`;
    return { text, defaultValue: text } as object;
  });

  const done = () => {
    all.forEach(cancelAnimation);
    clearCelebration();
    clearLevelUp();
  };
  const toNextLine = (into: number, toNext: number, l: number) =>
    toNext > 0 ? [`${into.toLocaleString(locale)} / ${(into + toNext).toLocaleString(locale)}`, t('summary.toNext', { n: toNext.toLocaleString(locale), l: l + 1 })] : ['', t('summary.top')];
  const shown = leveled && c ? c.before : c?.after;
  const [barLeft, barRight] = shown ? toNextLine(shown.into, shown.toNext, shown.level) : ['', ''];

  const avg = c?.avgScore ?? null;
  const scoreHero = avg !== null ? (
    <>
      <HeroNumber value={avg} />
      <Text style={[styles.heroSub, dir.text]}>
        {t('summary.score')} · <Text style={{ color: BAND_COLOR[band(avg)] }}>{t(`summary.${band(avg)}`)}</Text>
      </Text>
    </>
  ) : null;

  const ctaBottom = insets.bottom + 28;
  const cta = stage === 'summary' && xp > 0 ? t('summary.collect') : t('summary.done');

  return (
    <View style={[StyleSheet.absoluteFill, styles.root]} accessibilityViewIsModal>
      <View style={[styles.header, dir.row, { marginTop: insets.top }]}>
        <Pressable style={styles.close} onPress={done} accessibilityRole="button" accessibilityLabel={t('summary.close')} hitSlop={8}>
          <Text style={styles.closeGlyph}>✕</Text>
        </Pressable>
        <View style={styles.headTitle}>
          <Text style={[styles.title, dir.writing]}>{levelOnly ? (hoursOnly ? t('summary.newItem') : t('summary.levelWord')) : t('summary.title')}</Text>
          {levelOnly ? null : <Text style={[styles.sub, dir.writing]}>{t('summary.sub')}</Text>}
        </View>
        <View style={styles.closeSpacer} />
      </View>

      {stage === 'summary' && c?.recap ? (
        <ScrollView contentContainerStyle={[styles.body, { paddingBottom: ctaBottom + 80 }]}>
          <Animated.Text style={[styles.flourish, dir.content, floStyle]}>{cheer.done}</Animated.Text>
          <View style={styles.hero}>{scoreHero ?? <HeroNumber value={0} label="–" />}</View>
          <Summary lines={c.recap.lines} seconds={c.recap.seconds} />
          {c.offline ? <Text style={[styles.caption, dir.text, { marginTop: 14 }]}>{t('summary.syncLater')}</Text> : null}
        </ScrollView>
      ) : (
        <View style={styles.fill}>
          {!levelOnly ? (
            <Animated.View style={[styles.fill, xpLayer]}>
              <View style={styles.body}>
                <Animated.Text style={[styles.lbl, dir.text, floStyle]}>{t('summary.level', { n: prevLevel }).toUpperCase()}</Animated.Text>
                <View style={styles.hero}>
                  {scoreHero ? <Animated.View style={[styles.heroLayer, scoreStyle]}>{scoreHero}</Animated.View> : null}
                  <Animated.View style={[styles.heroLayer, xpStyle]}>
                    <View style={[styles.xpBox, dir.rtl && styles.xpBoxRtl]}>
                      <Animated.View style={[StyleSheet.absoluteFill, glowStyle]} pointerEvents="none">
                        <HeroGlow />
                      </Animated.View>
                      <Text style={[heroText, styles.xpNum, styles.sizer]}>+{xp}</Text>
                      <AnimatedInput editable={false} pointerEvents="none" underlineColorAndroid="transparent" style={[heroText, styles.xpNum, styles.xpInput]} animatedProps={xpProps} defaultValue="+0" />
                    </View>
                    <Text style={[styles.heroSub, dir.text]}>{t('summary.xpSession')}</Text>
                  </Animated.View>
                </View>
              </View>
              <View style={styles.water}>
                <View style={styles.waterline} />
                <Animated.View style={[styles.reflBox, dir.rtl && styles.reflBoxRtl, reflStyle]} pointerEvents="none">
                  <Frost frosted blur={1.5} ink={PALE}>
                    <Text style={[heroText, styles.xpNum, styles.refl]}>+{xp}</Text>
                  </Frost>
                </Animated.View>
                <View style={styles.pad}>
                  <View style={styles.track}>
                    <XpFill bar={bar} base={base} ghost={leveled ? 0 : beforeFrac} />
                  </View>
                  <View style={[styles.barCaption, dir.row]}>
                    <Text style={styles.caption}>{barLeft}</Text>
                    <Text style={styles.caption}>{barRight}</Text>
                  </View>
                  <View style={styles.rows}>
                    {rows.map((r, i) => (
                      <Rise key={r.label} rc={rc} i={i} span={span} lift={6 * lift}>
                        <View style={[styles.xr, dir.row]}>
                          <Tile emoji={r.emoji} tint={r.tint} />
                          <Text style={[styles.xrLabel, dir.text]}>{r.label}</Text>
                          <Text style={styles.xrValue}>{r.value}</Text>
                        </View>
                      </Rise>
                    ))}
                  </View>
                </View>
              </View>
            </Animated.View>
          ) : null}
          {leveled || hoursOnly ? (
            <Animated.View style={[StyleSheet.absoluteFill, styles.body, hoursOnly && styles.bodyCentred, lvlLayer]} pointerEvents="none">
              {hoursOnly ? null : <Animated.Text style={[styles.flourish, dir.content, floStyle]}>{getSettingsSync().learningLanguage === 'ja' ? cheer.level : t('summary.cheerLevel')}</Animated.Text>}
              {hoursOnly ? null : <View style={[styles.levelRow, dir.row]}>
                <View>
                  <Text style={[styles.lbl, dir.text, { color: GOLD }]}>{t('summary.levelWord').toUpperCase()}</Text>
                  <View style={{ marginTop: 6 }}>
                    <HeroNumber value={level} size={120} />
                  </View>
                </View>
                <CatAvatar size={150} equipped={equipped} emotion={catEmotion} />
              </View>}
              {hoursOnly ? null : (
                <View style={[styles.track, { marginTop: 26 }]}>
                  <XpFill bar={bar} base={base} ghost={leveled ? 0 : beforeFrac} />
                </View>
              )}
              {c ? (
                <Text style={[styles.caption, dir.text, { marginTop: 8 }]}>
                  {t('summary.levelLine', { xp, into: c.after.into.toLocaleString(locale), l: level })}
                  {c.streak > 0 ? ` · 🔥 ${t('summary.days', { n: c.streak })}` : ''}
                </Text>
              ) : null}
              {unlocked || (levelUp?.coins ?? 0) > 0 ? (
                <Animated.View style={[styles.reward, hoursOnly ? styles.rewardBig : dir.row, rewardStyle]}>
                  {unlocked ? <ItemDisc item={unlocked} locked={false} size={hoursOnly ? 96 : 44} /> : <Tile emoji="🪙" tint="255,200,87" size={44} />}
                  <View style={hoursOnly ? styles.rewardText : styles.fill}>
                    <Text style={[styles.rewardTitle, hoursOnly ? dir.writing : dir.text]}>{unlocked ? t('summary.unlocked', { name: unlocked.name }) : t('summary.coins', { n: levelUp?.coins ?? 0 })}</Text>
                    {unlocked ? <Text style={[styles.caption, hoursOnly ? dir.writing : dir.text]}>{t('summary.wardrobe')}</Text> : null}
                  </View>
                </Animated.View>
              ) : null}
            </Animated.View>
          ) : null}
          {/* Tap anywhere above the CTA to jump to the end state. */}
          <Pressable style={StyleSheet.absoluteFill} onPress={finals} accessibilityRole="button" accessibilityLabel={t('summary.skip')} />
        </View>
      )}

      <View style={[styles.cta, { bottom: ctaBottom }]}>
        {hoursOnly && unlocked ? (
          <View style={{ marginBottom: 12 }}>
            <PrismButton
              shape="pill"
              verb="tools"
              on={false}
              width={width - 40}
              height={58}
              label={t('summary.tryOn')}
              onPress={() => {
                done();
                router.push({ pathname: '/wardrobe', params: { item: unlocked.id } });
              }}
            />
          </View>
        ) : null}
        <PrismButton shape="pill" verb="read" on width={width - 40} height={58} label={cta} onPress={stage === 'summary' && xp > 0 ? () => setStage('xp') : done} />
      </View>
    </View>
  );
}

/** Frame 1 below the hero: counts, the project mix, per-project rows and the best line. */
function Summary({ lines, seconds }: { lines: RecapLine[]; seconds: number }) {
  const { t } = useT();
  const dir = useDir();
  const words = lines.reduce((a, l) => a + l.words, 0);
  const projects = useMemo(() => {
    const by = new Map<string, { title: string; kind: RecapLine['kind']; n: number; scores: number[] }>();
    for (const l of lines) {
      const p = by.get(l.islandId) ?? { title: l.title, kind: l.kind, n: 0, scores: [] };
      p.n += 1;
      if (l.score !== null) p.scores.push(l.score);
      by.set(l.islandId, p);
    }
    return [...by.values()];
  }, [lines]);
  const best = lines.reduce<RecapLine | null>((b, l) => (l.score !== null && l.text && (!b || l.score > (b.score ?? -1)) ? l : b), null);
  const stat = (n: string, label?: string) => (
    <Text style={styles.statText}>
      <Text style={styles.statNum}>{n}</Text>
      {label ? ` ${label}` : ''}
    </Text>
  );
  return (
    <>
      <View style={[styles.stats, dir.row]}>
        {stat(String(lines.length), t('summary.sentences', { n: lines.length }))}
        {words > 0 ? stat(String(words), t('summary.words', { n: words })) : null}
        {stat(clock(seconds))}
      </View>
      <View style={[styles.mix, dir.row]}>
        {projects.map((p, i) => (
          <View key={i} style={{ flex: p.n, backgroundColor: KIND[p.kind].mix }} />
        ))}
      </View>
      <View style={{ marginTop: 10 }}>
        {projects.map((p, i) => {
          const avg = p.scores.length ? Math.round(p.scores.reduce((a, s) => a + s, 0) / p.scores.length) : null;
          return (
            <View key={i} style={[styles.pj, dir.row]}>
              <Tile emoji={KIND[p.kind].emoji} tint={KIND[p.kind].tint} />
              <View style={styles.fill}>
                <Text style={[styles.pjTitle, dir.text]}>{t(`summary.${p.kind}`)}</Text>
                <Text style={[styles.caption, dir.text]} numberOfLines={1}>
                  {isolate(p.title)} · {t('summary.lines', { n: p.n })}
                </Text>
              </View>
              {avg !== null ? (
                <Text style={[styles.pjAvg, { color: BAND_COLOR[band(avg)] }]}>
                  {avg}
                  <Text style={styles.caption}> {t('summary.avg')}</Text>
                </Text>
              ) : null}
            </View>
          );
        })}
      </View>
      {best && best.score !== null ? (
        <GlassPanel radius={20} style={styles.best}>
          <Text style={[styles.lbl, dir.text]}>
            {t('summary.best').toUpperCase()} · <Text style={{ color: BAND_COLOR[band(best.score)] }}>{best.score}</Text>
          </Text>
          <Text style={[styles.bestText, dir.content]}>{best.text}</Text>
          {best.en ? <Text style={[styles.bestEn, dir.content]}>{best.en}</Text> : null}
        </GlassPanel>
      ) : null}
    </>
  );
}

/** The compact form for XP earned outside a session: a gold "+N XP" pill that drops in and fades. */
export function XpToast() {
  const { t } = useT();
  const dir = useDir();
  const { n, id, cap } = useXpToast();
  const insets = useSafeAreaInsets();
  const reduced = useReducedMotion();
  const a = useSharedValue(0);
  useEffect(() => () => clearXpToast(), []);
  useEffect(() => {
    if (n <= 0 && !cap) return;
    cancelAnimation(a);
    a.value = withSequence(
      withTiming(1, { duration: reduced ? 150 : 200, easing: OUT_CUBIC }),
      withDelay(1400, withTiming(0, { duration: 200, easing: Easing.linear }, (fin) => {
        if (fin) runOnJS(clearXpToast)();
      })),
    );
    return () => cancelAnimation(a);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);
  const style = useAnimatedStyle(() => ({ opacity: a.value, transform: [{ translateY: reduced ? 0 : (1 - a.value) * -8 }] }));
  if (n <= 0 && !cap) return null;
  return (
    <Animated.View pointerEvents="none" style={[styles.toast, { top: insets.top + 8 }, style]}>
      <Text style={[styles.toastText, dir.writing]}>{cap ? `${isolate(t('review.xpEarned', { n }))} · ${t('ladder.xpCap')}` : isolate(t('review.xpEarned', { n }))}</Text>
    </Animated.View>
  );
}

const NUM_H = 100;
const FLAME_H = 86;

/**
 * M2-5, the streak went up: the flame fills over its dim copy, the number
 * rolls from n-1 to n, the week as seven flame discs, the milestone reward
 * and the cat. Tap above the CTA to jump to the end; the close button and
 * Keep going close it.
 */
export function StreakUpMoment({ streak, milestone }: { streak: number; milestone: StreakMilestone | null }) {
  const { t } = useT();
  const insets = useSafeAreaInsets();
  const { width, height } = useWindowDimensions();
  const reducedMotion = useReducedMotion();
  const { progress, catalog } = useProgressCache();
  const equipped = useMemo(() => (progress && catalog ? equippedArt(progress, catalog) : {}), [progress, catalog]);
  const [catEmotion, fireEmotion] = useEmotionPulse();
  const [week, setWeek] = useState<{ key: string; lit: boolean }[]>(() => lastSevenDays(new Date()).map((key) => ({ key, lit: false })));

  // The milestone's item, from the catalog: owned (the usual case, the server
  // pays the milestone on the day's first award) shows its name, else the badge.
  const item = milestone && catalog ? catalog.find((i) => i.unlock?.source === 'achievement' && i.unlock.need === `streak_${milestone}`) : undefined;
  const owned = !!item && !!progress?.owned.includes(item.id);
  // First celebration of the item: "X unlocked". A rung reached again after a
  // break (the item was seen before) reads as a milestone with the disc.
  const [fresh, setFresh] = useState(false);

  const fill = useSharedValue(0);
  const roll = useSharedValue(0);
  useEffect(() => {
    void hapticNotify(SUCCESS);
    fireEmotion(milestone ? 'excited' : 'proud', 4000);
    void getPracticeLog().then((log) => setWeek(lastSevenDays(new Date()).map((key) => ({ key, lit: dayQualifies(log, key) }))));
    if (reducedMotion) {
      fill.value = withTiming(1, { duration: 150, easing: Easing.linear });
      roll.value = 1;
    } else {
      fill.value = withDelay(250, withTiming(1, { duration: 700, easing: OUT_CUBIC }));
      roll.value = withDelay(250, withTiming(1, { duration: 600, easing: OUT_CUBIC }));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  useEffect(() => {
    if (owned && item && !devStreakActive()) {
      void markUnlockSeen(item.id).then((first) => {
        if (first) setFresh(true);
      });
    }
  }, [owned, item]);
  // Android back closes the moment instead of leaving the screen behind it.
  useEffect(() => {
    const sub = BackHandler.addEventListener('hardwareBackPress', () => {
      clearStreakMoment();
      return true;
    });
    return () => sub.remove();
  }, []);

  const finals = () => {
    cancelAnimation(fill);
    cancelAnimation(roll);
    fill.set(1);
    roll.set(1);
  };
  const close = () => clearStreakMoment();

  // Bottom-anchored reveal of the lit flame over its dim copy.
  const revealStyle = useAnimatedStyle(() => ({ height: FLAME_H * fill.value }));
  const glowStyle = useAnimatedStyle(() => ({ opacity: 0.35 + 0.65 * fill.value }));
  const ringStyle = useAnimatedStyle(() => ({ opacity: 0.6 * fill.value, transform: [{ scale: 0.8 + 0.2 * fill.value }] }));
  const rollStyle = useAnimatedStyle(() => ({ transform: [{ translateY: -NUM_H * roll.value }] }));

  return (
    <View style={StyleSheet.absoluteFill} accessibilityViewIsModal>
      <Canvas style={StyleSheet.absoluteFill}>
        <RoundedRect x={0} y={0} width={width} height={height} r={0}>
          <LinearGradient start={vec(0, 0)} end={vec(0, height)} colors={['#070A12', '#101A2A', '#16243A']} positions={[0, 0.55, 1]} />
        </RoundedRect>
      </Canvas>
      <View style={[styles.header, { marginTop: insets.top }]}>
        <Pressable style={styles.close} onPress={close} accessibilityRole="button" accessibilityLabel={t('summary.close')} hitSlop={8}>
          <Text style={styles.closeGlyph}>✕</Text>
        </Pressable>
      </View>
      <View style={styles.upBody}>
        <View style={styles.upFlameBlock}>
          <Animated.View style={[styles.upCentre, glowStyle]}>
            <EmberGlow size={220} colors={['rgba(255,170,70,0.55)', 'rgba(255,140,50,0.18)', 'rgba(255,140,50,0)']} positions={[0, 0.6, 1]} />
          </Animated.View>
          {milestone ? <Animated.View style={[styles.upRing, ringStyle]} /> : null}
          <View style={styles.upFlame}>
            <Text style={[styles.upEmoji, styles.upEmojiDim]}>🔥</Text>
            <Animated.View style={[styles.upReveal, revealStyle]}>
              <Text style={[styles.upEmoji, styles.upEmojiLit]}>🔥</Text>
            </Animated.View>
          </View>
        </View>
        {/* A score reads left to right in every language, as in the mock. */}
        <View style={styles.upNumRow}>
          <View style={styles.upNumClip}>
            <Animated.View style={reducedMotion ? styles.upRolled : rollStyle}>
              <Text style={styles.upNum}>{Math.max(0, streak - 1)}</Text>
              <Text style={styles.upNum}>{streak}</Text>
            </Animated.View>
          </View>
          <View>
            <Text style={styles.upLabel}>{t('streak.dayStreak', { n: streak })}</Text>
            {milestone ? <Text style={styles.upMilestone}>{t('streak.milestone', { n: milestone }).toUpperCase()}</Text> : null}
          </View>
        </View>
        <View style={styles.upWeek}>
          {week.map(({ key, lit }, i) => (
            <View key={key} style={styles.upDay}>
              <View style={[styles.upDisc, lit ? styles.upDiscLit : null, lit && i === week.length - 1 ? styles.upDiscToday : null]}>
                {lit ? <Text style={styles.upDiscEmoji}>🔥</Text> : null}
              </View>
              <Text style={styles.upDayLetter}>{t(WEEKDAY_KEY[new Date(`${key}T12:00:00`).getDay()])}</Text>
            </View>
          ))}
        </View>
        {milestone ? (
          <View style={styles.upTile}>
            {owned && item ? <ItemDisc item={item} locked={false} size={44} /> : <Tile emoji="🔥" tint="255,200,87" size={44} />}
            <View style={styles.fill}>
              <Text style={styles.upTileTitle}>{owned && item && fresh ? t('summary.unlocked', { name: item.name }) : t('streak.milestone', { n: milestone })}</Text>
              {owned ? <Text style={styles.upTileSub}>{t('summary.wardrobe')}</Text> : null}
            </View>
          </View>
        ) : null}
        <View style={styles.fill} />
        <CatAvatar size={120} equipped={equipped} emotion={catEmotion} />
        <View style={styles.upCatGap} />
        {/* Tap anywhere above the CTA to jump to the end state. */}
        <Pressable style={StyleSheet.absoluteFill} onPress={finals} accessibilityRole="button" accessibilityLabel={t('summary.skip')} />
      </View>
      <View style={[styles.upCta, { paddingBottom: insets.bottom + 40 }]}>
        <PrismButton shape="pill" verb="read" on width={width - 48} height={48} label={t('streak.keepGoing')} onPress={close} />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { backgroundColor: '#0B1220' },
  fill: { flex: 1 },
  header: { height: 48, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 16 },
  close: { width: 36, height: 36, borderRadius: 18, alignItems: 'center', justifyContent: 'center', backgroundColor: 'rgba(255,255,255,0.08)', borderWidth: 1, borderColor: 'rgba(255,255,255,0.14)' },
  closeGlyph: { color: tide.text, fontSize: 15 },
  headTitle: { alignItems: 'center' },
  title: { fontFamily: fonts.uiMedium, fontSize: 15, fontWeight: '600', color: tide.text },
  sub: { fontFamily: fonts.ui, fontSize: 11.5, color: tide.textDim },
  body: { paddingHorizontal: 20, paddingTop: 22 },
  flourish: { fontFamily: fonts.ui, fontSize: 22, fontWeight: '700', color: '#FFE7B3', textShadowColor: 'rgba(255,200,87,0.25)', textShadowRadius: 14, textShadowOffset: { width: 0, height: 0 } },
  lbl: { fontFamily: fonts.ui, fontSize: 11, fontWeight: '700', letterSpacing: 0.7, color: tide.textDim },
  hero: { marginTop: 18, height: 118 },
  heroLayer: { position: 'absolute', left: 0, top: 0, right: 0 },
  heroSub: { fontFamily: fonts.ui, fontSize: 18, color: tide.textDim, marginTop: 6 },
  xpBox: { height: 88, alignSelf: 'flex-start' },
  xpBoxRtl: { alignSelf: 'flex-end' },
  sizer: { opacity: 0 },
  xpInput: { position: 'absolute', left: 0, right: 0, top: 0 },
  xpNum: { color: PALE, textShadowColor: 'rgba(245,196,81,0.30)', textShadowRadius: 18, textShadowOffset: { width: 0, height: 0 } },
  water: { flex: 1, marginTop: 34, backgroundColor: 'rgba(30,60,110,0.2)' },
  waterline: { height: 1, backgroundColor: 'rgba(124,200,255,0.45)' },
  reflBox: { height: 64, paddingHorizontal: 20, overflow: 'hidden' },
  reflBoxRtl: { alignItems: 'flex-end' },
  refl: { opacity: 0.09, transform: [{ scaleY: -1 }] },
  pad: { paddingHorizontal: 20 },
  track: { height: 12, borderRadius: 6, overflow: 'hidden', backgroundColor: 'rgba(255,255,255,0.08)', borderWidth: 1, borderColor: 'rgba(255,255,255,0.14)' },
  barFill: { position: 'absolute', left: 0, top: 0, right: 0, bottom: 0, borderRadius: 6, overflow: 'hidden', transformOrigin: 'left' },
  // Hebrew fills the bar from the right.
  barFillRtl: { transformOrigin: 'right' },
  barNew: { shadowColor: 'rgb(255,210,120)', shadowOpacity: 0.55, shadowRadius: 12, shadowOffset: { width: 0, height: 0 } },
  ghost: { position: 'absolute', left: 0, top: 0, bottom: 0, borderRightWidth: 2, borderStyle: 'dashed', borderColor: 'rgba(255,200,87,0.45)' },
  ghostRtl: { left: 'auto', right: 0, borderRightWidth: 0, borderLeftWidth: 2 },
  barCaption: { flexDirection: 'row', justifyContent: 'space-between', marginTop: 8 },
  caption: { fontFamily: fonts.ui, fontSize: 13, color: tide.textDim },
  rows: { marginTop: 28 },
  xr: { height: 56, flexDirection: 'row', alignItems: 'center', gap: 12 },
  xrLabel: { flex: 1, fontFamily: fonts.ui, fontSize: 15, color: tide.textDim },
  xrValue: { fontFamily: fonts.ui, fontSize: 17, fontWeight: '700', color: tide.text },
  tile: { alignItems: 'center', justifyContent: 'center', borderRadius: 12, borderWidth: 1 },
  levelRow: { marginTop: 18, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  closeSpacer: { width: 36, height: 36 },
  bodyCentred: { justifyContent: 'center', alignItems: 'center', paddingTop: 0, paddingBottom: 160 },
  rewardBig: { flexDirection: 'column', marginTop: 0, paddingVertical: 24, paddingHorizontal: 24, gap: 16 },
  rewardText: { alignItems: 'center' },
  reward: { marginTop: 24, flexDirection: 'row', alignItems: 'center', gap: 12, borderRadius: 20, padding: 12, paddingHorizontal: 14, backgroundColor: 'rgba(255,200,87,0.13)', borderWidth: 1.5, borderColor: 'rgba(255,200,87,0.42)' },
  rewardTitle: { fontFamily: fonts.ui, fontSize: 15, fontWeight: '700', color: tide.text },
  stats: { flexDirection: 'row', gap: 22, marginTop: 4, alignItems: 'baseline' },
  statText: { fontFamily: fonts.ui, fontSize: 15, color: tide.textDim },
  statNum: { fontSize: 20, fontWeight: '700', color: tide.text },
  mix: { flexDirection: 'row', height: 14, borderRadius: 7, overflow: 'hidden', gap: 3, marginTop: 22 },
  pj: { height: 52, flexDirection: 'row', alignItems: 'center', gap: 12 },
  pjTitle: { fontFamily: fonts.ui, fontSize: 15, fontWeight: '600', color: tide.text },
  pjAvg: { fontFamily: fonts.ui, fontSize: 17, fontWeight: '700' },
  best: { marginTop: 10, paddingHorizontal: 14, paddingTop: 10, paddingBottom: 12 },
  bestText: { fontFamily: fonts.ui, fontSize: 20, fontWeight: '600', lineHeight: 28, color: tide.text, marginTop: 4 },
  bestEn: { fontFamily: fonts.ui, fontSize: 14, lineHeight: 21, color: tide.textDim },
  cta: { position: 'absolute', left: 20, right: 20, alignItems: 'center' },
  upBody: { flex: 1, alignItems: 'center', paddingHorizontal: 22 },
  upFlameBlock: { width: 200, height: 120, alignItems: 'center', justifyContent: 'center' },
  upCentre: { position: 'absolute', alignItems: 'center', justifyContent: 'center' },
  upRing: { position: 'absolute', width: 132, height: 132, borderRadius: 66, borderWidth: 2, borderColor: GOLD },
  upFlame: { width: 100, height: FLAME_H },
  upEmoji: { fontSize: 72, lineHeight: FLAME_H, height: FLAME_H, textAlign: 'center', includeFontPadding: false },
  upEmojiDim: { opacity: 0.25 },
  upEmojiLit: { position: 'absolute', bottom: 0, left: 0, right: 0, textShadowColor: 'rgba(255,150,60,0.55)', textShadowRadius: 22, textShadowOffset: { width: 0, height: 0 } },
  upReveal: { position: 'absolute', bottom: 0, left: 0, right: 0, overflow: 'hidden' },
  upNumRow: { flexDirection: 'row', alignItems: 'center', gap: 16, marginTop: 18, direction: 'ltr' },
  upNumClip: { height: NUM_H, overflow: 'hidden' },
  upRolled: { transform: [{ translateY: -NUM_H }] },
  upNum: {
    height: NUM_H,
    lineHeight: NUM_H,
    fontFamily: fonts.ui,
    fontSize: 96,
    fontWeight: '300',
    color: PALE,
    fontVariant: ['tabular-nums'],
    textShadowColor: 'rgba(245,196,81,0.30)',
    textShadowRadius: 18,
    textShadowOffset: { width: 0, height: 0 },
  },
  upLabel: { fontFamily: fonts.ui, fontSize: 18, fontWeight: '600', color: tide.textDim, textAlign: 'left' },
  upMilestone: { fontFamily: fonts.ui, fontSize: 12, fontWeight: '700', letterSpacing: 1.2, color: GOLD, marginTop: 4, textAlign: 'left' },
  upWeek: { alignSelf: 'stretch', flexDirection: 'row', justifyContent: 'space-between', marginTop: 22, paddingHorizontal: 4, direction: 'ltr' },
  upDay: { alignItems: 'center', gap: 6 },
  upDisc: { width: 30, height: 30, borderRadius: 15, alignItems: 'center', justifyContent: 'center', backgroundColor: 'rgba(255,255,255,0.06)', borderWidth: 1, borderColor: 'rgba(255,255,255,0.12)' },
  upDiscLit: { backgroundColor: 'rgba(255,179,107,0.22)', borderColor: 'rgba(255,179,107,0.6)' },
  upDiscToday: { shadowColor: 'rgb(255,200,87)', shadowOpacity: 0.6, shadowRadius: 6, shadowOffset: { width: 0, height: 0 } },
  upDiscEmoji: { fontSize: 14 },
  upDayLetter: { fontFamily: fonts.ui, fontSize: 11, color: tide.textDim },
  upTile: {
    alignSelf: 'stretch',
    marginTop: 22,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingVertical: 12,
    paddingHorizontal: 14,
    borderRadius: 16,
    backgroundColor: 'rgba(255,200,87,0.08)',
    borderWidth: 1,
    borderColor: 'rgba(255,200,87,0.30)',
  },
  upTileTitle: { fontFamily: fonts.ui, fontSize: 15, fontWeight: '700', color: tide.text },
  upTileSub: { fontFamily: fonts.ui, fontSize: 12.5, color: tide.textDim },
  upCatGap: { height: 20 },
  upCta: { alignItems: 'center', paddingHorizontal: 24 },
  toast: { position: 'absolute', alignSelf: 'center', height: 36, paddingHorizontal: 16, borderRadius: 18, justifyContent: 'center', backgroundColor: 'rgba(40,32,12,0.92)', borderWidth: 1, borderColor: 'rgba(255,200,87,0.42)' },
  toastText: { fontFamily: fonts.ui, fontSize: 16, fontWeight: '700', color: GOLD },
});
