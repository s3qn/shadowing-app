import LottieView from 'lottie-react-native';
import { StyleSheet, Text, View } from 'react-native';
import { useReducedMotion } from 'react-native-reanimated';

import { ArtCard } from '@/components/onboarding/art-card';
import {
  CompareLanes,
  ListenEffect,
  MumbleEffect,
  ReadAlongRow,
  ShadowBubbles,
  WaveLane,
} from '@/components/onboarding/pass-effects';
import { StepAction, StepCopy, StepFrame } from '@/components/onboarding/step-frame';
import { type Verb } from '@/components/prism';
import { fonts } from '@/constants/fonts';
import { Spacing, tide, verb } from '@/constants/theme';
import { useDir, useT } from '@/lib/i18n';
import {
  toIslandLanguage,
  toNativeLanguage,
  type LearningLanguage,
  type UnderstoodLanguage,
} from '@/lib/settings';
import { type Key } from '@/locales/en';

// Only the languages with an island have a sample line, and only the two with
// a catalogue have a translation. Both tables are keyed by the narrowed id,
// not by `LearningLanguage` (which is any string): a Coming soon pick has to
// go through `toIslandLanguage` first, or the row below gets `undefined` and
// `words.map` throws.
const READ_ALONG_WORDS: Record<'ja' | 'es' | 'en', string[]> = {
  ja: ['今日は', 'いい', '天気', 'ですね'],
  es: ['Hoy', 'hace', 'buen', 'tiempo'],
  en: ['The', 'weather', 'is', 'nice', 'today'],
};

const TRANSLATIONS: Record<'he' | 'en', string> = {
  en: 'The weather is nice today.',
  he: 'מזג האוויר יפה היום.',
};

type PassInfo = {
  /** The pass name, which the kicker reads out. */
  titleKey: Key;
  headlineKey: Key;
  lineKey: Key;
  /** The speed this pass plays at (Compare names the next round's speed). */
  speed: string;
  colour: string;
  a: number;
  artTop: number;
  nextVerb: Verb;
};

const PASSES: PassInfo[] = [
  {
    titleKey: 'settings.onboarding.passListenTitle',
    headlineKey: 'settings.onboarding.passListenHeadline',
    lineKey: 'settings.onboarding.passListenLine',
    speed: '0.7',
    colour: verb.listen.c1,
    a: 84,
    artTop: 0.46,
    nextVerb: 'listen',
  },
  {
    titleKey: 'settings.onboarding.passMumbleTitle',
    headlineKey: 'settings.onboarding.passMumbleHeadline',
    lineKey: 'settings.onboarding.passMumbleLine',
    speed: '0.7',
    colour: verb.speak.c2,
    a: 84,
    artTop: 0.46,
    nextVerb: 'speak',
  },
  {
    titleKey: 'settings.onboarding.passReadTitle',
    headlineKey: 'settings.onboarding.passReadHeadline',
    lineKey: 'settings.onboarding.passReadLine',
    speed: '0.85',
    colour: verb.read.c1,
    a: 102,
    artTop: 0.34,
    nextVerb: 'read',
  },
  {
    titleKey: 'settings.onboarding.passShadowTitle',
    headlineKey: 'settings.onboarding.passShadowHeadline',
    lineKey: 'settings.onboarding.passShadowLine',
    speed: '0.85',
    colour: verb.speak.c1,
    a: 102,
    artTop: 0.46,
    nextVerb: 'speak',
  },
  {
    titleKey: 'settings.onboarding.passCompareTitle',
    headlineKey: 'settings.onboarding.passCompareHeadline',
    lineKey: 'settings.onboarding.passCompareLine',
    speed: '1.0',
    colour: tide.pos.verb,
    // The two Lotties here are smaller than the single body part of the
    // other passes; `a` still sets the effects' scale.
    a: 120,
    artTop: 0.34,
    nextVerb: 'tools',
  },
];

const COMPARE_ART = 56;
const COMPARE_GAP = 6;

const LOTTIE_SOURCES = [
  require('../../../assets/lottie/listen-ear.json'),
  require('../../../assets/lottie/mumble-lips.json'),
  require('../../../assets/lottie/read-eyes.json'),
  require('../../../assets/lottie/shadow-head.json'),
];

