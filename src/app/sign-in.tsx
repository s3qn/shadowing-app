import { useRouter } from 'expo-router';
import { StyleSheet, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { OnboardingSky } from '@/components/onboarding/onboarding-sky';
import { SignInStep } from '@/components/onboarding/sign-in-step';
import { getUsername } from '@/lib/api';

/** The account step on its own: a returning install with no session, and
 * the place Settings sends you after sign-out or account deletion. */
export default function SignInScreen() {
  const router = useRouter();

  // A new account has no handle yet: go on to the required username screen.
  // A failed lookup does not block, the launch check retries.
  async function finish() {
    let missing = false;
    try {
      missing = (await getUsername()) === null;
    } catch {
      missing = false;
    }
    if (missing) router.replace({ pathname: '/username', params: { first: '1' } });
    else if (router.canGoBack()) router.back();
    else router.replace('/(tabs)');
  }
  return (
    <View style={styles.fill}>
      <OnboardingSky />
      <SafeAreaView edges={['bottom']} style={styles.fill}>
        <SignInStep onSignedIn={() => void finish()} />
      </SafeAreaView>
    </View>
  );
}

const styles = StyleSheet.create({ fill: { flex: 1 } });
