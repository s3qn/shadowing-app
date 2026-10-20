import * as Haptics from 'expo-haptics';
import { useEffect, useMemo, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, TextInput, View, useWindowDimensions } from 'react-native';
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
import { clearCelebration, clearLevelUp, clearXpToast, useXpToast, type Celebration, type PendingLevelUp, type RecapLine } from '@/lib/level-up-store';
import { equippedArt, useProgressCache } from '@/lib/progression';
import { getSettingsSync } from '@/lib/settings';

// BL-51, picked mock .claude/design/S4-r2.html: the session summary, the XP
// moment and the level-up, one screen in three states. Also the "+N XP" toast.

const GOLD = '#FFC857';
const PALE = '#FFE3A0';
const OUT_CUBIC = Easing.out(Easing.cubic);
const SUCCESS = Haptics.NotificationFeedbackType.Success;
const INOUT_QUAD = Easing.inOut(Easing.quad);
const OUT_QUAD = Easing.out(Easing.quad);

// The celebration word is in the language being learned, never the UI one.
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
  const { width } = useWindowDimensions();
  const { progress, catalog } = useProgressCache();
  const cheer = CHEER[getSettingsSync().learningLanguage] ?? CHEER.en;
  const levelOnly = !c;
  const [stage, setStage] = useState<'summary' | 'xp'>(c?.recap ? 'summary' : 'xp');

  const xp = c?.xp ?? 0;
  const level = c?.after.level ?? levelUp?.level ?? 1;
  const prevLevel = c?.before.level ?? levelUp?.prevLevel ?? level - 1;
  const leveled = levelOnly || level > prevLevel;
  const [catEmotion, fireEmotion] = useEmotionPulse();
  const avgScore = c?.avgScore ?? null;
  useEffect(() => {
    if (leveled) fireEmotion(avgScore !== null && band(avgScore) === 'building' ? 'encouraging' : 'proud', 4000);
  }, [leveled, avgScore, fireEmotion]);
  const beforeFrac = c ? frac(c.before.into, c.before.toNext) : 0;
  const afterFrac = c ? frac(c.after.into, c.after.toNext) : progress ? frac(progress.xp_into_level, progress.xp_to_next) : 0;
  const equipped = useMemo(() => (progress && catalog ? equippedArt(progress, catalog) : {}), [progress, catalog]);
  const unlocked = useMemo(
    () => (leveled && catalog ? catalog.find((it) => !it.grant_only && it.level_req > prevLevel && it.level_req <= level) ?? null : null),
    [leveled, catalog, prevLevel, level],
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
    lvl.value = leveled ? 1 : 0;
    reward.value = 1;
  };

  // T0 is the mount of a stage. The summary only brings its flourish in.
  useEffect(() => {
    if (reduced) {
      const fade = { duration: 150, easing: Easing.linear };
      v.value = xp;
      bar.value = afterFrac;
      base.value = leveled ? 0 : beforeFrac;
      if (stage === 'xp' && (xp > 0 || leveled)) {
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
      void hapticNotify(SUCCESS);
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
          <Text style={[styles.title, dir.writing]}>{t('summary.title')}</Text>
          <Text style={[styles.sub, dir.writing]}>{t('summary.sub')}</Text>
        </View>
        <View style={styles.close} />
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
          {leveled ? (
            <Animated.View style={[StyleSheet.absoluteFill, styles.body, lvlLayer]} pointerEvents="none">
              <Animated.Text style={[styles.flourish, dir.content, floStyle]}>{cheer.level}</Animated.Text>
              <View style={[styles.levelRow, dir.row]}>
                <View>
                  <Text style={[styles.lbl, dir.text, { color: GOLD }]}>{t('summary.levelWord').toUpperCase()}</Text>
                  <View style={{ marginTop: 6 }}>
                    <HeroNumber value={level} size={120} />
                  </View>
                </View>
                <CatAvatar size={150} equipped={equipped} emotion={catEmotion} />
              </View>
              <View style={[styles.track, { marginTop: 26 }]}>
                <XpFill bar={bar} base={base} ghost={leveled ? 0 : beforeFrac} />
              </View>
              {c ? (
                <Text style={[styles.caption, dir.text, { marginTop: 8 }]}>
                  {t('summary.levelLine', { xp, into: c.after.into.toLocaleString(locale), l: level })}
                  {c.streak > 0 ? ` · 🔥 ${t('summary.days', { n: c.streak })}` : ''}
                </Text>
              ) : null}
              {unlocked || (levelUp?.coins ?? 0) > 0 ? (
                <Animated.View style={[styles.reward, dir.row, rewardStyle]}>
                  <Tile emoji={unlocked ? (unlocked.slot === 'head' ? '🎩' : '🎁') : '🪙'} tint="255,200,87" size={44} />
                  <View style={styles.fill}>
                    <Text style={[styles.rewardTitle, dir.text]}>{unlocked ? t('summary.unlocked', { name: unlocked.name }) : t('summary.coins', { n: levelUp?.coins ?? 0 })}</Text>
                    {unlocked ? <Text style={[styles.caption, dir.text]}>{t('summary.wardrobe')}</Text> : null}
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
      <Text style={[styles.toastText, dir.writing]}>{cap ? `${isolate(t('review.xpEarned', { n: 0 }))} · ${t('ladder.xpCap')}` : isolate(t('review.xpEarned', { n }))}</Text>
    </Animated.View>
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
  ghostRtl: { left: undefined, right: 0, borderRightWidth: 0, borderLeftWidth: 2 },
  barCaption: { flexDirection: 'row', justifyContent: 'space-between', marginTop: 8 },
  caption: { fontFamily: fonts.ui, fontSize: 13, color: tide.textDim },
  rows: { marginTop: 28 },
  xr: { height: 56, flexDirection: 'row', alignItems: 'center', gap: 12 },
  xrLabel: { flex: 1, fontFamily: fonts.ui, fontSize: 15, color: tide.textDim },
  xrValue: { fontFamily: fonts.ui, fontSize: 17, fontWeight: '700', color: tide.text },
  tile: { alignItems: 'center', justifyContent: 'center', borderRadius: 12, borderWidth: 1 },
  levelRow: { marginTop: 18, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
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
  toast: { position: 'absolute', alignSelf: 'center', height: 36, paddingHorizontal: 16, borderRadius: 18, justifyContent: 'center', backgroundColor: 'rgba(40,32,12,0.92)', borderWidth: 1, borderColor: 'rgba(255,200,87,0.42)' },
  toastText: { fontFamily: fonts.ui, fontSize: 16, fontWeight: '700', color: GOLD },
});
