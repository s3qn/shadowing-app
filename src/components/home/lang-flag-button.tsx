/**
 * Home's header flag: the learning language as a round prism button with a
 * small chevron badge. Tap opens the learning-language screen, where the pair
 * rule with the understood language already lives. Reads the setting from the
 * store so it updates when the user comes back.
 */

import { useRouter } from 'expo-router';
import { useEffect, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';

import { PrismButton } from '@/components/prism/prism-button';
import { getLanguage } from '@/lib/languages';
import { useT } from '@/lib/i18n';
import { getSettingsSync, subscribeSettings } from '@/lib/settings';

export function LangFlagButton() {
  const { t } = useT();
  const router = useRouter();
  const [id, setId] = useState(() => getSettingsSync().learningLanguage);
  useEffect(() => subscribeSettings(() => setId(getSettingsSync().learningLanguage)), []);
  const lang = getLanguage(id);
  const face = lang?.flag ?? lang?.letter ?? '';
  return (
    <View>
      <PrismButton
        shape="round"
        size={40}
        verb="tools"
        onPress={() => router.push('/settings/languages')}
        accessibilityLabel={t('home.learningLanguageButton', { name: lang?.english ?? id })}>
        <Text style={styles.flag}>{face}</Text>
      </PrismButton>
      <View pointerEvents="none" style={styles.badge}>
        <Text style={styles.chevron}>▾</Text>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  flag: { fontSize: 22 },
  badge: {
    position: 'absolute',
    bottom: -3,
    end: -3,
    width: 16,
    height: 16,
    borderRadius: 8,
    backgroundColor: '#1D3B4A',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.35)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  chevron: { fontSize: 9, lineHeight: 12, fontWeight: '700', color: '#CCEEFF' },
});
