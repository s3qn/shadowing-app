import { Linking, Platform, StyleSheet, Text, View } from 'react-native';

import { PrismButton } from '@/components/prism/prism-button';
import { tide } from '@/constants/theme';
import { useT } from '@/lib/i18n';
import { TESTFLIGHT_JOIN_URL, useUpdateGate } from '@/lib/update-gate';

/** Full-screen centred layout shared with the root ErrorBoundary. */
export const centerStyles = StyleSheet.create({
  root: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 32, backgroundColor: tide.water },
  title: { color: tide.text, fontSize: 22, fontWeight: '600', textAlign: 'center' },
  detail: { color: tide.textDim, fontSize: 12, textAlign: 'center', marginTop: 8, marginBottom: 24 },
  button: { alignSelf: 'center' },
});

/** Opaque blocking screen shown when a newer build exists. Rendered last in RootLayout. */
export function UpdateGate() {
  const { t } = useT();
  const gate = useUpdateGate();
  if (!gate) return null;
  const ios = Platform.OS === 'ios';
  const open = () => {
    Linking.openURL(gate.url).catch(() => {
      if (ios) void Linking.openURL(TESTFLIGHT_JOIN_URL).catch(() => {});
    });
  };
  return (
    <View style={[StyleSheet.absoluteFill, { zIndex: 9999, elevation: 9999 }]}>
      <View style={centerStyles.root}>
        <Text style={centerStyles.title}>{t('update.title')}</Text>
        <Text style={centerStyles.detail}>{t(ios ? 'update.body.ios' : 'update.body.android')}</Text>
        <PrismButton
          shape="pill"
          verb="listen"
          on
          label={t(ios ? 'update.button.ios' : 'update.button.android')}
          onPress={open}
          accessibilityRole="button"
          containerStyle={centerStyles.button}
        />
      </View>
    </View>
  );
}
