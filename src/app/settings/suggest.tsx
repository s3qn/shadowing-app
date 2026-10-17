import * as Haptics from 'expo-haptics';
import { useRouter } from 'expo-router';
import { useEffect, useState } from 'react';
import { ScrollView, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import Animated, { useAnimatedStyle, useSharedValue, withTiming } from 'react-native-reanimated';

import { CatConstellation } from '@/components/cat-constellation';
import { PrismButton } from '@/components/prism';
import { GlassInput } from '@/components/tide/glass-input';
import { fonts } from '@/constants/fonts';
import { Spacing, tide } from '@/constants/theme';
import * as api from '@/lib/api';
import { hapticNotify } from '@/lib/haptics';
import { useDir, useT } from '@/lib/i18n';

const FADE_MS = 180;

export default function SuggestFeatureScreen() {
  const { t } = useT();
  const dir = useDir();
  const router = useRouter();
  const [text, setText] = useState('');
  const [sending, setSending] = useState(false);
  const [sent, setSent] = useState(false);
  const [error, setError] = useState('');

  const canSend = text.trim().length > 0 && !sending;

  const buttonOpacity = useSharedValue(1);
  const loaderOpacity = useSharedValue(0);
  const sentOpacity = useSharedValue(0);

  useEffect(() => {
    buttonOpacity.value = withTiming(!sending && !sent ? 1 : 0, { duration: FADE_MS });
    loaderOpacity.value = withTiming(sending && !sent ? 1 : 0, { duration: FADE_MS });
    sentOpacity.value = withTiming(sent ? 1 : 0, { duration: FADE_MS });
  }, [sending, sent, buttonOpacity, loaderOpacity, sentOpacity]);

  const buttonStyle = useAnimatedStyle(() => ({ opacity: buttonOpacity.value }));
  const loaderStyle = useAnimatedStyle(() => ({ opacity: loaderOpacity.value }));
  const sentStyle = useAnimatedStyle(() => ({ opacity: sentOpacity.value }));

  async function send() {
    setError('');
    setSending(true);
    try {
      await api.suggestFeature(text.trim());
      setText('');
      setSent(true);
      void hapticNotify(Haptics.NotificationFeedbackType.Success);
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

        <View style={styles.stack}>
          <Animated.View style={[styles.layer, buttonStyle]} pointerEvents={sending || sent ? 'none' : 'auto'}>
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
          </Animated.View>
          <Animated.View style={[styles.layer, loaderStyle]} pointerEvents={sending && !sent ? 'auto' : 'none'}>
            <CatConstellation size={90} label={t('settings.suggest.sending')} />
          </Animated.View>
          <Animated.View style={[styles.layer, sentStyle]} pointerEvents={sent ? 'auto' : 'none'}>
            <Text style={[styles.sent, { color: tide.text }]}>{t('settings.suggest.sent')}</Text>
          </Animated.View>
        </View>
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
  stack: { height: 90 },
  layer: { ...StyleSheet.absoluteFill, justifyContent: 'center', alignItems: 'center' },
  send: { alignSelf: 'center' },
  sent: { fontFamily: fonts.ui, fontSize: 16, textAlign: 'center' },
});
