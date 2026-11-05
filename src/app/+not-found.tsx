import { Stack, useRouter } from 'expo-router';
import { Text, View } from 'react-native';

import { PrismButton } from '@/components/prism/prism-button';
import { tide } from '@/constants/theme';
import { centerStyles } from '@/components/update-gate';
import { useT } from '@/lib/i18n';

/** Any unknown deep link lands here instead of Expo's English "Unmatched Route" page. */
export default function NotFound() {
  const { t } = useT();
  const router = useRouter();
  return (
    <View style={[centerStyles.root, { backgroundColor: tide.sky[0] }]}>
      {/* No header: its default title is the route name, and the page already says it and has a way home. */}
      <Stack.Screen options={{ headerShown: false }} />
      <Text style={[centerStyles.title, { marginBottom: 24 }]}>{t('notFound.title')}</Text>
      <PrismButton
        shape="pill"
        verb="listen"
        on
        label={t('notFound.home')}
        onPress={() => router.replace('/')}
        accessibilityRole="button"
        containerStyle={centerStyles.button}
      />
    </View>
  );
}
