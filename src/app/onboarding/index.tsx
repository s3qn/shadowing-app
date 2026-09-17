import { requestRecordingPermissionsAsync } from 'expo-audio';
import { useRouter } from 'expo-router';
import { useEffect, useRef, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { LanguagePicker } from '@/components/language-picker';
import { PassStep } from '@/components/onboarding/pass-step';
import { WelcomeStep } from '@/components/onboarding/welcome-step';
import { PrismButton } from '@/components/prism';
import { fonts } from '@/constants/fonts';
import { Spacing, tide } from '@/constants/theme';
import { previewAppLanguage, useT } from '@/lib/i18n';
import { LANGUAGES } from '@/lib/languages';
import {
  type LearningLanguage,
  type UnderstoodLanguage,
  getSettingsSync,
  setLearningLanguage,
  setOnboarded,
  setUnderstoodLanguage,
} from '@/lib/settings';

const STEP_WELCOME = 0;
const STEP_LANGUAGES = 1;
const STEP_MIC = 2;
const STEP_PASS_FIRST = 3;
const STEP_PASS_LAST = 7;
const STEP_READY = 8;
const LAST_STEP = STEP_READY;

/**
 * First-run flow: explains shadowing, picks the two languages, asks for the
 * microphone, then launches the first island. One component with internal
 * step state rather than four routes, since nothing here needs deep-linking
 * or back-button history.
 */
export default function OnboardingScreen() {
  const { t } = useT();
  const router = useRouter();
  const [step, setStep] = useState(0);
  // Start from the saved pair (the root layout loads settings before any
  // screen renders), so Replay onboarding plus Skip keeps the learner's choice.
  const [learning, setLearning] = useState<LearningLanguage>(() => getSettingsSync().learningLanguage);
  const [understand, setUnderstand] = useState<UnderstoodLanguage>(() => getSettingsSync().understoodLanguage);
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
      await Promise.all([setOnboarded(true), setLearningLanguage(learning), setUnderstoodLanguage(understand)]);
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
      setStep(STEP_PASS_FIRST);
    } else {
      setMicError(true);
    }
  }

  function notNow() {
    setMicError(false);
    setStep(STEP_PASS_FIRST);
  }

  return (
    <SafeAreaView style={styles.fill}>
      {step < LAST_STEP ? (
        <PrismButton
          shape="pill"
          verb="tools"
          flat
          press="light"
          label={t('settings.onboarding.skip')}
          onPress={skip}
          containerStyle={styles.skip}
        />
      ) : null}

      {step === STEP_WELCOME ? <WelcomeStep onNext={() => setStep(STEP_LANGUAGES)} /> : null}

      {/* language-picker: start */}
      {step === STEP_LANGUAGES ? (
        <View style={styles.languageStep}>
          <View style={styles.languageHalf}>
            <Text style={styles.rowLabel}>{t('settings.languages.learn')}</Text>
            <LanguagePicker mode="learn" value={learning} onChange={selectLearning} exclude={understand} />
          </View>
          <View style={styles.languageHalf}>
            <Text style={styles.rowLabel}>{t('settings.languages.understand')}</Text>
            <LanguagePicker mode="understand" value={understand} onChange={setUnderstand} exclude={learning} />
          </View>
          <PrismButton
            shape="pill"
            verb="read"
            label={t('settings.onboarding.next')}
            onPress={() => setStep(STEP_MIC)}
            containerStyle={styles.action}
          />
        </View>
      ) : null}
      {/* language-picker: end */}

      {step === STEP_MIC ? (
        <View style={styles.content}>
          <Text style={styles.title}>{t('settings.onboarding.micPrompt')}</Text>
          <PrismButton
            shape="pill"
            verb="speak"
            label={t('settings.onboarding.allowMicrophone')}
            onPress={() => void allowMic()}
            containerStyle={styles.action}
          />
          {micError ? <Text style={styles.error}>{t('settings.onboarding.micError')}</Text> : null}
          <PrismButton
            shape="pill"
            verb="speak"
            flat
            press="light"
            label={t('settings.onboarding.notNow')}
            onPress={notNow}
            containerStyle={styles.notNow}
          />
        </View>
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
        <View style={styles.content}>
          <Text style={styles.readyTitle}>{t('settings.onboarding.ready')}</Text>
          <PrismButton
            shape="round"
            size={88}
            verb="speak"
            accessibilityLabel={t('settings.onboarding.recordFirstIsland')}
            onPress={() => void finish('record')}>
            <View style={styles.recordDot} />
          </PrismButton>
          <Text style={styles.readyCaption}>{t('settings.onboarding.recordFirstIsland')}</Text>
          <PrismButton
            shape="pill"
            verb="tools"
            flat
            label={t('settings.onboarding.pickPodcast')}
            onPress={() => void finish('podcast')}
            containerStyle={styles.action}
          />
        </View>
      ) : null}
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1, backgroundColor: tide.sky[0] },
  content: { flex: 1, alignItems: 'center', justifyContent: 'center', paddingHorizontal: Spacing.xl, gap: Spacing.lg },
  // language-picker: the language step needs top alignment and full width
  // for its two catalogue lists, unlike the other steps' centered `content`.
  languageStep: { flex: 1, paddingHorizontal: Spacing.lg, paddingTop: Spacing.lg, gap: Spacing.sm },
  languageHalf: { flex: 1, gap: Spacing.xs },
  skip: { position: 'absolute', top: Spacing.lg, right: Spacing.lg, zIndex: 1 },
  title: { fontFamily: fonts.ui, fontSize: 20, lineHeight: 28, color: tide.text, textAlign: 'center' },
  rowLabel: { fontFamily: fonts.uiMedium, fontSize: 15, color: tide.textDim, alignSelf: 'flex-start' },
  action: { marginTop: Spacing.md },
  notNow: { marginTop: Spacing.xs },
  error: {
    fontFamily: fonts.ui,
    fontSize: 14,
    color: tide.record,
    textAlign: 'center',
    maxWidth: 280,
  },
  readyTitle: { fontFamily: fonts.uiMedium, fontSize: 28, color: tide.text },
  readyCaption: { fontFamily: fonts.ui, fontSize: 15, color: tide.textDim },
  recordDot: { width: 28, height: 28, borderRadius: 14, backgroundColor: tide.record },
});
