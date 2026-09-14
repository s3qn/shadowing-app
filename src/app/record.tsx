import {
  RecordingPresets,
  requestRecordingPermissionsAsync,
  useAudioRecorder,
  useAudioRecorderState,
} from 'expo-audio';
import { Stack, useRouter } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { useEffect, useRef, useState } from 'react';
import { ActivityIndicator, AppState, Pressable, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { LevelBars, meterLevel } from '@/components/level-bars';
import { PressScale } from '@/components/press-scale';

import { fonts } from '@/constants/fonts';
import { Radius, Spacing, tide } from '@/constants/theme';
import * as api from '@/lib/api';
import { applyPlaybackMode, applyRecordingMode, releaseAudioSession } from '@/lib/audio-mode';
import { DEFAULT_VOICE, getVoice } from '@/lib/settings';

const MIN_SECONDS = 10;
const MAX_SECONDS = 90;

type Phase = 'idle' | 'recording' | 'review' | 'building';

const STAGE_LABEL: Record<string, string> = {
  queued: 'Queued…',
  transcribing: 'Transcribing…',
  writing: 'Writing Japanese…',
  speaking: 'Recording the voice…',
};

function clock(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
}

export default function RecordScreen() {
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

  // Leave without building anything. A take in progress is stopped and
  // dropped; an island already building keeps building on the server and
  // shows up in the list when it is done.
  async function cancel() {
    if (pollRef.current) clearInterval(pollRef.current);
    if (phase === 'recording') {
      try {
        await recorder.stop();
      } catch {
        // Nothing to keep either way.
      }
      // Separate from the stop: a recorder that failed to stop must not leave
      // the app in recording mode.
      try {
        await applyPlaybackMode();
        await releaseAudioSession();
      } catch {
        // Best effort: the next recording attempt fixes the mode.
      }
    }
    router.back();
  }
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

  // The microphone never runs in the background: a recording caught by the
  // app going to the background either becomes the take (if it is already
  // long enough) or is dropped back to idle with a message.
  useEffect(() => {
    const sub = AppState.addEventListener('change', (next) => {
      if (next !== 'background' || phase !== 'recording') return;
      if (elapsed >= MIN_SECONDS) {
        void stop();
        return;
      }
      void (async () => {
        try {
          await recorder.stop();
        } catch {
          // Nothing to keep either way.
        }
        try {
          await applyPlaybackMode();
          await releaseAudioSession();
        } catch {
          // Best effort: the next recording attempt fixes the mode.
        }
        setPhase('idle');
        setError('Recording stopped when the app went to the background.');
      })();
    });
    return () => sub.remove();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase, elapsed]);

  async function start() {
    setError('');
    const perm = await requestRecordingPermissionsAsync();
    if (!perm.granted) {
      setError('Microphone access is off. Turn it on in Settings and try again.');
      return;
    }
    await applyRecordingMode();
    await recorder.prepareToRecordAsync();
    recorder.record();
    setPhase('recording');
  }

  async function stop() {
    setTaken((state.durationMillis ?? 0) / 1000);
    await recorder.stop();
    try {
      await applyPlaybackMode();
      await releaseAudioSession();
    } catch {
      // Best effort: the next recording attempt fixes the mode.
    }
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
  const recording = phase === 'recording';

  return (
    <SafeAreaView edges={['bottom']} style={StyleSheet.flatten([styles.fill, { backgroundColor: tide.sky[0] }])}>
      <StatusBar style="light" />
      <Stack.Screen
        options={{
          headerStyle: { backgroundColor: tide.sky[0] },
          headerTintColor: tide.text,
          headerShadowVisible: false,
          headerLeft: () => (
            <Pressable onPress={cancel} hitSlop={12}>
              <Text style={{ color: tide.text, fontSize: 16, fontWeight: '600', fontFamily: fonts.ui }}>
                {phase === 'building' ? 'Close' : 'Cancel'}
              </Text>
            </Pressable>
          ),
        }}
      />
      <View style={styles.body}>
        {phase === 'building' ? (
          <View style={styles.center}>
            <ActivityIndicator size="large" color={tide.lang.ja} />
            <Text style={styles.stage}>
              {STAGE_LABEL[stage] ?? 'Working…'}
            </Text>
            <Text style={styles.hint}>
              This takes about a minute. Close this screen if you like, the island keeps
              building and appears in the list when it is ready.
            </Text>
          </View>
        ) : (
          <>
            <Text style={styles.prompt}>
              {phase === 'recording'
                ? 'Keep talking about your day.'
                : 'Talk about your day for 30 seconds or so.'}
            </Text>
            <Text style={styles.hint}>
              Speak Hebrew or English, whichever comes naturally. What you say becomes
              Japanese sentences about your own life, so use real names and real places.
            </Text>

            <Text style={[styles.timer, { color: recording ? tide.record : tide.textDim }]}>
              {clock(elapsed)}
            </Text>

            <LevelBars
              level={recording ? meterLevel(state.metering) : 0}
              live={recording}
            />

            <View style={styles.track}>
              <View
                style={[
                  styles.trackFill,
                  { width: `${Math.min(100, Math.round((elapsed / MAX_SECONDS) * 100))}%` },
                ]}
              />
            </View>

            {phase === 'review' ? (
              <View style={styles.pickerRow}>
                {(['simple', 'complex'] as const).map((level) => {
                  const on = complexity === level;
                  return (
                    <PressScale
                      key={level}
                      onPress={() => setComplexity(level)}
                      style={[
                        styles.pick,
                        {
                          backgroundColor: on ? tide.lang.ja : 'rgba(255,255,255,0.06)',
                          borderColor: on ? tide.lang.ja : 'rgba(255,255,255,0.14)',
                        },
                      ]}>
                      <Text
                        style={[
                          styles.pickTitle,
                          { color: on ? tide.sky[0] : tide.text },
                        ]}>
                        {level === 'simple' ? 'One sentence at a time' : 'Complex patterns'}
                      </Text>
                      <Text
                        style={[
                          styles.pickBody,
                          { color: on ? tide.sky[0] : tide.textDim },
                        ]}>
                        {level === 'simple'
                          ? 'Short standalone lines, one idea each.'
                          : 'Subordinate clauses and connected speech.'}
                      </Text>
                    </PressScale>
                  );
                })}
              </View>
            ) : null}

            {error ? <Text style={styles.error}>{error}</Text> : null}
          </>
        )}
      </View>

      {phase !== 'building' ? (
        <View style={styles.actions}>
          {phase === 'idle' || recording ? (
            <View style={styles.recordWrap}>
              <PressScale
                onPress={recording ? stop : start}
                disabled={recording && !longEnough}
                accessibilityRole="button"
                accessibilityLabel={recording ? 'Stop recording' : 'Start recording'}
                style={[styles.recordButton, recording && styles.recordButtonActive]}>
                <View style={[styles.recordDot, recording && styles.recordDotActive]} />
              </PressScale>
              {recording && !longEnough ? (
                <Text style={styles.keepGoing}>
                  {`Keep going, ${MIN_SECONDS - Math.floor(elapsed)}s more`}
                </Text>
              ) : null}
            </View>
          ) : null}

          {phase === 'review' ? (
            <>
              <PressScale onPress={build} style={styles.primary}>
                <Text style={styles.primaryText}>
                  Build the island
                </Text>
              </PressScale>
              <PressScale onPress={start} style={styles.secondary}>
                <Text style={[styles.secondaryText, { color: tide.textDim }]}>
                  Record again
                </Text>
              </PressScale>
              <PressScale onPress={cancel} style={styles.secondary}>
                <Text style={[styles.secondaryText, { color: tide.record }]}>
                  Discard
                </Text>
              </PressScale>
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
  prompt: { fontSize: 24, lineHeight: 31, color: tide.text, fontFamily: fonts.uiMedium, fontWeight: '500' },
  hint: { fontSize: 14, lineHeight: 21, textAlign: 'center', color: tide.textDim, fontFamily: fonts.ui },
  stage: { fontSize: 18, fontWeight: '600', color: tide.text, fontFamily: fonts.ui },
  timer: {
    fontSize: 56,
    fontVariant: ['tabular-nums'],
    marginTop: Spacing.lg,
    fontFamily: fonts.uiMedium,
    fontWeight: '500',
  },
  track: { height: 4, borderRadius: 2, overflow: 'hidden', backgroundColor: 'rgba(255,255,255,0.08)' },
  trackFill: { height: 4, borderRadius: 2, backgroundColor: tide.lang.ja },
  pickerRow: { gap: Spacing.md, marginTop: Spacing.sm },
  pick: { borderWidth: 1, borderRadius: Radius.md, padding: Spacing.lg, gap: Spacing.xs },
  pickTitle: { fontSize: 16, fontWeight: '600', fontFamily: fonts.ui },
  pickBody: { fontSize: 13, lineHeight: 19, fontFamily: fonts.ui },
  error: { fontSize: 14, lineHeight: 21, marginTop: Spacing.sm, color: tide.record, fontFamily: fonts.ui },
  actions: { padding: Spacing.xl, gap: Spacing.sm },
  recordWrap: { alignItems: 'center', gap: Spacing.sm },
  recordButton: {
    width: 96,
    height: 96,
    borderRadius: 48,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(255,255,255,0.08)',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.12)',
  },
  recordButtonActive: { backgroundColor: tide.record, borderColor: tide.record },
  recordDot: { width: 28, height: 28, borderRadius: 14, backgroundColor: tide.record },
  recordDotActive: { backgroundColor: tide.sky[0] },
  keepGoing: { fontSize: 14, color: tide.textDim, fontFamily: fonts.ui },
  primary: {
    paddingVertical: Spacing.lg,
    borderRadius: Radius.pill,
    alignItems: 'center',
    backgroundColor: tide.lang.ja,
  },
  primaryText: { fontSize: 17, fontWeight: '700', color: tide.sky[0], fontFamily: fonts.ui },
  secondary: { paddingVertical: Spacing.md, alignItems: 'center' },
  secondaryText: { fontSize: 15, fontWeight: '600', fontFamily: fonts.ui },
});
