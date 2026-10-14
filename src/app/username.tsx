import { useRouter, useLocalSearchParams } from 'expo-router';
import { useEffect, useRef, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { OnboardingSky } from '@/components/onboarding/onboarding-sky';
import { PrismButton } from '@/components/prism';
import { GlassInput } from '@/components/tide/glass-input';
import { fonts } from '@/constants/fonts';
import { Radius, Spacing, tide } from '@/constants/theme';
import { checkUsername, getUsername, setUsername } from '@/lib/api';
import { useDir, useT } from '@/lib/i18n';

const RULE = /^[a-z0-9_]{3,20}$/;
const CHARS = 'abcdefghijklmnopqrstuvwxyz0123456789';

function suggestion(): string {
  let s = 'cat_';
  for (let i = 0; i < 4; i++) s += CHARS[Math.floor(Math.random() * CHARS.length)];
  return s;
}

type Status = 'idle' | 'checking' | 'available' | 'taken' | 'invalid';

/** Pick or change the public @handle. With `first=1` it is required: no
 * close button and no swipe away. Otherwise (from Settings) it can be left. */
export default function UsernameScreen() {
  const router = useRouter();
  const { first } = useLocalSearchParams<{ first?: string }>();
  const required = first === '1';
  const { t } = useT();
  const dir = useDir();
  const [name, setName] = useState('');
  const [status, setStatus] = useState<Status>('idle');
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const counter = useRef(0);

  // Start from the current handle, else a suggestion so nobody faces a blank field.
  useEffect(() => {
    let alive = true;
    void (async () => {
      let current: string | null = null;
      try {
        current = await getUsername();
      } catch {
        current = null;
      }
      if (alive) setName(current ?? suggestion());
    })();
    return () => {
      alive = false;
    };
  }, []);

  // Local rule first, then the server probe after 400 ms. A response that
  // arrives after a newer keystroke is dropped.
  useEffect(() => {
    if (!name) return;
    const id = ++counter.current;
    setError('');
    if (!RULE.test(name.trim().toLowerCase())) {
      setStatus('invalid');
      return;
    }
    setStatus('checking');
    const timer = setTimeout(() => {
      checkUsername(name)
        .then((r) => {
          if (id !== counter.current) return;
          setStatus(r.available ? 'available' : r.reason === 'taken' ? 'taken' : 'invalid');
        })
        .catch((err: unknown) => {
          if (id !== counter.current) return;
          setStatus('idle');
          setError(t('username.error'));
        });
    }, 400);
    return () => clearTimeout(timer);
  }, [name]);

  function leave() {
    if (router.canGoBack()) router.back();
    else router.replace('/(tabs)');
  }

  async function save() {
    setSaving(true);
    setError('');
    try {
      await setUsername(name);
      leave();
    } catch (err: unknown) {
      setError(t('username.error'));
      setSaving(false);
    }
  }

  const message =
    error ||
    (status === 'available'
      ? t('username.available')
      : status === 'taken'
        ? t('username.taken')
        : status === 'invalid'
          ? t('username.invalid')
          : status === 'checking'
            ? t('username.checking')
            : t('username.hint'));
  const colour = error || status === 'taken' || status === 'invalid' ? tide.record : status === 'available' ? tide.pos.verb : tide.textDim;

  return (
    <View style={styles.fill}>
      <OnboardingSky />
      <SafeAreaView style={styles.fill}>
        <View style={styles.body}>
          <Text style={[styles.title, dir.text]}>{t('username.title')}</Text>
          <View style={styles.field}>
            <Text style={styles.at}>@</Text>
            <GlassInput
              style={styles.input}
              value={name}
              onChangeText={setName}
              autoCapitalize="none"
              autoCorrect={false}
              maxLength={20}
              textAlign="left"
              selectTextOnFocus
              accessibilityLabel={t('username.title')}
            />
          </View>
          <Text style={[styles.status, { color: colour }]}>{message}</Text>
        </View>
        <View style={styles.footer}>
          <PrismButton
            shape="pill"
            verb="speak"
            on
            width={240}
            height={52}
            label={t('username.save')}
            disabled={status !== 'available' || saving}
            onPress={() => void save()}
          />
          {required ? null : (
            <PrismButton shape="pill" verb="tools" on={false} width={240} height={52} label={t('common.cancel')} onPress={leave} />
          )}
        </View>
      </SafeAreaView>
    </View>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1 },
  body: { flex: 1, justifyContent: 'center', paddingHorizontal: Spacing.lg, gap: Spacing.md },
  title: { fontFamily: fonts.ui, fontSize: 26, fontWeight: '700', color: tide.text },
  field: { flexDirection: 'row', alignItems: 'center', gap: Spacing.sm },
  at: { fontFamily: fonts.ui, fontSize: 20, color: tide.textDim },
  input: { flex: 1, textAlign: 'left', writingDirection: 'ltr', borderRadius: Radius.md },
  status: { fontFamily: fonts.ui, fontSize: 14, minHeight: 20 },
  footer: { alignItems: 'center', gap: Spacing.sm, paddingBottom: Spacing.lg },
});
