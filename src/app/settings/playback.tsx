import { useFocusEffect } from 'expo-router';
import { useCallback, useState } from 'react';
import { ScrollView, StyleSheet } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { SettingsRow, SettingsRulerRow, SettingsSection, SettingsSegmentRow } from '@/components/tide/settings-row';
import { PAUSE_STEPS, pauseLabel, TIMES_STEPS, timesLabel } from '@/components/tide/repeat-popover';
import { SPEED_MAX, SPEED_MIN, Spacing, tide } from '@/constants/theme';
import { formatSpeed } from '@/lib/format';
import { useT } from '@/lib/i18n';
import { LADDER_PACE_OPTIONS, type LadderPace } from '@/lib/pass-programme';
import {
  getSettings,
  getSettingsSync,
  PAUSE_STEP_MS,
  setAutoEcho,
  setAutoRecord,
  setBlindTake,
  setDefaultPauseMs,
  setDefaultSpeed,
  setDefaultTimes,
  setKeepAwake,
  setLadderPace,
  TIMES_MIN,
} from '@/lib/settings';

const SPEED_OPTIONS = [0.5, 0.7, 0.85, 1, 1.15, 1.3, 1.5];

export default function PlaybackSettingsScreen() {
  const { t } = useT();
  const speedChoices = SPEED_OPTIONS.filter((x) => x >= SPEED_MIN && x <= SPEED_MAX).map((x) => ({ value: String(x), label: formatSpeed(x) }));
  const paceChoices = LADDER_PACE_OPTIONS.map((p) => ({
    value: p,
    label: t(p === 'calm' ? 'settings.playback.paceCalm' : p === 'steady' ? 'settings.playback.paceSteady' : 'settings.playback.paceQuick'),
  }));
  // Seeded from the sync cache so the chip that is already chosen is the one
  // lit on the first frame, before the file read below answers.
  const [defaultSpeed, setDefaultSpeedState] = useState(() => getSettingsSync().defaultSpeed);
  const [ladderPace, setLadderPaceState] = useState<LadderPace>(() => getSettingsSync().ladderPace);
  const [blindTake, setBlindTakeState] = useState(() => getSettingsSync().blindTake);
  const [defaultTimes, setDefaultTimesState] = useState(1);
  const [defaultPauseMs, setDefaultPauseMsState] = useState(0);
  const [autoEcho, setAutoEchoState] = useState(true);
  const [autoRecord, setAutoRecordState] = useState(true);
  const [keepAwake, setKeepAwakeState] = useState(true);

  useFocusEffect(
    useCallback(() => {
      let alive = true;
      void getSettings().then((s) => {
        if (!alive) return;
        setDefaultSpeedState(s.defaultSpeed);
        setLadderPaceState(s.ladderPace);
        setBlindTakeState(s.blindTake);
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

  return (
    <SafeAreaView edges={['bottom']} style={StyleSheet.flatten([styles.fill, { backgroundColor: tide.sky[0] }])}>
      <ScrollView contentContainerStyle={styles.list}>
        <SettingsSegmentRow
          title={t('settings.playback.speed')}
          footnote={t('settings.playback.defaultFootnote')}
          scrollable
          ltr
          options={speedChoices}
          value={String(defaultSpeed)}
          onChange={(v) => {
            const next = Number(v);
            setDefaultSpeedState(next);
            void setDefaultSpeed(next);
          }}
        />

        <SettingsSegmentRow
          title={t('settings.playback.pace')}
          footnote={t('settings.playback.paceFootnote')}
          options={paceChoices}
          value={ladderPace}
          onChange={(p) => {
            setLadderPaceState(p);
            void setLadderPace(p);
          }}
        />

        <SettingsSection title={t('settings.playback.blindTake')} footnote={t('settings.playback.blindTakeFootnote')}>
          <SettingsRow
            label={t('settings.playback.blindTake')}
            last
            icon={{ ios: 'eye.slash', android: 'visibility_off' }}
            switchValue={blindTake}
            onSwitchChange={(next) => {
              setBlindTakeState(next);
              void setBlindTake(next);
            }}
          />
        </SettingsSection>

        <SettingsRulerRow
          title={t('settings.playback.times')}
          footnote={t('settings.playback.timesFootnote')}
          readout={timesLabel(t, defaultTimes)}
          steps={TIMES_STEPS}
          index={defaultTimes - TIMES_MIN}
          onIndexChange={(i) => setDefaultTimesState(i + TIMES_MIN)}
          onSettle={(i) => void setDefaultTimes(i + TIMES_MIN)}
          isMajor={() => true}
          tickLabel={(i) => String(i + TIMES_MIN)}
          accessibilityLabel={t('settings.playback.timesAccessibility', { label: timesLabel(t, defaultTimes) })}
        />

        <SettingsRulerRow
          title={t('settings.playback.pause')}
          footnote={t('settings.playback.pauseFootnote')}
          readout={pauseLabel(defaultPauseMs)}
          steps={PAUSE_STEPS}
          index={defaultPauseMs / PAUSE_STEP_MS}
          onIndexChange={(i) => setDefaultPauseMsState(i * PAUSE_STEP_MS)}
          onSettle={(i) => void setDefaultPauseMs(i * PAUSE_STEP_MS)}
          isMajor={(i) => (i * PAUSE_STEP_MS) % 1000 === 0}
          tickLabel={(i) => String((i * PAUSE_STEP_MS) / 1000)}
          accessibilityLabel={t('settings.playback.pauseAccessibility', { label: pauseLabel(defaultPauseMs) })}
        />

        <SettingsSection title={t('settings.playback.autoEcho')} footnote={t('settings.playback.autoRecordFootnote')}>
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
});