/**
 * One of the five onboarding passes: the progress dots, the art card with
 * its Lottie body part and the pass's effect (syllable pops, humming dots
 * and whispers, word by word glow with the translation under it, rising
 * language bubbles with the two waveform lanes), the copy block, and the
 * button. Effects live in `pass-effects.tsx` and are still under reduced
 * motion.
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
  const reducedMotion = useReducedMotion();
  const info = PASSES[pass];
  const last = pass === 4;
  // Compare's two Lotties are always paused: the waveforms below carry the
  // motion. Under reduced motion every Lottie is paused the same way.
  const lottiePaused = last || reducedMotion;
  const artWidth = last ? 2 * COMPARE_ART + COMPARE_GAP : info.a;
  const artHeight = last ? COMPARE_ART : info.a;
  const kicker = t(last ? 'settings.onboarding.passKickerNext' : 'settings.onboarding.passKicker', {
    n: pass + 1,
    name: t(info.titleKey),
    speed: info.speed,
  });

  return (
    <StepFrame
      dots={{ count: PASSES.length, active: pass, colour: info.colour }}
      footer={
        <StepAction
          verb={info.nextVerb}
          label={t(last ? 'settings.onboarding.gotIt' : 'settings.onboarding.next')}
          onPress={onNext}
        />
      }>
      <ArtCard colour={info.colour}>
        <View pointerEvents="none" style={StyleSheet.absoluteFill}>
          <View
            style={[
              styles.artWrap,
              {
                width: artWidth,
                height: artHeight,
                marginLeft: -artWidth / 2,
                marginTop: -artHeight / 2,
                top: `${info.artTop * 100}%`,
              },
            ]}>
            {last ? (
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
          </View>

          <View style={[styles.effectAnchor, { top: `${info.artTop * 100}%` }]}>
            {pass === 0 ? <ListenEffect colour={info.colour} a={info.a} /> : null}
            {pass === 1 ? <MumbleEffect colour={info.colour} a={info.a} /> : null}
            {pass === 3 ? <ShadowBubbles a={info.a} /> : null}
          </View>

          {pass === 2 ? (
            <View style={styles.readArea}>
              <View style={styles.readRow}>
                <ReadAlongRow words={READ_ALONG_WORDS[toIslandLanguage(learning)]} colour={info.colour} />
              </View>
              <Text style={[styles.translation, understood === 'he' ? styles.translationRtl : null]}>
                {TRANSLATIONS[toNativeLanguage(understood)]}
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

          {last ? (
            <>
              <View style={styles.lanesArea}>
                <CompareLanes topColour={verb.listen.c1} bottomColour={verb.speak.c1} />
              </View>
              <Text style={[styles.kept, dir.rtl && styles.keptRtl]}>{t('settings.onboarding.keptUp')}</Text>
            </>
          ) : null}
        </View>
      </ArtCard>
      <StepCopy kicker={kicker} kickerColour={info.colour} title={t(info.headlineKey)} body={t(info.lineKey)} />
    </StepFrame>
  );
}

const styles = StyleSheet.create({
  artWrap: { position: 'absolute', left: '50%', alignItems: 'center', justifyContent: 'center' },
  effectAnchor: { position: 'absolute', left: '50%', width: 0, height: 0 },
  compareArts: { flexDirection: 'row', gap: COMPARE_GAP },
  readArea: { position: 'absolute', left: 0, right: 0, top: '62%', alignItems: 'center', gap: Spacing.xs },
  readRow: { flexDirection: 'row', gap: 8 },
  translation: { fontFamily: fonts.ui, fontSize: 15, color: tide.textDim, textAlign: 'center' },
  translationRtl: { writingDirection: 'rtl', textAlign: 'right' },
  lanesArea: {
    position: 'absolute',
    left: Spacing.lg,
    right: Spacing.lg,
    bottom: Spacing.md,
    alignItems: 'center',
    gap: Spacing.xs,
  },
  laneLabel: { fontFamily: fonts.ui, fontSize: 11, color: tide.textDim },
  kept: {
    position: 'absolute',
    top: Spacing.md,
    right: Spacing.lg,
    fontFamily: fonts.uiMedium,
    fontSize: 13,
    fontWeight: '800',
    color: tide.pos.verb,
  },
  // The score sits in the corner the copy ends at, so Hebrew puts it left.
  keptRtl: { right: undefined, left: Spacing.lg },
});
