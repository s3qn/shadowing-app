import { useRouter } from 'expo-router';
import { StyleSheet, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { OnboardingSky } from '@/components/onboarding/onboarding-sky';
import { SignInStep } from '@/components/onboarding/sign-in-step';

/** The account step on its own: a returning install with no session, and
 * the place Settings sends you after sign-out or account deletion. */
export default function SignInScreen() {
  const router = useRouter();
  return (
    <View style={styles.fill}>
      <OnboardingSky />
      <SafeAreaView edges={['bottom']} style={styles.fill}>
        <SignInStep onSignedIn={() => (router.canGoBack() ? router.back() : router.replace('/(tabs)'))} />
      </SafeAreaView>
    </View>
  );
}

const styles = StyleSheet.create({ fill: { flex: 1 } });
