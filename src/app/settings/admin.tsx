import { useRouter } from 'expo-router';
import { useCallback, useEffect, useState } from 'react';
import { ScrollView, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { CatConstellation } from '@/components/cat-constellation';
import { PrismButton } from '@/components/prism/prism-button';
import { SettingsRow, SettingsSection } from '@/components/tide/settings-row';
import { Spacing, tide } from '@/constants/theme';
import * as api from '@/lib/api';
import { betaDenied, betaSimulated, refreshBeta, setBetaOverride, useBetaFeatures } from '@/lib/beta';
import { useT } from '@/lib/i18n';

type Load = { kind: 'loading' } | { kind: 'denied' } | { kind: 'failed' } | { kind: 'ready'; people: api.BetaPerson[] };

/** launch-basics: the admin picks who sees YouTube, Podcast and Import. People come from the list, nobody types an id. */
export default function AdminScreen() {
  const { t } = useT();
  const features = useBetaFeatures();
  const router = useRouter();
  const [load, setLoad] = useState<Load>(() => (betaDenied() ? { kind: 'denied' } : { kind: 'loading' }));
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (betaDenied()) return;
    let alive = true;
    api
      .adminListBeta()
      .then((people) => alive && setLoad({ kind: 'ready', people }))
      .catch((e: unknown) => alive && setLoad({ kind: (e as { status?: number }).status === 403 ? 'denied' : 'failed' }));
    return () => {
      alive = false;
    };
  }, []);

  const toggle = useCallback(
    (owner: string, enabled: boolean, me: boolean) => {
      setError(null);
      // beta-gate: my own real flip beats a simulated one from the review tour (a no-op outside __DEV__).
      if (me) setBetaOverride({});
      setLoad((l) => (l.kind === 'ready' ? { kind: 'ready', people: l.people.map((p) => (p.owner === owner ? { ...p, enabled } : p)) } : l));
      api
        .adminSetBeta(owner, enabled)
        .then(() => {
          if (!me) return;
          return refreshBeta();
        })
        .catch(() => {
          setError(t('admin.saveFailed'));
          setLoad((l) => (l.kind === 'ready' ? { kind: 'ready', people: l.people.map((p) => (p.owner === owner ? { ...p, enabled: !enabled } : p)) } : l));
        });
    },
    [t],
  );

  if (load.kind === 'loading') {
    return (
      <SafeAreaView style={styles.fill} edges={['bottom']}>
        <View style={styles.center}>
          <CatConstellation size={120} label={t('common.loading')} />
        </View>
      </SafeAreaView>
    );
  }
  if (load.kind === 'denied' || load.kind === 'failed') {
    return (
      <SafeAreaView style={styles.fill} edges={['bottom']}>
        <Text style={styles.note}>{load.kind === 'denied' ? t('admin.denied') : t('admin.failed')}</Text>
        <View style={styles.back}>
          <PrismButton shape="pill" verb="listen" on label={t('admin.back')} onPress={() => router.back()} />
        </View>
      </SafeAreaView>
    );
  }

  const mine = load.people.find((p) => p.me);
  // Under a dev simulate key the own switch shows what the app runs on, not the stored flag.
  const mineOn = mine ? (betaSimulated() ? features.beta : mine.enabled) : false;
  const others = load.people.filter((p) => !p.me);
  const name = (p: api.BetaPerson) => (p.handle ? `@${p.handle}` : t('admin.device', { id: p.owner.slice(0, 4) }));
  return (
    <SafeAreaView style={styles.fill} edges={['bottom']}>
      <ScrollView contentContainerStyle={styles.content}>
        {error ? <Text style={styles.error}>{error}</Text> : null}
        {mine ? (
          <SettingsSection title={t('admin.row')} footnote={t('admin.meFoot')}>
            <SettingsRow label={t('admin.me')} last switchValue={mineOn} onSwitchChange={(v) => toggle(mine.owner, v, true)} />
          </SettingsSection>
        ) : null}
        <SettingsSection title={t('admin.people')} footnote={t('admin.peopleFoot')}>
          {others.length === 0 ? <SettingsRow label={t('admin.empty')} last /> : null}
          {others.map((p, i) => (
            <SettingsRow key={p.owner} label={name(p)} last={i === others.length - 1} switchValue={p.enabled} onSwitchChange={(v) => toggle(p.owner, v, false)} />
          ))}
        </SettingsSection>
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1, backgroundColor: tide.sky[0] },
  content: { padding: Spacing.lg, gap: Spacing.lg },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  note: { color: tide.textDim, fontSize: 16, textAlign: 'center', padding: Spacing.xl },
  error: { color: tide.record, fontSize: 15, textAlign: 'center' },
  back: { alignItems: 'center' },
});
