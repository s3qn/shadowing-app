import { requestRecordingPermissionsAsync } from 'expo-audio';
import { useRouter } from 'expo-router';
import { useEffect, useRef, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { useReducedMotion, useSharedValue } from 'react-native-reanimated';
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';

import { LanguagePicker } from '@/components/language-picker';
import { GoalOptions } from '@/components/onboarding/goal-step';
import { useHeroClock } from '@/components/onboarding/hero-clock';
import { MicArt } from '@/components/onboarding/mic-art';
import { OnboardingSky } from '@/components/onboarding/onboarding-sky';
import { StarterStep } from '@/components/onboarding/starter-step';
import { StepAction, StepCopy, StepFrame } from '@/components/onboarding/step-frame';
import { SignInStep, prefetchAppleAvailable } from '@/components/onboarding/sign-in-step';
import { WelcomeStep } from '@/components/onboarding/welcome-step';
import { PrismButton } from '@/components/prism';
import { fonts } from '@/constants/fonts';
import { Spacing, prism, tide, verb } from '@/constants/theme';
import { getUsername } from '@/lib/api';
import { hasSessionSync } from '@/lib/auth';
import { devWelcomeForceAccount, devWelcomeReduced } from '@/lib/dev-simulate';
import { isLang, previewAppLanguage, useDir, useT } from '@/lib/i18n';
import { LANGUAGES } from '@/lib/languages';
import { requestLoader } from '@/lib/loading-overlay';
import { useExitScreen } from '@/lib/use-exit-screen';
import {
  type DailyGoalMinutes,
  type LearningLanguage,
  type StarterLevel,
  type UnderstoodLanguage,
  getSettingsSync,
  setDailyGoalMinutes,
  setLearningLanguage,
  setReading,
  toIslandLanguage,
  setGuideStep,
  setOnboarded,
  setStarterLevel,
  setUnderstoodLanguage,
} from '@/lib/settings';
import { type Key } from '@/locales/en';

const STEP_WELCOME = 0;
const STEP_ACCOUNT = 1;
const STEP_LEARN = 2;
const STEP_UNDERSTAND = 3;
const STEP_MIC = 4;
const STEP_GOAL = 5;
const STEP_START = 6;
const LAST_STEP = STEP_START;

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
  const exit = useExitScreen('/(tabs)');
  const [step, setStep] = useState(0);

  // After the account step: a new account has no handle, so the required
  // username screen opens over onboarding. A failed lookup does not block.
  async function afterSignIn() {
    setStep(STEP_LEARN);
    try {
      if ((await getUsername()) === null) router.push({ pathname: '/username', params: { first: '1' } });
    } catch {
      // Offline or signed out: the launch check asks again.
    }
  }
  // Start from the saved pair (the root layout loads settings before any
  // screen renders), so Replay onboarding plus Skip keeps the learner's choice.
  const [learning, setLearning] = useState<LearningLanguage>(() => getSettingsSync().learningLanguage);
  const [understand, setUnderstand] = useState<UnderstoodLanguage>(() => getSettingsSync().understoodLanguage);
  const [goal, setGoal] = useState<DailyGoalMinutes>(() => getSettingsSync().dailyGoalMinutes);
  const [micError, setMicError] = useState(false);
  const leaving = useRef(false);

  // The welcome's hand-off. Read once at mount: whether Get started leads to
  // the Account step (no session, or the `welcome.handoff` key) decides
  // whether SignInStep mounts under the welcome from the start, invisible,
  // so nothing mounts on the press itself. One clock drives the hero, its
  // exit and the Account entrance; at h 760 the welcome layer unmounts once.
  const needsAccount = useRef(!hasSessionSync() || devWelcomeForceAccount()).current;
  const reduced = useReducedMotion() || devWelcomeReduced();
  // How far the welcome pill rides up to land on the Account step's first
  // pill: measured by SignInStep's footer, 0 when it is not mounted.
  const travel = useSharedValue(0);
  const clock = useHeroClock({
    running: step === STEP_WELCOME,
    onDone: () => setStep(needsAccount ? STEP_ACCOUNT : STEP_LEARN),
  });
  useEffect(() => {
    void prefetchAppleAvailable();
  }, []);

  // Previews the interface in whichever language is picked as "understood",
  // so the languages step flips the rest of onboarding at once (decision 1,
  // soft RTL: no restart needed). Only 'en'/'he' have a catalogue today; any
  // other pick clears the preview and falls back to the saved app language.
  useEffect(() => {
    // The welcome and sign-in steps keep the saved app language: the saved
    // understood language says nothing about it until the learner reaches the pickers.
    previewAppLanguage(step >= STEP_LEARN && isLang(understand) ? understand : null);
    return () => previewAppLanguage(null);
  }, [understand, step]);

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
  async function saveAll(markOnboarded = true) {
    try {
      await Promise.all([
        markOnboarded ? setOnboarded(true) : Promise.resolve(),
        setLearningLanguage(learning),
        setUnderstoodLanguage(understand),
        setDailyGoalMinutes(goal),
        // Furigana is Japanese-only: other learners start with reading off.
        toIslandLanguage(learning) === 'ja' ? Promise.resolve() : setReading('off'),
      ]);
    } catch (err: unknown) {
      console.warn('saving onboarding failed', err);
    }
  }

  async function finish() {
    if (leaving.current) return;
    leaving.current = true;
    await saveAll();
    exit();
  }

  // A level pill: saves the languages and the pick, then arms the first-run guide on Home.
  async function start(level: StarterLevel) {
    if (leaving.current) return;
    leaving.current = true;
    try {
      await saveAll(false);
      await setStarterLevel(level);
      await setGuideStep('home');
      await setOnboarded(true);
      // The guide starts on Home, wherever the intro was opened from (Settings > Replay).
      if (router.canDismiss()) router.dismissAll();
      router.navigate('/');
    } catch (err: unknown) {
      leaving.current = false;
      console.warn('starting after onboarding failed', err);
    }
  }

  // Sign-in is required: with no session, Skip never jumps past the account step.
  function skip() {
    if (!hasSessionSync()) {
      setStep(STEP_ACCOUNT);
      return;
    }
    void finish();
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
        {step !== STEP_ACCOUNT && (step !== STEP_WELCOME || hasSessionSync()) ? (
          <PrismButton
            shape="pill"
            verb="tools"
            flat
            press="light"
            label={t('settings.onboarding.skip')}
            onPress={skip}
            containerStyle={[styles.skip, { top: insets.top + Spacing.sm, ...(dir.rtl ? { left: Spacing.lg } : { right: Spacing.lg }) }]}
          />
        ) : null}

        {/* Two layers while the welcome is up: SignInStep above it (the
            board's kicker sits over the hero), untouchable until the
            hand-off is done. Each sits in its own slot, so the welcome
            unmounting never remounts the Account step. */}
        {step === STEP_WELCOME ? (
          <View style={styles.layer}>
            <WelcomeStep tk={clock.tk} tapT={clock.tapT} travel={travel} reduced={reduced} onPress={clock.press} />
          </View>
        ) : null}

        {step === STEP_ACCOUNT || (step === STEP_WELCOME && needsAccount) ? (
          <View style={styles.layer} pointerEvents={step === STEP_ACCOUNT ? 'auto' : 'none'}>
            <SignInStep
              clock={needsAccount ? clock : undefined}
              travel={travel}
              reduced={reduced}
              onSignedIn={() => void afterSignIn()}
            />
          </View>
        ) : null}

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
                onPress={() => setStep(STEP_START)}
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

        {step === STEP_START ? (
          <StarterStep language={learning} onStart={(level) => void start(level)} />
        ) : null}
      </SafeAreaView>
    </View>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1, backgroundColor: tide.sky[0] },
  flow: { flex: 1 },
  // The welcome and the Account step overlap through the hand-off.
  layer: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0 },
  // Skip lies on the row `StepFrame` reserves at the top of every step, so
  // the picker's search field starts below it and a tap near the pill's
  // bottom edge cannot land on the field underneath. It hugs the end of the
  // reading direction (left in Hebrew, right in English), and that one side
  // is set where it is used rather than overridden by a second style here:
  // React Native merges a style array key by key, so a later `right:
  // undefined` does not unset an earlier `right`, and a box with both sides
  // pinned stretches the whole width. That is how Skip became a banner.
  skip: { position: 'absolute', zIndex: 1, height: prism.sizes.pill.h },
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
});
