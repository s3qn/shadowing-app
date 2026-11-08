import { useCallback, useEffect, useState } from 'react';
import { ScrollView, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { PrimaryAction } from '@/components/prism/actions';
import { PrismButton } from '@/components/prism/prism-button';
import { LoadingBlock } from '@/components/state-blocks';
import { GlassInput } from '@/components/tide/glass-input';
import { SettingsRow, SettingsSection } from '@/components/tide/settings-row';
import { Spacing, tide } from '@/constants/theme';
import { adminKeyId, loadAdminKey } from '@/lib/admin-device';
import * as api from '@/lib/api';
import { type AdminDeviceSim, betaDenied, betaDeviceSim, betaSimulated, refreshBeta, setBetaOverride, useBetaFeatures } from '@/lib/beta';
import { useT } from '@/lib/i18n';
import { useExitScreen } from '@/lib/use-exit-screen';
import type { Key } from '@/locales/en';

type Load =
  | { kind: 'loading' }
  | { kind: 'denied' }
  | { kind: 'failed' }
  // admin-device-bound: the account is listed but this phone's key is not approved (or cannot exist).
  | { kind: 'device'; status: AdminDeviceSim; keyId: string }
  // `approved`: the server checked this phone's proof on the list call.
  | { kind: 'ready'; people: api.BetaPerson[]; approved: boolean };

const DEVICE_NOTE = {
  pending: 'admin.devicePending',
  revoked: 'admin.deviceRevoked',
  rejected: 'admin.deviceRejected',
  unsupported: 'admin.deviceUnsupported',
} as const satisfies Record<AdminDeviceSim, Key>;

/** admin-device-bound: the server refused the list with `admin_device`, so the
 * account is listed and this phone must enrol its key and show where it stands. */
async function deviceState(): Promise<Load> {
  if ((await loadAdminKey()) === 'unsupported') return { kind: 'device', status: 'unsupported', keyId: '' };
  try {
    const status = await api.adminEnrolDevice();
    // Approved on the server yet refused on the list: the proof itself failed, usually the phone's clock.
    return { kind: 'device', status: status === 'approved' ? 'rejected' : status, keyId: adminKeyId() };
  } catch {
    // 409 (the key belongs to another account) or any other error.
    return { kind: 'failed' };
  }
}

/** The list call and where it leaves the screen: ready, denied, failed, or
 * this phone's device state when the server wants an approved key. */
async function fetchLoad(): Promise<Load> {
  try {
    const list = await api.adminListBeta();
    return { kind: 'ready', people: list.people, approved: list.device === 'approved' };
  } catch (e: unknown) {
    const refusal = e as { status?: number; code?: string };
    if (refusal.status !== 403) return { kind: 'failed' };
    if (refusal.code === 'admin_device') return deviceState();
    return { kind: 'denied' };
  }
}

const APPROVE_ERROR = { wrong: 'admin.passcodeWrong', later: 'admin.passcodeLater', failed: 'admin.approveFailed' } as const satisfies Record<
  Exclude<api.AdminApproveResult, 'approved'>,
  Key
>;

/** launch-basics: the admin picks who sees YouTube, Podcast and Import. People come from the list, nobody types an id. */
export default function AdminScreen() {
  const { t } = useT();
  const features = useBetaFeatures();
  const exit = useExitScreen('/(tabs)');
  const [load, setLoad] = useState<Load>(() => {
    if (betaDenied()) return { kind: 'denied' };
    const sim = betaDeviceSim();
    if (sim) return { kind: 'device', status: sim, keyId: adminKeyId() };
    return { kind: 'loading' };
  });
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (betaDenied()) return;
    let alive = true;
    const sim = betaDeviceSim();
    if (sim) {
      // The simulated state shows the real key id once the keychain answers; no request.
      void loadAdminKey().then(() => alive && setLoad({ kind: 'device', status: sim, keyId: adminKeyId() }));
    } else {
      void fetchLoad().then((next) => alive && setLoad(next));
    }
    return () => {
      alive = false;
    };
  }, []);

  // Until launch: the pending phone approves itself with the server's passcode.
  const [code, setCode] = useState('');
  const [codeError, setCodeError] = useState<string | null>(null);
  const [approving, setApproving] = useState(false);
  const approve = useCallback(() => {
    const passcode = code.trim();
    if (approving || !passcode) return;
    setApproving(true);
    setCodeError(null);
    void (async () => {
      const result = await api.adminApproveDevice(passcode);
      if (result === 'approved') {
        setCode('');
        // The list call now carries the approved proof and lands on the approved screen.
        setLoad(await fetchLoad());
      } else {
        setCodeError(t(APPROVE_ERROR[result]));
      }
      setApproving(false);
    })();
  }, [approving, code, t]);

  const toggle = useCallback(
    (owner: string, enabled: boolean, me: boolean) => {
      setError(null);
      // beta-gate: my own real flip beats a simulated one from the review tour (a no-op outside __DEV__).
      if (me) setBetaOverride({});
      setLoad((l) => (l.kind === 'ready' ? { ...l, people: l.people.map((p) => (p.owner === owner ? { ...p, enabled } : p)) } : l));
      api
        .adminSetBeta(owner, enabled)
        .then(() => {
          if (!me) return;
          return refreshBeta();
        })
        .catch(() => {
          setError(t('admin.saveFailed'));
          setLoad((l) => (l.kind === 'ready' ? { ...l, people: l.people.map((p) => (p.owner === owner ? { ...p, enabled: !enabled } : p)) } : l));
        });
    },
    [t],
  );

  if (load.kind === 'loading') {
    return (
      <SafeAreaView style={styles.fill} edges={['bottom']}>
        <LoadingBlock />
      </SafeAreaView>
    );
  }
  if (load.kind === 'denied' || load.kind === 'failed' || load.kind === 'device') {
    const note = load.kind === 'denied' ? t('admin.denied') : load.kind === 'failed' ? t('admin.failed') : t(DEVICE_NOTE[load.status]);
    return (
      <SafeAreaView style={styles.fill} edges={['bottom']}>
        <Text style={styles.note}>{note}</Text>
        {load.kind === 'device' && load.keyId ? <Text style={styles.key}>{t('admin.deviceKey', { id: load.keyId.slice(0, 8) })}</Text> : null}
        {load.kind === 'device' && load.status === 'pending' && load.keyId ? (
          <View style={styles.approve}>
            <GlassInput
              value={code}
              onChangeText={setCode}
              placeholder={t('admin.passcode')}
              accessibilityLabel={t('admin.passcode')}
              secureTextEntry
              keyboardType="number-pad"
              maxLength={12}
              onSubmitEditing={approve}
              style={[styles.code, code ? styles.codeDigits : null]}
            />
            {codeError ? <Text style={styles.error}>{codeError}</Text> : null}
            <PrimaryAction label={t('admin.approve')} disabled={approving || !code.trim()} onPress={approve} />
          </View>
        ) : null}
        <View style={styles.back}>
          <PrismButton shape="pill" verb="listen" on label={t('admin.back')} onPress={exit} />
        </View>
      </SafeAreaView>
    );
  }

  const mine = load.people.find((p) => p.me);
  // Under a dev simulate key the own switch shows what the app runs on, not the stored flag.
  const mineOn = mine ? (betaSimulated() ? features.beta : mine.enabled) : false;
  const others = load.people.filter((p) => !p.me);
  const name = (p: api.BetaPerson) => (p.handle ? `@${p.handle}` : t('admin.device', { id: p.owner.slice(0, 4) }));
  // admin-device-bound: the row shows only when the server says it checked this phone's proof
  // (a dev device principal needs none and gets no row).
  const keyId = load.approved ? adminKeyId() : '';
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
        {keyId ? (
          <SettingsSection title={t('admin.deviceTitle')} footnote={t('admin.deviceKey', { id: keyId.slice(0, 8) })}>
            <SettingsRow label={t('admin.deviceApproved')} last />
          </SettingsSection>
        ) : null}
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1, backgroundColor: tide.sky[0] },
  content: { padding: Spacing.lg, gap: Spacing.lg },
  note: { color: tide.textDim, fontSize: 16, textAlign: 'center', padding: Spacing.xl },
  key: { color: tide.text, fontSize: 18, textAlign: 'center', letterSpacing: 1, marginBottom: Spacing.xl },
  error: { color: tide.record, fontSize: 15, textAlign: 'center' },
  back: { alignItems: 'center' },
  approve: { alignItems: 'center', gap: Spacing.md, marginBottom: Spacing.xl },
  code: { width: 200, textAlign: 'center' },
  codeDigits: { letterSpacing: 4 },
});
