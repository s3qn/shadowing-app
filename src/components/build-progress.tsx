import { Stack, useLocalSearchParams, usePathname, useRouter } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { CatConstellation } from '@/components/cat-constellation';
import { useClosePillOptions } from '@/components/header-close-pill';
import { fonts } from '@/constants/fonts';
import { Spacing, tide } from '@/constants/theme';
import { SecondaryAction } from '@/components/prism/actions';
import { useT } from '@/lib/i18n';

/** The shared build screen: close pill, the cat loader with the stage label,
 * a hint and any error. `stage` is the already-translated label. */
export function BuildProgress({
  stage,
  hint,
  eta,
  error,
  blankTitle,
  onRetry,
  noRetry,
  onClose,
}: {
  stage: string;
  hint: string;
  /** The countdown line. With it the leave notice replaces `hint`. */
  eta?: string | null;
  error?: string;
  /** Hide the route's header title. */
  blankTitle?: boolean;
  /** Runs the build again in place. Without it Retry re-opens the route. */
  onRetry?: () => void;
  /** Hides Retry when running the build again cannot help. */
  noRetry?: boolean;
  onClose: () => void;
}) {
  const { t } = useT();
  const closePill = useClosePillOptions(t('record.close'), onClose);
  const router = useRouter();
  const pathname = usePathname();
  const params = useLocalSearchParams();
  // Replacing the route with itself remounts it, which starts the build again.
  const retry = onRetry ?? (() => router.replace({ pathname: pathname as never, params: params as never }));
  return (
    <SafeAreaView edges={['bottom']} style={StyleSheet.flatten([styles.fill, { backgroundColor: tide.sky[0] }])}>
      <StatusBar style="light" />
      <Stack.Screen
        options={{
          ...(blankTitle ? { title: '' } : null),
          ...closePill,
        }}
      />
      <View style={styles.center}>
        {error ? (
          <>
            <Text style={[styles.error, styles.centerText]}>{error}</Text>
            {noRetry ? null : <SecondaryAction label={t('common.retry')} onPress={retry} />}
          </>
        ) : (
          <>
            <CatConstellation size={120} label={stage.replace(/…$/, '')} />
            {eta ? <Text style={[styles.hint, styles.centerText]}>{eta}</Text> : null}
            <Text style={[styles.hint, styles.centerText]}>{eta ? t('eta.leave') : hint}</Text>
          </>
        )}
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1 },
  center: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    gap: Spacing.lg,
    paddingHorizontal: 16,
  },
  centerText: { textAlign: 'center' },
  hint: { fontSize: 14, lineHeight: 20, color: tide.textDim, fontFamily: fonts.ui },
  error: { fontSize: 14, lineHeight: 20, color: tide.record, fontFamily: fonts.ui },
});
