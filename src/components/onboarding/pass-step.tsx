import LottieView from 'lottie-react-native';
import { useEffect } from 'react';
import { StyleSheet, Text, View, useWindowDimensions } from 'react-native';
import Animated, { useAnimatedStyle, useReducedMotion, useSharedValue, withTiming } from 'react-native-reanimated';

import { GlassDisc } from '@/components/onboarding/glass-disc';
import {
  CompareLanes,
  ListenEffect,
  MumbleEffect,
  ReadAlongRow,
  ShadowBubbles,
  WaveLane,
} from '@/components/onboarding/pass-effects';
import { PrismButton, type Verb } from '@/components/prism';
import { fonts } from '@/constants/fonts';
import { Spacing, tide, verb } from '@/constants/theme';
import { useDir, useT } from '@/lib/i18n';
import { type LearningLanguage, type UnderstoodLanguage } from '@/lib/settings';
import { type Key } from '@/locales/en';

const STAGE_HEIGHT = 300;

const READ_ALONG_WORDS: Record<LearningLanguage, string[]> = {
  ja: ['今日は', 'いい', '天気', 'ですね'],
  es: ['Hoy', 'hace', 'buen', 'tiempo'],
  en: ['The', 'weather', 'is', 'nice', 'today'],
};

const TRANSLATIONS: Record<UnderstoodLanguage, string> = {
  en: 'The weather is nice today.',
  he: 'מזג האוויר יפה היום.',
};

type PassInfo = {
  titleKey: Key;
  lineKey: Key;
  colour: string;
  a: number;
  discTop: number;
  nextVerb: Verb;
};

const PASSES: PassInfo[] = [
  {
    titleKey: 'settings.onboarding.passListenTitle',
    lineKey: 'settings.onboarding.passListenLine',
    colour: verb.listen.c1,
    a: 84,
    discTop: 0.46,
    nextVerb: 'listen',
  },
  {
    titleKey: 'settings.onboarding.passMumbleTitle',
    lineKey: 'settings.onboarding.passMumbleLine',
    colour: verb.speak.c2,
    a: 84,
    discTop: 0.46,
    nextVerb: 'speak',
  },
  {
    titleKey: 'settings.onboarding.passReadTitle',
    lineKey: 'settings.onboarding.passReadLine',
    colour: verb.read.c1,
    a: 102,
    discTop: 0.34,
    nextVerb: 'read',
  },
  {
    titleKey: 'settings.onboarding.passShadowTitle',
    lineKey: 'settings.onboarding.passShadowLine',
    colour: verb.speak.c1,
    a: 102,
    discTop: 0.46,
    nextVerb: 'speak',
  },
  {
    titleKey: 'settings.onboarding.passCompareTitle',
    lineKey: 'settings.onboarding.passCompareLine',
    colour: tide.pos.verb,
    // The disc itself keeps the base art size (120, so D = 180); the two
    // Lotties inside are smaller (56 each), set directly where they render.
    a: 120,
    discTop: 0.34,
    nextVerb: 'tools',
  },
];

const COMPARE_ART = 56;

/** A finite number or the fallback, for values reaching a Reanimated style
 * on the UI thread, where a NaN throws and exits Expo Go with no red box. */
function finiteOr(x: number, fallback: number) {
  'worklet';
  return Number.isFinite(x) ? x : fallback;
}

/** One pass-progress dot: widens from 6 to 18 over 200ms when it becomes the
 * active pass. */
function PassDot({ active, colour }: { active: boolean; colour: string }) {
  const width = useSharedValue(active ? 18 : 6);
  useEffect(() => {
    width.value = withTiming(active ? 18 : 6, { duration: 200 });
  }, [active, width]);
  const style = useAnimatedStyle(() => ({
    width: finiteOr(width.value, active ? 18 : 6),
    backgroundColor: active ? colour : 'rgba(236,232,244,0.2)',
  }));
  return <Animated.View style={[styles.dot, style]} />;
}

const LOTTIE_SOURCES = [
  require('../../../assets/lottie/listen-ear.json'),
  require('../../../assets/lottie/mumble-lips.json'),
  require('../../../assets/lottie/read-eyes.json'),
  require('../../../assets/lottie/shadow-head.json'),
];

/**
 * One of the five onboarding passes: title, one line, the Glass Disc with
 * its Lottie body part, and the pass's effect in the stage (syllable pops,
 * humming dots and whispers, word by word glow with the translation under
 * it, rising language bubbles with the two waveform lanes). Effects live in
 * `pass-effects.tsx` and are still under reduced motion.
 */
