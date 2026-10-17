import { Stack } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { CatConstellation } from '@/components/cat-constellation';
import { HeaderClosePill } from '@/components/header-close-pill';
import { fonts } from '@/constants/fonts';
import { Spacing, tide } from '@/constants/theme';
import { useT } from '@/lib/i18n';

/** The shared build screen: close pill, the cat loader with the stage label,
 * a hint and any error. `stage` is the already-translated label. */
export function BuildProgress({
  stage,
  hint,
  error,
  blankTitle,
  onClose,
}: {
  stage: string;
  hint: string;
  error?: string;
  /** Hide the route's header title. */
  blankTitle?: boolean;
  onClose: () => void;
}) {
  const { t } = useT();
  return (
    <SafeAreaView edges={['bottom']} style={StyleSheet.flatten([styles.fill, { backgroundColor: tide.sky[0] }])}>
      <StatusBar style="light" />
      <Stack.Screen
        options={{
          ...(blankTitle ? { title: '' } : null),
          headerStyle: { backgroundColor: tide.sky[0] },
          headerTintColor: tide.text,
          headerShadowVisible: false,
          headerLeft: () => <HeaderClosePill label={t('record.close')} onPress={onClose} />,
        }}
      />
      <View style={styles.center}>
        <CatConstellation size={120} label={stage.replace(/…$/, '')} />
        <Text style={[styles.hint, styles.centerText]}>{hint}</Text>
        {error ? <Text style={[styles.error, styles.centerText]}>{error}</Text> : null}
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
