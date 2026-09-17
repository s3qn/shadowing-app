import {
  RecordingPresets,
  requestRecordingPermissionsAsync,
  useAudioPlayer,
  useAudioPlayerStatus,
  useAudioRecorder,
  useAudioRecorderState,
} from 'expo-audio';
import { Stack, useRouter } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { SymbolView } from 'expo-symbols'; // icon-buttons: discard
import { useEffect, useRef, useState } from 'react';
import { AppState, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useSharedValue } from 'react-native-reanimated';
import { SafeAreaView } from 'react-native-safe-area-context';

import { CatConstellation } from '@/components/cat-constellation';
import { LevelBars, meterLevel } from '@/components/level-bars';
import { PrismButton } from '@/components/prism';
import { Segmented, type SegmentOption } from '@/components/segmented';

import { fonts } from '@/constants/fonts';
import { Radius, Spacing, prism, tide, verb as verbTokens } from '@/constants/theme'; // icon-buttons: discard
import * as api from '@/lib/api';
import {
  applyPlaybackMode,
  applyRecordingMode,
  releaseAudioSession,
  scheduleAudioSessionRelease,
  startPlayback,
  stopPlayback,
  useSessionPlayer,
} from '@/lib/audio-mode';
import {
  DEFAULT_REGISTER,
  DEFAULT_VOICE,
  getRegister,
  getSettings,
  getVoice,
  setRegister as persistRegister,
} from '@/lib/settings';

// languages: full names for the record screen's hint, keyed the same as
// `LEARNING_LANGUAGE_OPTIONS` in settings.ts.
const LANGUAGE_NAME: Record<api.Language, string> = { ja: 'Japanese', es: 'Spanish', en: 'English' };

const MIN_SECONDS = 10;
const MAX_SECONDS = 90;
const SIDE = 16;
/** Bars in the review waveform. */
const WAVE_BARS = 40;
const WAVE_MIN_H = 3;
const WAVE_MAX_H = 32;

type Phase = 'idle' | 'recording' | 'review' | 'building';

const STAGE_LABEL: Record<string, string> = {
  queued: 'Queued…',
  transcribing: 'Transcribing…',
  writing: 'Writing the lines…',
  speaking: 'Recording the voice…',
  ready: 'Ready.',
};

/** How long the finished island sits on screen, glowing, before the
 * screen navigates away. */
const READY_HOLD_MS = 900;

const COMPLEXITY_OPTIONS: readonly SegmentOption<api.Complexity>[] = [
  { value: 'simple', label: 'One at a time', description: 'Short standalone lines, one idea each.' },
  { value: 'complex', label: 'Complex', description: 'Subordinate clauses and connected speech.' },
];

const REGISTER_CHOICES: readonly SegmentOption<api.Register>[] = [
  { value: 'polite', label: 'Polite', description: 'です/ます, the everyday standard.' },
  { value: 'casual', label: 'Casual', description: 'Plain form, the way you would talk with a friend.' },
];

function clock(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
}

/** Squeezes the level samples of a whole take into WAVE_BARS bars, keeping each bucket's peak. */
function toBars(samples: number[]): number[] {
  if (samples.length === 0) return new Array<number>(WAVE_BARS).fill(0);
  return Array.from({ length: WAVE_BARS }, (_, i) => {
    const from = Math.floor((i * samples.length) / WAVE_BARS);
    const to = Math.max(from + 1, Math.floor(((i + 1) * samples.length) / WAVE_BARS));
    let peak = 0;
    for (let j = from; j < to && j < samples.length; j++) peak = Math.max(peak, samples[j]!);
    return peak;
  });
}

/** The take drawn from its own microphone levels. Bars already played are brighter. */
function TakeWave({ bars, progress }: { bars: number[]; progress: number }) {
  const played = Math.round(progress * bars.length);
  return (
    <View style={styles.wave} accessibilityLabel="Waveform of your recording">
      {bars.map((v, i) => (
        <View
          key={i}
          style={[
            styles.waveBar,
            {
              height: WAVE_MIN_H + (WAVE_MAX_H - WAVE_MIN_H) * v,
              backgroundColor: i < played ? tide.text : tide.lang.ja,
            },
          ]}
        />
      ))}
    </View>
  );
}

