import { requestRecordingPermissionsAsync } from 'expo-audio';
import { useRouter } from 'expo-router';
import { useRef, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { PrismButton } from '@/components/prism';
import { fonts } from '@/constants/fonts';
import { Spacing, tide } from '@/constants/theme';
import {
  type LearningLanguage,
  type UnderstoodLanguage,
  getSettingsSync,
  setLearningLanguage,
  setOnboarded,
  setUnderstoodLanguage,
} from '@/lib/settings';

const LEARN_OPTIONS: { value: LearningLanguage; label: string }[] = [
  { value: 'ja', label: 'Japanese' },
  { value: 'es', label: 'Spanish' },
  { value: 'en', label: 'English' },
];

const UNDERSTAND_OPTIONS: { value: UnderstoodLanguage; label: string }[] = [
  { value: 'he', label: 'Hebrew' },
  { value: 'en', label: 'English' },
];

const LAST_STEP = 3;

/**
 * First-run flow: explains shadowing, picks the two languages, asks for the
 * microphone, then launches the first island. One component with internal
 * step state rather than four routes, since nothing here needs deep-linking
 * or back-button history.
 */
export default function OnboardingScreen() {
  const router = useRouter();
  const [step, setStep] = useState(0);
  // Start from the saved pair (the root layout loads settings before any
  // screen renders), so Replay onboarding plus Skip keeps the learner's choice.
  const [learning, setLearning] = useState<LearningLanguage>(() => getSettingsSync().learningLanguage);
  const [understand, setUnderstand] = useState<UnderstoodLanguage>(() => getSettingsSync().understoodLanguage);
  const [micError, setMicError] = useState(false);
  const leaving = useRef(false);

  function selectLearning(value: LearningLanguage) {
    setLearning(value);
    // English can only pair with Hebrew as the understood language: force it
    // rather than let the invalid pair happen and error later.
    if (value === 'en' && understand === 'en') setUnderstand('he');
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
      setStep(3);
    } else {
      setMicError(true);
    }
  }

  function notNow() {
    setMicError(false);
    setStep(3);
  }

  return (
    <SafeAreaView style={styles.fill}>
      {step < LAST_STEP ? (
        <PrismButton
          shape="pill"
          verb="tools"
          flat
          press="light"
          label="Skip"
          onPress={skip}
          containerStyle={styles.skip}
        />
      ) : null}

      {step === 0 ? (
        <View style={styles.content}>
          <Text style={styles.title}>Listen to a native voice.</Text>
          <Text style={styles.title}>Speak along, a beat behind it, then compare.</Text>
          <PrismButton
            shape="pill"
            verb="listen"
            label="Next"
            onPress={() => setStep(1)}
            containerStyle={styles.action}
          />
        </View>
      ) : null}

      {step === 1 ? (
        <View style={styles.content}>
          <Text style={styles.rowLabel}>I want to learn</Text>
          <View style={styles.row}>
            {LEARN_OPTIONS.map((opt) => (
              <PrismButton
                key={opt.value}
                shape="pill"
                verb="read"
                flat
                label={opt.label}
                on={learning === opt.value}
                onPress={() => selectLearning(opt.value)}
              />
            ))}
          </View>
          <Text style={styles.rowLabel}>I understand</Text>
          <View style={styles.row}>
            {UNDERSTAND_OPTIONS.map((opt) => (
              <PrismButton
                key={opt.value}
                shape="pill"
                verb="read"
                flat
                label={opt.label}
                on={understand === opt.value}
                disabled={learning === 'en' && opt.value === 'en'}
                onPress={() => setUnderstand(opt.value)}
              />
            ))}
          </View>
          <PrismButton
            shape="pill"
            verb="read"
            label="Next"
            onPress={() => setStep(2)}
            containerStyle={styles.action}
          />
        </View>
      ) : null}

      {step === 2 ? (
        <View style={styles.content}>
          <Text style={styles.title}>The app needs your microphone to record you speaking along.</Text>
          <PrismButton
            shape="pill"
            verb="speak"
            label="Allow microphone"
            onPress={() => void allowMic()}
            containerStyle={styles.action}
          />
          {micError ? (
            <Text style={styles.error}>Microphone access is off. Turn it on in Settings and try again.</Text>
          ) : null}
          <PrismButton
            shape="pill"
            verb="speak"
            flat
            press="light"
            label="Not now"
            onPress={notNow}
            containerStyle={styles.notNow}
          />
        </View>
      ) : null}

      {step === LAST_STEP ? (
        <View style={styles.content}>
          <PrismButton
            shape="pill"
            verb="tools"
            label="Record your first island"
            onPress={() => void finish('record')}
            containerStyle={styles.action}
          />
          <PrismButton
            shape="pill"
            verb="tools"
            label="Pick a podcast"
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
  skip: { position: 'absolute', top: Spacing.lg, right: Spacing.lg, zIndex: 1 },
  title: { fontFamily: fonts.ui, fontSize: 20, lineHeight: 28, color: tide.text, textAlign: 'center' },
  rowLabel: { fontFamily: fonts.uiMedium, fontSize: 15, color: tide.textDim, alignSelf: 'flex-start' },
  row: { flexDirection: 'row', flexWrap: 'wrap', gap: Spacing.sm, justifyContent: 'center' },
  action: { marginTop: Spacing.md },
  notNow: { marginTop: Spacing.xs },
  error: {
    fontFamily: fonts.ui,
    fontSize: 14,
    color: tide.record,
    textAlign: 'center',
    maxWidth: 280,
  },
});
