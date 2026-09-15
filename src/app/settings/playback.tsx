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
import {
  getSettings,
  PAUSE_STEP_MS,
  setAutoEcho,
  setAutoRecord,
  setDefaultPauseMs,
  setDefaultSpeed,
  setDefaultTimes,
  setKeepAwake,
  setPlayLineWhileSpeaking,
  TIMES_MIN,
} from '@/lib/settings';

const SPEED_OPTIONS = [0.5, 0.7, 0.85, 1, 1.15, 1.3, 1.5];

export default function PlaybackSettingsScreen() {
  const [defaultSpeed, setDefaultSpeedState] = useState(1);
  const [defaultTimes, setDefaultTimesState] = useState(1);
  const [defaultPauseMs, setDefaultPauseMsState] = useState(0);
  // The rulers span the card's inner width, measured once it lays out.
  const [rulerW, setRulerW] = useState(0);
  const [autoEcho, setAutoEchoState] = useState(true);
  const [autoRecord, setAutoRecordState] = useState(true);
  const [playLineWhileSpeaking, setPlayLineWhileSpeakingState] = useState(false);
  const [keepAwake, setKeepAwakeState] = useState(true);

  useFocusEffect(
    useCallback(() => {
      let alive = true;
      void getSettings().then((s) => {
        if (!alive) return;
        setDefaultSpeedState(s.defaultSpeed);
        setDefaultTimesState(s.defaultTimes);
        setDefaultPauseMsState(s.defaultPauseMs);
        setAutoEchoState(s.autoEcho);
        setAutoRecordState(s.autoRecord);
        setPlayLineWhileSpeakingState(s.playLineWhileSpeaking);
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
        <SettingsSection title="Speed" footnote="Default for new sessions. Change it per session from the player.">
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
          title="Times"
          footnote="How many times each line plays before the next. Default for new sessions; change it per session from the player's Repeat tile.">
          <View style={styles.rulerBox} onLayout={(e) => setRulerW(e.nativeEvent.layout.width - 2 * Spacing.md)}>
            <Text style={styles.readout}>{timesLabel(defaultTimes)}</Text>
            {rulerW > 0 ? (
              <TickRuler
                width={rulerW}
                steps={TIMES_STEPS}
                index={defaultTimes - TIMES_MIN}
                onIndexChange={(i) => setDefaultTimesState(i + TIMES_MIN)}
                onSettle={(i) => void setDefaultTimes(i + TIMES_MIN)}
                isMajor={() => true}
                tickLabel={(i) => String(i + TIMES_MIN)}
                accessibilityLabel={`Times, ${timesLabel(defaultTimes)}`}
              />
            ) : null}
          </View>
        </SettingsSection>

        <SettingsSection
          title="Pause"
          footnote="Silence after every play, which is also Auto Echo's Echo step. Default for new sessions; change it per session from the player's Repeat tile.">
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
                accessibilityLabel={`Pause, ${pauseLabel(defaultPauseMs)}`}
              />
            ) : null}
          </View>
        </SettingsSection>

        <SettingsSection title="Auto Echo">
          <SettingsRow
            label="Auto Echo"
            switchValue={autoEcho}
            onSwitchChange={(next) => {
              setAutoEchoState(next);
              void setAutoEcho(next);
            }}
          />
          <SettingsRow
            label="Auto record"
            switchValue={autoRecord}
            onSwitchChange={(next) => {
              setAutoRecordState(next);
              void setAutoRecord(next);
            }}
          />
          <SettingsRow
            label="Play line while speaking"
            last
            switchValue={playLineWhileSpeaking}
            onSwitchChange={(next) => {
              setPlayLineWhileSpeakingState(next);
              void setPlayLineWhileSpeaking(next);
            }}
          />
        </SettingsSection>
        <Text style={[styles.footnote, { color: tide.textDim }]}>
          Auto record applies on every Echo pass. Auto Echo only decides whether the next pass starts on its own.
        </Text>

        <SettingsSection title="Screen">
          <SettingsRow
            label="Keep screen awake"
            last
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
