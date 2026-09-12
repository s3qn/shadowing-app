import {
  RecordingPresets,
  requestRecordingPermissionsAsync,
  setAudioModeAsync,
  useAudioRecorder,
  useAudioRecorderState,
} from 'expo-audio';
import { useRouter } from 'expo-router';
import { useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { LevelBars } from '@/components/level-bars';

import { Radius, Spacing } from '@/constants/theme';
import { useTheme } from '@/hooks/use-theme';
import * as api from '@/lib/api';
import { DEFAULT_VOICE, getVoice } from '@/lib/settings';

const MIN_SECONDS = 10;
const MAX_SECONDS = 90;
// Metering is dBFS. Measured on Sean's iPhone: silence -160, speech -42 to -7
// with a median near -19. Everything under the gate is drawn as silence so room
// noise cannot move the bars; from the gate to the ceiling the height is linear.
const GATE_DB = -45;
const CEILING_DB = -10;

type Phase = 'idle' | 'recording' | 'review' | 'building';

const STAGE_LABEL: Record<string, string> = {
  queued: 'Queued…',
  transcribing: 'Transcribing…',
  writing: 'Writing Japanese…',
  speaking: 'Recording the voice…',
};

/** dBFS to 0..1: flat below the gate, full height at the ceiling. */
function normalise(db: number | undefined): number {
  if (db === undefined || !Number.isFinite(db) || db < GATE_DB) return 0;
  return Math.min(1, (db - GATE_DB) / (CEILING_DB - GATE_DB));
}

function clock(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
}

export default function RecordScreen() {
  const { palette } = useTheme();
  const router = useRouter();
  const recorder = useAudioRecorder({ ...RecordingPresets.HIGH_QUALITY, isMeteringEnabled: true });
  const state = useAudioRecorderState(recorder, 50);

  const [phase, setPhase] = useState<Phase>('idle');
  const [complexity, setComplexity] = useState<api.Complexity>('simple');
  const [uri, setUri] = useState<string | null>(null);
  const [stage, setStage] = useState('queued');
  const [error, setError] = useState('');
  // The recorder's clock resets once it stops, so the length of the last take
  // is kept separately for the review screen.
  const [taken, setTaken] = useState(0);
  const [voice, setVoice] = useState<number>(DEFAULT_VOICE);

  useEffect(() => {
    getVoice().then(setVoice);
  }, []);
  const elapsed = phase === 'review' ? taken : (state.durationMillis ?? 0) / 1000;
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => () => {
    if (pollRef.current) clearInterval(pollRef.current);
  }, []);

  // Stop on our own once the cap is hit, so an island never runs long enough to
  // make transcription slow.
  useEffect(() => {
    if (phase === 'recording' && elapsed >= MAX_SECONDS) void stop();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase, elapsed]);

  async function start() {
    setError('');
    const perm = await requestRecordingPermissionsAsync();
    if (!perm.granted) {
      setError('Microphone access is off. Turn it on in Settings and try again.');
      return;
    }
    await setAudioModeAsync({ playsInSilentMode: true, allowsRecording: true });
    await recorder.prepareToRecordAsync();
    recorder.record();
    setPhase('recording');
  }

  async function stop() {
    setTaken((state.durationMillis ?? 0) / 1000);
    await recorder.stop();
    setUri(recorder.uri);
    setPhase('review');
  }

  async function build() {
    if (!uri) return;
    setPhase('building');
    setError('');
    try {
      const { id } = await api.createIsland(uri, complexity, voice);
      pollRef.current = setInterval(async () => {
        try {
          const island = await api.getIsland(id);
          setStage(island.stage || island.status);
          if (island.status === 'ready') {
            if (pollRef.current) clearInterval(pollRef.current);
            router.replace({ pathname: '/island/[id]', params: { id } });
          } else if (island.status === 'failed') {
            if (pollRef.current) clearInterval(pollRef.current);
            setError(island.error || 'That island could not be built.');
            setPhase('review');
          }
        } catch {
          // A dropped poll is not fatal, the next tick retries.
        }
      }, 2000);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Upload failed');
      setPhase('review');
    }
  }

  const longEnough = elapsed >= MIN_SECONDS;

  return (
    <SafeAreaView edges={['bottom']} style={StyleSheet.flatten([styles.fill, { backgroundColor: palette.bg }])}>
      <View style={styles.body}>
        {phase === 'building' ? (
          <View style={styles.center}>
            <ActivityIndicator size="large" color={palette.accent} />
            <Text style={[styles.stage, { color: palette.ink }]}>
              {STAGE_LABEL[stage] ?? 'Working…'}
            </Text>
            <Text style={[styles.hint, { color: palette.muted }]}>
              This takes about a minute. You can leave this screen, the island keeps building.
            </Text>
          </View>
        ) : (
          <>
            <Text style={[styles.prompt, { color: palette.ink }]}>
              {phase === 'recording'
                ? 'Keep talking about your day.'
                : 'Talk about your day for 30 seconds or so.'}
            </Text>
            <Text style={[styles.hint, { color: palette.muted }]}>
              Speak Hebrew or English, whichever comes naturally. What you say becomes
              Japanese sentences about your own life, so use real names and real places.
            </Text>

            <Text style={[styles.timer, { color: phase === 'recording' ? palette.accent : palette.muted }]}>
              {clock(elapsed)}
            </Text>

            <LevelBars
              level={phase === 'recording' ? normalise(state.metering) : 0}
              live={phase === 'recording'}
            />

            <View style={[styles.track, { backgroundColor: palette.surfaceAlt }]}>
              <View
                style={[
                  styles.trackFill,
                  {
                    backgroundColor: palette.accent,
                    width: `${Math.min(100, Math.round((elapsed / MAX_SECONDS) * 100))}%`,
                  },
                ]}
              />
            </View>

            {phase === 'review' ? (
              <View style={styles.pickerRow}>
                {(['simple', 'complex'] as const).map((level) => {
                  const on = complexity === level;
                  return (
                    <Pressable
                      key={level}
                      onPress={() => setComplexity(level)}
                      style={[
                        styles.pick,
                        {
                          backgroundColor: on ? palette.accent : palette.surface,
                          borderColor: on ? palette.accent : palette.line,
                        },
                      ]}>
                      <Text
                        style={[
                          styles.pickTitle,
                          { color: on ? palette.accentInk : palette.ink },
                        ]}>
                        {level === 'simple' ? 'One sentence at a time' : 'Complex patterns'}
                      </Text>
                      <Text
                        style={[
                          styles.pickBody,
                          { color: on ? palette.accentInk : palette.muted },
                        ]}>
                        {level === 'simple'
                          ? 'Short standalone lines, one idea each.'
                          : 'Subordinate clauses and connected speech.'}
                      </Text>
                    </Pressable>
                  );
                })}
              </View>
            ) : null}

            {error ? <Text style={[styles.error, { color: palette.danger }]}>{error}</Text> : null}
          </>
        )}
      </View>

      {phase !== 'building' ? (
        <View style={styles.actions}>
          {phase === 'idle' ? (
            <Pressable onPress={start} style={[styles.primary, { backgroundColor: palette.accent }]}>
              <Text style={[styles.primaryText, { color: palette.accentInk }]}>Start recording</Text>
            </Pressable>
          ) : null}

          {phase === 'recording' ? (
            <Pressable
              onPress={stop}
              disabled={!longEnough}
              style={[
                styles.primary,
                { backgroundColor: longEnough ? palette.danger : palette.surfaceAlt },
              ]}>
              <Text
                style={[
                  styles.primaryText,
                  { color: longEnough ? '#FFFFFF' : palette.muted },
                ]}>
                {longEnough ? 'Stop' : `Keep going, ${MIN_SECONDS - Math.floor(elapsed)}s more`}
              </Text>
            </Pressable>
          ) : null}

          {phase === 'review' ? (
            <>
              <Pressable onPress={build} style={[styles.primary, { backgroundColor: palette.accent }]}>
                <Text style={[styles.primaryText, { color: palette.accentInk }]}>
                  Build the island
                </Text>
              </Pressable>
              <Pressable onPress={start} style={styles.secondary}>
                <Text style={[styles.secondaryText, { color: palette.muted }]}>
                  Record again
                </Text>
              </Pressable>
            </>
          ) : null}
        </View>
      ) : null}
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1 },
  body: { flex: 1, padding: Spacing.xl, gap: Spacing.md },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: Spacing.lg },
  prompt: { fontSize: 24, fontWeight: '700', lineHeight: 31 },
  hint: { fontSize: 14, lineHeight: 21, textAlign: 'center' },
  stage: { fontSize: 18, fontWeight: '600' },
  timer: { fontSize: 56, fontWeight: '200', fontVariant: ['tabular-nums'], marginTop: Spacing.lg },
  track: { height: 4, borderRadius: 2, overflow: 'hidden' },
  trackFill: { height: 4, borderRadius: 2 },
  pickerRow: { gap: Spacing.md, marginTop: Spacing.sm },
  pick: { borderWidth: 1, borderRadius: Radius.md, padding: Spacing.lg, gap: Spacing.xs },
  pickTitle: { fontSize: 16, fontWeight: '600' },
  pickBody: { fontSize: 13, lineHeight: 19 },
  error: { fontSize: 14, lineHeight: 21, marginTop: Spacing.sm },
  actions: { padding: Spacing.xl, gap: Spacing.sm },
  primary: { paddingVertical: Spacing.lg, borderRadius: Radius.pill, alignItems: 'center' },
  primaryText: { fontSize: 17, fontWeight: '700' },
  secondary: { paddingVertical: Spacing.md, alignItems: 'center' },
  secondaryText: { fontSize: 15, fontWeight: '600' },
});
