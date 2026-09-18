import { requestRecordingPermissionsAsync } from 'expo-audio';
import { useRouter } from 'expo-router';
import { useEffect, useRef, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';

import { LanguagePicker } from '@/components/language-picker';
import { GoalOptions } from '@/components/onboarding/goal-step';
import { MicArt } from '@/components/onboarding/mic-art';
import { OnboardingSky } from '@/components/onboarding/onboarding-sky';
import { PassStep } from '@/components/onboarding/pass-step';
import { Confetti, FirstIslandCard, RecordGlow } from '@/components/onboarding/ready-art';
import { StepAction, StepCopy, StepFrame } from '@/components/onboarding/step-frame';
import { WelcomeStep } from '@/components/onboarding/welcome-step';
import { PrismButton } from '@/components/prism';
import { fonts } from '@/constants/fonts';
import { Spacing, prism, tide, verb } from '@/constants/theme';
import { previewAppLanguage, useDir, useT } from '@/lib/i18n';
import { LANGUAGES } from '@/lib/languages';
import {
  type DailyGoalMinutes,
  type LearningLanguage,
  type UnderstoodLanguage,
  getSettingsSync,
  setDailyGoalMinutes,
  setLearningLanguage,
  setOnboarded,
  setUnderstoodLanguage,
} from '@/lib/settings';
import { type Key } from '@/locales/en';

const STEP_WELCOME = 0;
const STEP_LEARN = 1;
const STEP_UNDERSTAND = 2;
const STEP_MIC = 3;
const STEP_GOAL = 4;
const STEP_PASS_FIRST = 5;
const STEP_PASS_LAST = 9;
const STEP_READY = 10;
const LAST_STEP = STEP_READY;

/**
 * First-run flow: explains shadowing, picks the language to learn and the
 * language already understood (one question per screen), asks for the
 * microphone, then launches the first island. One component with internal
 * step state rather than a route each, since nothing here needs deep-linking
 * or back-button history.
 *
 * Every step sits in the same `StepFrame` over one `OnboardingSky`: the
 * background is mounted once for the whole flow, so stepping forward never
 * flashes it, and the button stays at one height from the first screen to
 * the last.
 */
export default function OnboardingScreen() {
  const { t } = useT();
  const dir = useDir();
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const [step, setStep] = useState(0);
  // Start from the saved pair (the root layout loads settings before any
  // screen renders), so Replay onboarding plus Skip keeps the learner's choice.
  const [learning, setLearning] = useState<LearningLanguage>(() => getSettingsSync().learningLanguage);
  const [understand, setUnderstand] = useState<UnderstoodLanguage>(() => getSettingsSync().understoodLanguage);
  const [goal, setGoal] = useState<DailyGoalMinutes>(() => getSettingsSync().dailyGoalMinutes);
  const [micError, setMicError] = useState(false);
  const leaving = useRef(false);

  // Previews the interface in whichever language is picked as "understood",
  // so the languages step flips the rest of onboarding at once (decision 1,
  // soft RTL: no restart needed). Only 'en'/'he' have a catalogue today; any
  // other pick clears the preview and falls back to the saved app language.
  useEffect(() => {
    previewAppLanguage(understand === 'en' || understand === 'he' ? understand : null);
    return () => previewAppLanguage(null);
  }, [understand]);

  function selectLearning(value: LearningLanguage) {
    setLearning(value);
    // The understand picker hides whatever is picked here (its `exclude`
    // prop), so a pick that collides with the current understood language
    // would leave that screen with nothing ticked: move it to another
    // understandable language rather than let that happen.
    if (value === understand) {
      const fallback = LANGUAGES.find((l) => l.understandable && l.id !== value);
      if (fallback) setUnderstand(fallback.id);
    }
  }

  // Saves, closes onboarding back to the one Home under it, then opens
  // `to` from there. Replacing with '/(tabs)' instead would stack a second
  // Home. The ref drops a second tap while the writes are in flight.
  async function finish(to: 'home' | 'record' | 'podcast') {
    if (leaving.current) return;
    leaving.current = true;
    try {
      await Promise.all([
        setOnboarded(true),
        setLearningLanguage(learning),
        setUnderstoodLanguage(understand),
        setDailyGoalMinutes(goal),
      ]);
    } catch (err: unknown) {
      console.warn('saving onboarding failed', err);
    }
    if (router.canGoBack()) router.back();
    else router.replace('/(tabs)');
    if (to === 'record') router.push('/record');
    else if (to === 'podcast') router.navigate('/(tabs)/podcast');
  }

  function skip() {
    void finish('home');
  }

  async function allowMic() {
    const perm = await requestRecordingPermissionsAsync();
    if (perm.granted) {
      setMicError(false);
      setStep(STEP_GOAL);
    } else {
      setMicError(true);
    }
  }

  function notNow() {
    setMicError(false);
    setStep(STEP_GOAL);
  }

  // The route draws no header, so the top inset is this screen's own to
  // handle: only the bottom edge comes from SafeAreaView (the same split the
  // player uses), and Skip is placed under the status bar by hand, on the
  // same row the frame keeps for the progress dots.
  return (
    <View style={styles.fill}>
      <OnboardingSky />
      <SafeAreaView edges={['bottom']} style={styles.flow}>
        {step < LAST_STEP ? (
          <PrismButton
            shape="pill"
            verb="tools"
            flat
            press="light"
            label={t('settings.onboarding.skip')}
            onPress={skip}
            containerStyle={[styles.skip, dir.rtl && styles.skipRtl, { top: insets.top + Spacing.sm }]}
          />
        ) : null}

        {step === STEP_WELCOME ? <WelcomeStep onNext={() => setStep(STEP_LEARN)} /> : null}

        {/* language-picker: start */}
        {step === STEP_LEARN ? (
          <StepFrame
            fill
            footer={
              <StepAction
                verb="read"
                label={t('settings.onboarding.continue')}
                onPress={() => setStep(STEP_UNDERSTAND)}
              />
            }>
            <StepCopy
              kicker={t('settings.onboarding.languagesStep1')}
              kickerColour={verb.read.c1}
              title={t('settings.languages.learn')}
            />
            <View style={styles.pickerBleed}>
              <LanguagePicker mode="learn" value={learning} onChange={selectLearning} exclude={understand} />
            </View>
          </StepFrame>
        ) : null}

        {step === STEP_UNDERSTAND ? (
          <StepFrame
            fill
            footer={
              <StepAction verb="listen" label={t('settings.onboarding.continue')} onPress={() => setStep(STEP_MIC)} />
            }>
            <StepCopy
              kicker={t('settings.onboarding.languagesStep2')}
              kickerColour={verb.listen.c1}
              title={t('settings.languages.understand')}
            />
            <View style={styles.pickerBleed}>
              <LanguagePicker mode="understand" value={understand} onChange={setUnderstand} exclude={learning} />
            </View>
          </StepFrame>
        ) : null}
        {/* language-picker: end */}

        {step === STEP_MIC ? (
          <StepFrame
            footer={
              <>
                <StepAction
                  verb="speak"
                  label={t('settings.onboarding.allowMicrophone')}
                  onPress={() => void allowMic()}
                />
                {micError ? <Text style={styles.error}>{t('settings.onboarding.micError')}</Text> : null}
                <PrismButton
                  shape="pill"
                  verb="speak"
                  flat
                  press="light"
                  label={t('settings.onboarding.notNow')}
                  onPress={notNow}
                />
              </>
            }>
            <View style={styles.micArt}>
              <MicArt />
            </View>
            <StepCopy
              centered
              kicker={t('settings.onboarding.micKicker')}
              kickerColour={verb.speak.c1}
              title={t('settings.onboarding.micTitle')}
              body={t('settings.onboarding.micLine')}
            />
          </StepFrame>
        ) : null}

        {step === STEP_GOAL ? (
          <StepFrame
            footer={
              <StepAction
                verb="listen"
                label={t('settings.onboarding.continue')}
                onPress={() => setStep(STEP_PASS_FIRST)}
              />
            }>
            <StepCopy
              kicker={t('settings.onboarding.goalKicker')}
              kickerColour={verb.listen.c1}
              title={t('settings.onboarding.goalTitle')}
              body={t('settings.onboarding.goalLine')}
            />
            <GoalOptions value={goal} onChange={setGoal} />
          </StepFrame>
        ) : null}

        {step >= STEP_PASS_FIRST && step <= STEP_PASS_LAST ? (
          <PassStep
            pass={(step - STEP_PASS_FIRST) as 0 | 1 | 2 | 3 | 4}
            learning={learning}
            understood={understand}
            onNext={() => setStep(step + 1)}
          />
        ) : null}

        {step === STEP_READY ? (
          <>
            <Confetti />
            <StepFrame
              footer={
                <>
                  <View style={styles.recordWrap}>
                    <RecordGlow size={132} />
                    <PrismButton
                      shape="round"
                      size={88}
                      verb="speak"
                      accessibilityLabel={t('settings.onboarding.recordFirstIsland')}
                      onPress={() => void finish('record')}>
                      <View style={styles.recordDot} />
                    </PrismButton>
                  </View>
                  <Text style={styles.readyCaption}>{t('settings.onboarding.recordFirstIsland')}</Text>
                  <StepAction
                    verb="tools"
                    on={false}
                    label={t('settings.onboarding.pickPodcast')}
                    onPress={() => void finish('podcast')}
                  />
                </>
              }>
              <StepCopy
                kicker={t('settings.onboarding.allSet')}
                kickerColour={tide.pos.verb}
                title={t('settings.onboarding.ready')}
                body={t('settings.onboarding.readyLine', {
                  learn: t(`language.${learning}` as Key),
                  understand: t(`language.${understand}` as Key),
                })}
              />
              <FirstIslandCard />
            </StepFrame>
          </>
        ) : null}
      </SafeAreaView>
    </View>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1, backgroundColor: tide.sky[0] },
  flow: { flex: 1 },
  skip: { position: 'absolute', right: Spacing.lg, zIndex: 1, height: prism.sizes.pill.h },
  // Skip sits at the end of the reading direction, so Hebrew puts it left.
  skipRtl: { right: undefined, left: Spacing.lg },
  // language-picker: the catalogue list carries its own side padding, so it
  // bleeds back out of the frame's gutter to keep the rows where they were.
  pickerBleed: { flex: 1, marginHorizontal: -(Spacing.xl - Spacing.lg) },
  micArt: { alignItems: 'center' },
  error: {
    fontFamily: fonts.ui,
    fontSize: 14,
    color: tide.record,
    textAlign: 'center',
    maxWidth: 280,
  },
  recordWrap: { alignItems: 'center', justifyContent: 'center' },
  readyCaption: { fontFamily: fonts.ui, fontSize: 15, color: tide.textDim },
  recordDot: { width: 28, height: 28, borderRadius: 14, backgroundColor: tide.record },
});
