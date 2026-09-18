import { useFocusEffect } from 'expo-router';
import { useCallback, useState } from 'react';
import { ScrollView, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { PressScale } from '@/components/press-scale';
import { SettingsRow, SettingsSection } from '@/components/tide/settings-row';
import { PAUSE_STEPS, pauseLabel, TIMES_STEPS, timesLabel } from '@/components/tide/repeat-popover';
import { TickRuler } from '@/components/tide/tick-ruler';
import { fonts } from '@/constants/fonts';
import { Radius, SPEED_MAX, SPEED_MIN, Spacing, tide } from '@/constants/theme';
import { useDir, useT } from '@/lib/i18n';
import type { Programme } from '@/lib/pass-programme';
import {
  getSettings,
  getSettingsSync,
  PAUSE_STEP_MS,
  setAutoEcho,
  setAutoRecord,
  setDefaultPauseMs,
  setDefaultSpeed,
  setDefaultTimes,
  setKeepAwake,
  setProgramme,
  TIMES_MIN,
} from '@/lib/settings';

const PROGRAMME_OPTIONS: readonly Programme[] = ['ladder', 'echo'];

const SPEED_OPTIONS = [0.5, 0.7, 0.85, 1, 1.15, 1.3, 1.5];

export default function PlaybackSettingsScreen() {
  const { t } = useT();
  const dir = useDir();
  // Seeded from the sync cache so the chip that is already chosen is the one
  // lit on the first frame, before the file read below answers.
  const [defaultSpeed, setDefaultSpeedState] = useState(() => getSettingsSync().defaultSpeed);
  const [programme, setProgrammeState] = useState<Programme>(() => getSettingsSync().programme);
  const [defaultTimes, setDefaultTimesState] = useState(1);
  const [defaultPauseMs, setDefaultPauseMsState] = useState(0);
  // The rulers span the card's inner width, measured once it lays out.
  const [rulerW, setRulerW] = useState(0);
  const [autoEcho, setAutoEchoState] = useState(true);
  const [autoRecord, setAutoRecordState] = useState(true);
  const [keepAwake, setKeepAwakeState] = useState(true);

  useFocusEffect(
    useCallback(() => {
      let alive = true;
      void getSettings().then((s) => {
        if (!alive) return;
        setDefaultSpeedState(s.defaultSpeed);
        setProgrammeState(s.programme);
        setDefaultTimesState(s.defaultTimes);
        setDefaultPauseMsState(s.defaultPauseMs);
        setAutoEchoState(s.autoEcho);
        setAutoRecordState(s.autoRecord);
        setKeepAwakeState(s.keepAwake);
      });
      return () => {
        alive = false;
      };
    }, []),
  );

  function chip(active: boolean) {
    return [
      styles.chip,
      {
        backgroundColor: active ? tide.lang.ja : 'rgba(255,255,255,0.08)',
        borderColor: active ? tide.lang.ja : 'rgba(255,255,255,0.14)',
      },
    ];
  }

  return (
    <SafeAreaView edges={['bottom']} style={StyleSheet.flatten([styles.fill, { backgroundColor: tide.sky[0] }])}>
      <ScrollView contentContainerStyle={styles.list}>
        <SettingsSection title={t('settings.playback.speed')} footnote={t('settings.playback.defaultFootnote')}>
          <View style={styles.chipRow}>
            {SPEED_OPTIONS.filter((s) => s >= SPEED_MIN && s <= SPEED_MAX).map((s) => {
              const on = s === defaultSpeed;
              return (
                <PressScale
                  key={s}
                  onPress={() => {
                    setDefaultSpeedState(s);
                    void setDefaultSpeed(s);
                  }}
                  style={chip(on)}>
                  <Text style={[styles.chipText, { color: on ? tide.sky[0] : tide.text }]}>{s}x</Text>
                </PressScale>
              );
            })}
          </View>
        </SettingsSection>

        <SettingsSection
          title={t('player.programme')}
          footnote={`${t('player.ladder')}: ${t('settings.onboarding.ladderLine')}\n${t('player.autoEcho')}: ${t('player.echoDescription')}`}>
          <View style={[styles.chipRow, dir.row]}>
            {PROGRAMME_OPTIONS.map((p) => {
              const on = p === programme;
              return (
                <PressScale
                  key={p}
                  onPress={() => {
                    setProgrammeState(p);
                    void setProgramme(p);
                  }}
                  style={chip(on)}>
                  <Text style={[styles.chipText, { color: on ? tide.sky[0] : tide.text }]}>
                    {t(p === 'ladder' ? 'player.ladder' : 'player.autoEcho')}
                  </Text>
                </PressScale>
              );
            })}
          </View>
        </SettingsSection>

        <SettingsSection title={t('settings.playback.times')} footnote={t('settings.playback.timesFootnote')}>
          <View style={styles.rulerBox} onLayout={(e) => setRulerW(e.nativeEvent.layout.width - 2 * Spacing.md)}>
            <Text style={styles.readout}>{timesLabel(t, defaultTimes)}</Text>
            {rulerW > 0 ? (
              <TickRuler
                width={rulerW}
                steps={TIMES_STEPS}
                index={defaultTimes - TIMES_MIN}
                onIndexChange={(i) => setDefaultTimesState(i + TIMES_MIN)}
                onSettle={(i) => void setDefaultTimes(i + TIMES_MIN)}
                isMajor={() => true}
                tickLabel={(i) => String(i + TIMES_MIN)}
                accessibilityLabel={t('settings.playback.timesAccessibility', { label: timesLabel(t, defaultTimes) })}
              />
            ) : null}
          </View>
        </SettingsSection>

        <SettingsSection title={t('settings.playback.pause')} footnote={t('settings.playback.pauseFootnote')}>
          <View style={styles.rulerBox}>
            <Text style={styles.readout}>{pauseLabel(defaultPauseMs)}</Text>
            {rulerW > 0 ? (
              <TickRuler
                width={rulerW}
                steps={PAUSE_STEPS}
                index={defaultPauseMs / PAUSE_STEP_MS}
                onIndexChange={(i) => setDefaultPauseMsState(i * PAUSE_STEP_MS)}
                onSettle={(i) => void setDefaultPauseMs(i * PAUSE_STEP_MS)}
                isMajor={(i) => (i * PAUSE_STEP_MS) % 1000 === 0}
                tickLabel={(i) => String((i * PAUSE_STEP_MS) / 1000)}
                accessibilityLabel={t('settings.playback.pauseAccessibility', { label: pauseLabel(defaultPauseMs) })}
              />
            ) : null}
          </View>
        </SettingsSection>

        <SettingsSection title={t('settings.playback.autoEcho')}>
          <SettingsRow
            label={t('settings.playback.autoEcho')}
            icon={{ ios: 'arrow.triangle.2.circlepath', android: 'repeat' }}
            switchValue={autoEcho}
            onSwitchChange={(next) => {
              setAutoEchoState(next);
              void setAutoEcho(next);
            }}
          />
          <SettingsRow
            label={t('settings.playback.autoRecord')}
            last
            icon={{ ios: 'record.circle', android: 'fiber_manual_record' }}
            switchValue={autoRecord}
            onSwitchChange={(next) => {
              setAutoRecordState(next);
              void setAutoRecord(next);
            }}
          />
        </SettingsSection>
        <Text style={[styles.footnote, { color: tide.textDim }, dir.text]}>{t('settings.playback.autoRecordFootnote')}</Text>

        <SettingsSection title={t('settings.playback.screen')}>
          <SettingsRow
            label={t('settings.playback.keepScreenAwake')}
            last
            icon={{ ios: 'sun.max', android: 'light_mode' }}
            switchValue={keepAwake}
            onSwitchChange={(next) => {
              setKeepAwakeState(next);
              void setKeepAwake(next);
            }}
          />
        </SettingsSection>
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1 },
  list: { padding: Spacing.lg, gap: Spacing.lg, paddingBottom: 170 },
  chipRow: { flexDirection: 'row', flexWrap: 'wrap', gap: Spacing.sm, padding: Spacing.md },
  chip: { borderWidth: 1, borderRadius: Radius.pill, paddingVertical: Spacing.xs + 2, paddingHorizontal: Spacing.md },
  rulerBox: { padding: Spacing.md, alignItems: 'center', gap: Spacing.xs },
  readout: { fontFamily: fonts.uiMedium, fontWeight: '500', fontSize: 20, color: tide.text, fontVariant: ['tabular-nums'] },
  chipText: { fontSize: 13, fontWeight: '600', fontFamily: fonts.ui },
  footnote: { fontSize: 12, lineHeight: 17, marginHorizontal: Spacing.sm, marginTop: -Spacing.md },
});