export function PassStep({
  pass,
  learning,
  understood,
  onNext,
}: {
  pass: 0 | 1 | 2 | 3 | 4;
  learning: LearningLanguage;
  understood: UnderstoodLanguage;
  onNext: () => void;
}) {
  const { t } = useT();
  const dir = useDir();
  const { width: windowWidth } = useWindowDimensions();
  const reducedMotion = useReducedMotion();
  const info = PASSES[pass];
  const stageWidth = Math.min(windowWidth - 48, 300);
  // Compare's two Lotties are always paused: the waveforms below carry the
  // motion. Under reduced motion every Lottie is paused the same way.
  const lottiePaused = pass === 4 || reducedMotion;

  return (
    <View style={styles.content}>
      <View style={[styles.dots, dir.row]}>
        {PASSES.map((p, i) => (
          <PassDot key={p.titleKey} active={i === pass} colour={info.colour} />
        ))}
      </View>
      <Text style={styles.title}>{t(info.titleKey)}</Text>
      <Text style={styles.line}>{t(info.lineKey)}</Text>
      <View style={[styles.stage, { width: stageWidth, height: STAGE_HEIGHT }]}>
        <View
          style={[
            styles.discWrap,
            {
              width: info.a * 1.5,
              height: info.a * 1.5,
              marginLeft: -(info.a * 1.5) / 2,
              marginTop: -(info.a * 1.5) / 2,
              top: `${info.discTop * 100}%`,
            },
          ]}>
          <GlassDisc size={info.a} colour={info.colour}>
            {pass === 4 ? (
              <View style={styles.compareArts}>
                <LottieView
                  autoPlay={false}
                  progress={0.5}
                  resizeMode="contain"
                  style={{ width: COMPARE_ART, height: COMPARE_ART }}
                  source={LOTTIE_SOURCES[0]}
                />
                <LottieView
                  autoPlay={false}
                  progress={0.5}
                  resizeMode="contain"
                  style={{ width: COMPARE_ART, height: COMPARE_ART }}
                  source={LOTTIE_SOURCES[3]}
                />
              </View>
            ) : (
              <LottieView
                autoPlay={!lottiePaused}
                loop={!lottiePaused}
                progress={lottiePaused ? 0.5 : undefined}
                resizeMode="contain"
                style={{ width: info.a, height: info.a }}
                source={LOTTIE_SOURCES[pass]}
              />
            )}
          </GlassDisc>
        </View>

        <View pointerEvents="none" style={[styles.effectAnchor, { top: `${info.discTop * 100}%` }]}>
          {pass === 0 ? <ListenEffect colour={info.colour} a={info.a} /> : null}
          {pass === 1 ? <MumbleEffect colour={info.colour} a={info.a} /> : null}
          {pass === 3 ? <ShadowBubbles a={info.a} /> : null}
        </View>

        {pass === 2 ? (
          <View style={styles.readArea}>
            <View style={styles.readRow}>
              <ReadAlongRow words={READ_ALONG_WORDS[learning]} colour={info.colour} />
            </View>
            <Text
              style={[
                styles.translation,
                understood === 'he' ? styles.translationRtl : null,
              ]}>
              {TRANSLATIONS[understood]}
            </Text>
          </View>
        ) : null}

        {pass === 3 ? (
          <View style={styles.lanesArea}>
            <Text style={styles.laneLabel}>{t('settings.onboarding.voiceLane')}</Text>
            <WaveLane colour={verb.listen.c1} />
            <Text style={styles.laneLabel}>{t('settings.onboarding.youLane')}</Text>
            <WaveLane colour={info.colour} opacity={0.8} lagMs={250} />
          </View>
        ) : null}

        {pass === 4 ? (
          <>
            <View style={styles.lanesArea}>
              <CompareLanes topColour={verb.listen.c1} bottomColour={verb.speak.c1} />
            </View>
            <Text style={styles.kept}>{t('settings.onboarding.keptUp')}</Text>
          </>
        ) : null}
      </View>
      <PrismButton
        shape="pill"
        verb={info.nextVerb}
        label={t('settings.onboarding.next')}
        onPress={onNext}
        containerStyle={styles.action}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  content: { flex: 1, alignItems: 'center', justifyContent: 'center', paddingHorizontal: Spacing.xl, gap: Spacing.md },
  dots: { flexDirection: 'row', gap: 6, alignItems: 'center' },
  dot: { width: 6, height: 6, borderRadius: 3, backgroundColor: 'rgba(236,232,244,0.2)' },
  title: { fontFamily: fonts.uiMedium, fontSize: 24, color: tide.text },
  line: { fontFamily: fonts.ui, fontSize: 16, color: tide.textDim, textAlign: 'center' },
  stage: { position: 'relative' },
  discWrap: { position: 'absolute', left: '50%', alignItems: 'center', justifyContent: 'center' },
  effectAnchor: { position: 'absolute', left: '50%', width: 0, height: 0 },
  compareArts: { flexDirection: 'row', gap: 6 },
  readArea: { position: 'absolute', left: 0, right: 0, top: '76%', alignItems: 'center', gap: Spacing.xs },
  readRow: { flexDirection: 'row', gap: 8 },
  translation: { fontFamily: fonts.ui, fontSize: 15, color: tide.textDim, textAlign: 'center' },
  translationRtl: { writingDirection: 'rtl', textAlign: 'right' },
  lanesArea: { position: 'absolute', left: 0, right: 0, top: '76%', alignItems: 'center', gap: Spacing.xs },
  laneLabel: { fontFamily: fonts.ui, fontSize: 11, color: tide.textDim },
  kept: { position: 'absolute', top: 0, right: 0, fontFamily: fonts.uiMedium, fontSize: 13, fontWeight: '800', color: tide.pos.verb },
  action: { marginTop: Spacing.md },
});
