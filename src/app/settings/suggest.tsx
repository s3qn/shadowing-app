import { useRouter } from 'expo-router';
import { useState } from 'react';
import { ScrollView, StyleSheet, Text } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { CatConstellation } from '@/components/cat-constellation';
import { PrismButton } from '@/components/prism';
import { GlassInput } from '@/components/tide/glass-input';
import { fonts } from '@/constants/fonts';
import { Spacing, tide } from '@/constants/theme';
import * as api from '@/lib/api';
import { useDir, useT } from '@/lib/i18n';

export default function SuggestFeatureScreen() {
  const { t } = useT();
  const dir = useDir();
  const router = useRouter();
  const [text, setText] = useState('');
  const [sending, setSending] = useState(false);
  const [sent, setSent] = useState(false);
  const [error, setError] = useState('');

  const canSend = text.trim().length > 0 && !sending;

  async function send() {
    setError('');
    setSending(true);
    try {
      await api.suggestFeature(text.trim());
      setText('');
      setSent(true);
      setTimeout(() => router.back(), 900);
    } catch (e) {
      setError(e instanceof Error ? e.message : t('settings.suggest.error'));
      setSending(false);
    }
  }

  return (
    <SafeAreaView edges={['bottom']} style={StyleSheet.flatten([styles.fill, { backgroundColor: tide.sky[0] }])}>
      <ScrollView contentContainerStyle={styles.list}>
        <Text style={[styles.hint, { color: tide.textDim }, dir.text]}>{t('settings.suggest.hint')}</Text>

        <GlassInput
          value={text}
          onChangeText={(value) => {
            setText(value);
            if (error) setError('');
          }}
          editable={!sending && !sent}
          multiline
          numberOfLines={6}
          textAlignVertical="top"
          placeholder={t('settings.suggest.placeholder')}
          placeholderTextColor={tide.textDim}
          style={[styles.input, dir.text]}
        />

        {error ? <Text style={[styles.error, { color: tide.record }, dir.text]}>{error}</Text> : null}

        {sent ? (
          <Text style={[styles.sent, { color: tide.text }]}>{t('settings.suggest.sent')}</Text>
        ) : sending ? (
          <CatConstellation size={90} label={t('settings.suggest.sending')} />
        ) : (
          <PrismButton
            shape="pill"
            verb="tools"
            on
            label={t('settings.suggest.send')}
            disabled={!canSend}
            onPress={send}
            accessibilityRole="button"
            containerStyle={styles.send}
          />
        )}
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1 },
  list: { padding: Spacing.lg, gap: Spacing.lg },
  hint: { fontFamily: fonts.ui, fontSize: 14 },
  input: { minHeight: 140 },
  error: { fontFamily: fonts.ui, fontSize: 14 },
  send: { alignSelf: 'center' },
  sent: { fontFamily: fonts.ui, fontSize: 16, textAlign: 'center' },
});