export default function RecordScreen() {
  const router = useRouter();
  const recorder = useAudioRecorder({ ...RecordingPresets.HIGH_QUALITY, isMeteringEnabled: true });
  const state = useAudioRecorderState(recorder, 50);

  const [phase, setPhase] = useState<Phase>('idle');
  const [complexity, setComplexity] = useState<api.Complexity>('simple');
  const [register, setRegister] = useState<api.Register>(DEFAULT_REGISTER);
  const [uri, setUri] = useState<string | null>(null);
  const [stage, setStage] = useState('queued');
  const [error, setError] = useState('');
  // The recorder's clock resets once it stops, so the length of the last take
  // is kept separately for the review screen.
  const [taken, setTaken] = useState(0);
  const [voice, setVoice] = useState<number>(DEFAULT_VOICE);
  // languages: the learner's current pick, so a new island is built in the
  // right language with the right voice.
  const [language, setLanguage] = useState<api.Language>('ja');
  const [native, setNative] = useState<api.NativeLanguage>('en');
  // Every meter reading of the take in progress, squeezed into bars on stop.
  const samplesRef = useRef<number[]>([]);
  const [bars, setBars] = useState<number[]>([]);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const readyTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Listening back to the take. Only loaded on the review screen, so the file
  // is never open while the microphone is.
  const player = useAudioPlayer(phase === 'review' && uri ? { uri } : null, {
    updateInterval: 100,
    keepAudioSessionActive: true,
  });
  const playStatus = useAudioPlayerStatus(player);
  useSessionPlayer(player);

  useEffect(() => {
    getRegister().then(setRegister);
    getSettings().then((s) => {
      setLanguage(s.learningLanguage);
      setNative(s.understoodLanguage);
      void getVoice(s.learningLanguage).then(setVoice);
    });
  }, []);

  // Remembered for next time, same as the voice picker in island settings.
  function chooseRegister(next: api.Register) {
    setRegister(next);
    void persistRegister(next);
  }
  const elapsed = phase === 'review' ? taken : (state.durationMillis ?? 0) / 1000;
  const recording = phase === 'recording';

  useEffect(() => {
    if (recording) samplesRef.current.push(meterLevel(state.metering));
  }, [recording, state.durationMillis, state.metering]);

  // The bars read a shared value; this screen keeps its recorder state and
  // copies each sample across.
  const barLevel = useSharedValue(0);
  useEffect(() => {
    barLevel.value = recording ? meterLevel(state.metering) : 0;
  }, [recording, state.metering, barLevel]);

  // Back to the start once the take has played through, and the volume goes
  // back to other apps.
  useEffect(() => {
    if (!playStatus.didJustFinish) return;
    try {
      void player.seekTo(0);
    } catch {
      // Released with the review screen.
    }
    scheduleAudioSessionRelease();
  }, [playStatus.didJustFinish, player]);

  function togglePlay() {
    if (playStatus.playing) {
      stopPlayback(player);
      scheduleAudioSessionRelease();
      return;
    }
    if (playStatus.duration > 0 && playStatus.currentTime >= playStatus.duration - 0.05) {
      try {
        void player.seekTo(0);
      } catch {
        // Released with the review screen.
      }
    }
    startPlayback(player);
  }

  // Leave without building anything. A take in progress is stopped and
  // dropped; an island already building keeps building on the server and
  // shows up in the list when it is done.
  async function cancel() {
    if (pollRef.current) clearInterval(pollRef.current);
    if (readyTimerRef.current) clearTimeout(readyTimerRef.current);
    stopPlayback(player);
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
      } catch {
        // Best effort: the next recording attempt fixes the mode.
      }
    }
    try {
      await releaseAudioSession();
    } catch {
      // Best effort.
    }
    router.back();
  }

  useEffect(() => () => {
    if (pollRef.current) clearInterval(pollRef.current);
    if (readyTimerRef.current) clearTimeout(readyTimerRef.current);
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
    stopPlayback(player);
    const perm = await requestRecordingPermissionsAsync();
    if (!perm.granted) {
      setError('Microphone access is off. Turn it on in Settings and try again.');
      return;
    }
    await applyRecordingMode();
    await recorder.prepareToRecordAsync();
    samplesRef.current = [];
    recorder.record();
    setPhase('recording');
  }

  async function stop() {
    setTaken((state.durationMillis ?? 0) / 1000);
    setBars(toBars(samplesRef.current));
    await recorder.stop();
    try {
      await applyPlaybackMode();
      scheduleAudioSessionRelease();
    } catch {
      // Best effort: the next recording attempt fixes the mode.
    }
    setUri(recorder.uri);
    setPhase('review');
  }

  async function build() {
    if (!uri) return;
    stopPlayback(player);
    setPhase('building');
    setError('');
    try {
      // Register only means anything for Japanese: send it for ja, leave it
      // out for every other learning language.
      const { id } = await api.createIsland(
        uri,
        complexity,
        voice,
        language === 'ja' ? register : undefined,
        8,
        language,
        native,
      );
      pollRef.current = setInterval(async () => {
        try {
          const island = await api.getIsland(id);
          setStage(island.stage || island.status);
          if (island.status === 'ready') {
            if (pollRef.current) clearInterval(pollRef.current);
            // Hold the finished island on screen a moment, glowing, before
            // moving on: the build scene's last piece needs a beat to read.
            setStage('ready');
            readyTimerRef.current = setTimeout(() => {
              router.replace({ pathname: '/island/[id]', params: { id } });
            }, READY_HOLD_MS);
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
  // Not gated on isLoaded: a short local file can load before the status
  // listener subscribes, and play() on a loading file starts once it is ready.
  const canPlay = phase === 'review' && !!uri;
  const progress =
    playStatus.duration > 0 ? Math.min(1, playStatus.currentTime / playStatus.duration) : 0;

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

      {phase === 'building' ? (
        <View style={styles.center}>
          <CatConstellation size={120} label={(STAGE_LABEL[stage] ?? 'Working…').replace(/…$/, '')} />
          <Text style={[styles.hint, styles.centerText]}>
            This takes about a minute. Close this screen if you like, the island keeps
            building and appears in the list when it is ready.
          </Text>
        </View>
      ) : (
        <>
          <ScrollView style={styles.fill} contentContainerStyle={styles.content}>
            <View style={styles.header}>
              <Text style={styles.title}>
                {phase === 'review'
                  ? 'Your recording'
                  : recording
                    ? 'Keep talking about your day.'
                    : 'Talk about your day for 30 seconds or so.'}
              </Text>
              {phase !== 'review' ? (
                <Text style={styles.hint}>
                  Speak Hebrew or English, whichever comes naturally. What you say becomes{' '}
                  {LANGUAGE_NAME[language]} sentences about your own life, so use real names and real places.
                </Text>
              ) : null}
            </View>

            {phase === 'review' ? (
              <>
                <View style={styles.takeCard}>
                  <PrismButton
                    shape="round"
                    size={prism.sizes.roundSm}
                    verb="listen"
                    onPress={togglePlay}
                    disabled={!canPlay}
                    accessibilityRole="button"
                    accessibilityLabel={playStatus.playing ? 'Pause recording' : 'Play recording'}>
                    {playStatus.playing ? (
                      <View style={styles.pauseIcon}>
                        <View style={styles.pauseBar} />
                        <View style={styles.pauseBar} />
                      </View>
                    ) : (
                      <View style={styles.playIcon} />
                    )}
                  </PrismButton>
                  <TakeWave bars={bars} progress={progress} />
                  <Text style={styles.takeTime}>{clock(taken)}</Text>
                </View>

                <Segmented
                  label="Sentences"
                  options={COMPLEXITY_OPTIONS}
                  value={complexity}
                  onChange={setComplexity}
                />
                {/* Register only applies to Japanese (there is no desu/masu
                    style split in Spanish or English). */}
                {language === 'ja' ? (
                  <Segmented
                    label="Style"
                    options={REGISTER_CHOICES}
                    value={register}
                    onChange={chooseRegister}
                  />
                ) : null}
              </>
            ) : (
              <View style={styles.meter}>
                <Text style={[styles.timer, { color: recording ? tide.record : tide.textDim }]}>
                  {clock(elapsed)}
                </Text>
                <LevelBars level={barLevel} live={recording} />
                <View style={styles.track}>
                  <View
                    style={[
                      styles.trackFill,
                      { width: `${Math.min(100, Math.round((elapsed / MAX_SECONDS) * 100))}%` },
                    ]}
                  />
                </View>
              </View>
            )}

            {error ? <Text style={styles.error}>{error}</Text> : null}
          </ScrollView>

          <View style={styles.actions}>
            {phase === 'review' ? (
              <>
                <PrismButton
                  shape="pill"
                  verb="speak"
                  on
                  height={prism.sizes.bigRound}
                  label="Build the island"
                  onPress={build}
                  accessibilityRole="button"
                />
                <View style={styles.secondaryRow}>
                  {/* prism-record: edited region, one balanced group centred under the primary button */}
                  <PrismButton shape="pill" verb="tools" label="Record again" onPress={start} />
                  {/* icon-buttons: Discard */}
                  <PrismButton
                    shape="round"
                    size={prism.sizes.roundSm}
                    verb="speak"
                    onPress={cancel}
                    accessibilityLabel="Discard">
                    <SymbolView name={{ ios: 'trash', android: 'delete' }} size={16} weight="regular" tintColor={verbTokens.speak.c1} />
                  </PrismButton>
                  {/* prism-record: end */}
                </View>
              </>
            ) : (
              <View style={styles.recordWrap}>
                <PrismButton
                  shape="round"
                  size={prism.sizes.bigRound}
                  verb="speak"
                  on={recording}
                  onPress={recording ? stop : start}
                  disabled={recording && !longEnough}
                  accessibilityRole="button"
                  accessibilityLabel={recording ? 'Stop recording' : 'Start recording'}>
                  <View style={[styles.recordDot, recording && styles.recordDotActive]} />
                </PrismButton>
                {/* Always laid out, so the button does not move when it appears. */}
                <Text style={styles.keepGoing}>
                  {recording && !longEnough
                    ? `Keep going, ${MIN_SECONDS - Math.floor(elapsed)}s more`
                    : recording
                      ? 'Tap to stop'
                      : 'Tap to start'}
                </Text>
              </View>
            )}
          </View>
        </>
      )}
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1 },
  content: {
    flexGrow: 1,
    paddingHorizontal: SIDE,
    paddingTop: Spacing.lg,
    paddingBottom: Spacing.xl,
    gap: Spacing.xl,
  },
  center: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    gap: Spacing.lg,
    paddingHorizontal: SIDE,
  },
  centerText: { textAlign: 'center' },
  header: { gap: Spacing.sm },
  title: { fontSize: 20, lineHeight: 26, color: tide.text, fontFamily: fonts.uiMedium, fontWeight: '500' },
  hint: { fontSize: 14, lineHeight: 20, color: tide.textDim, fontFamily: fonts.ui },
  meter: { alignItems: 'center', gap: Spacing.lg, marginTop: Spacing.lg },
  timer: {
    fontSize: 56,
    fontVariant: ['tabular-nums'],
    fontFamily: fonts.uiMedium,
    fontWeight: '500',
  },
  track: {
    alignSelf: 'stretch',
    height: 4,
    borderRadius: 2,
    overflow: 'hidden',
    backgroundColor: 'rgba(255,255,255,0.08)',
  },
  trackFill: { height: 4, borderRadius: 2, backgroundColor: tide.lang.ja },
  takeCard: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.md,
    padding: Spacing.md,
    borderRadius: Radius.md,
    backgroundColor: 'rgba(255,255,255,0.06)',
  },
  // A triangle drawn with borders, nudged right so it looks centred.
  playIcon: {
    marginLeft: 3,
    width: 0,
    height: 0,
    borderTopWidth: 7,
    borderBottomWidth: 7,
    borderLeftWidth: 11,
    borderTopColor: 'transparent',
    borderBottomColor: 'transparent',
    borderLeftColor: tide.text,
  },
  pauseIcon: { flexDirection: 'row', gap: 4 },
  pauseBar: { width: 4, height: 14, borderRadius: 1, backgroundColor: tide.text },
  wave: {
    flex: 1,
    height: WAVE_MAX_H,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 2,
  },
  waveBar: { flex: 1, borderRadius: 2 },
  takeTime: {
    fontSize: 15,
    fontVariant: ['tabular-nums'],
    color: tide.textDim,
    fontFamily: fonts.uiMedium,
    fontWeight: '500',
  },
  error: { fontSize: 14, lineHeight: 20, color: tide.record, fontFamily: fonts.ui },
  actions: { paddingHorizontal: SIDE, paddingTop: Spacing.md, paddingBottom: Spacing.sm, gap: Spacing.xs },
  recordWrap: { alignItems: 'center', gap: Spacing.sm },
  recordDot: { width: 28, height: 28, borderRadius: 14, backgroundColor: tide.record },
  recordDotActive: { backgroundColor: verbTokens.speak.c1 },
  keepGoing: { fontSize: 14, lineHeight: 20, color: tide.textDim, fontFamily: fonts.ui },
  // One balanced row, both actions centred on the same line: no flex:1
  // wrapper pushes either one off to a half of the row.
  secondaryRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: Spacing.lg, paddingTop: Spacing.sm },
  secondaryText: { fontSize: 15, fontFamily: fonts.uiMedium, fontWeight: '500' },
});
