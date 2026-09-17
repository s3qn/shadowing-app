import { useRouter } from 'expo-router';
import { useState } from 'react';
import { ScrollView, StyleSheet, Text, TextInput } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { CatConstellation } from '@/components/cat-constellation';
import { PressScale } from '@/components/press-scale';
import { fonts } from '@/constants/fonts';
import { Spacing, tide } from '@/constants/theme';
import * as api from '@/lib/api';

export default function SuggestFeatureScreen() {
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
      setError(e instanceof Error ? e.message : 'Could not send that. Try again.');
      setSending(false);
    }
  }

  return (
    <SafeAreaView edges={['bottom']} style={StyleSheet.flatten([styles.fill, { backgroundColor: tide.sky[0] }])}>
      <ScrollView contentContainerStyle={styles.list}>
        <Text style={[styles.hint, { color: tide.textDim }]}>
          Tell us what the app should do. Every suggestion gets read.
        </Text>

        <TextInput
          value={text}
          onChangeText={(value) => {
            setText(value);
            if (error) setError('');
          }}
          editable={!sending && !sent}
          multiline
          numberOfLines={6}
          textAlignVertical="top"
          placeholder="What should the app do?"
          placeholderTextColor={tide.textDim}
          style={[styles.input, { color: tide.text }]}
        />

        {error ? <Text style={[styles.error, { color: tide.record }]}>{error}</Text> : null}

        {sent ? (
          <Text style={[styles.sent, { color: tide.text }]}>Sent. Thanks.</Text>
        ) : (
          <PressScale
            disabled={!canSend}
            onPress={send}
            style={[styles.send, { backgroundColor: tide.lang.ja, opacity: canSend ? 1 : 0.4 }]}>
            {sending ? (
              <CatConstellation size={90} label="Sending" />
            ) : (
              <Text style={[styles.sendText, { color: tide.water }]}>Send</Text>
            )}
          </PressScale>
        )}
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1 },
  list: { padding: Spacing.lg, gap: Spacing.lg },
  hint: { fontFamily: fonts.ui, fontSize: 14 },
  input: {
    fontFamily: fonts.ui,
    fontSize: 16,
    backgroundColor: 'rgba(255,255,255,0.06)',
    borderRadius: 12,
    paddingHorizontal: 12,
    paddingVertical: 10,
    minHeight: 140,
  },
  error: { fontFamily: fonts.ui, fontSize: 14 },
  send: {
    height: 48,
    borderRadius: 12,
    alignItems: 'center',
    justifyContent: 'center',
  },
  sendText: { fontFamily: fonts.ui, fontSize: 16, fontWeight: '600' },
  sent: { fontFamily: fonts.ui, fontSize: 16, textAlign: 'center' },
});
