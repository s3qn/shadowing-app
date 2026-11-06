import {
  RecordingPresets,
  requestRecordingPermissionsAsync,
  useAudioPlayer,
  useAudioPlayerStatus,
  useAudioRecorder,
} from 'expo-audio';
import { Stack, useLocalSearchParams, useRouter } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { SymbolView } from 'expo-symbols'; // icon-buttons: discard
import { useEffect, useRef, useState } from 'react';
import { AppState, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import Animated, { useAnimatedStyle } from 'react-native-reanimated';
import { SafeAreaView } from 'react-native-safe-area-context';

import { CatConstellation } from '@/components/cat-constellation';
import { LevelBars } from '@/components/level-bars';
import { EnergyChip } from '@/components/energy-bolt';
import { canAfford, priceOf, refreshEnergy, useEnergy } from '@/lib/energy';
import { PrismButton } from '@/components/prism';
import { POP, PopoverBubble } from '@/components/tide/popover-bubble';
import { Segmented, type SegmentOption } from '@/components/segmented';

import { HeaderClosePill } from '@/components/header-close-pill';
import { fonts } from '@/constants/fonts';
import { Radius, Spacing, prism, tide, verb as verbTokens } from '@/constants/theme'; // icon-buttons: discard
import { useFollowBuild } from '@/hooks/use-follow-build';
import { useRecorderMeter } from '@/hooks/use-recorder-meter';
import * as api from '@/lib/api';
import { devSayOffline, devSayResult, devSayTranscript } from '@/lib/dev-simulate';
import { useDir, useT } from '@/lib/i18n';
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
  toIslandLanguage,
  toNativeLanguage,
} from '@/lib/settings';

const MIN_SECONDS = 10;
const MAX_SECONDS = 90;
/** Topic mode: a spoken topic for the phrases build, a few seconds at most. */
const TOPIC_MIN_SECONDS = 1;
const TOPIC_MAX_SECONDS = 10;
/** Say mode: one sentence in the native language, a few seconds. */
const SAY_MIN_SECONDS = 1;
const SAY_MAX_SECONDS = 15;
const SIDE = 16;
/** The energy note's bubble: three short lines of copy. */
const ENERGY_POP_W = 280;
const ENERGY_POP_H = 118;
/** Bars in the review waveform. */
const WAVE_BARS = 40;
const WAVE_MIN_H = 3;
const WAVE_MAX_H = 32;
/** The quietest bar of the say frame's timing strip: a pause reads as a dip, not a hole. */
const WAVE_FLOOR = 0.15;
/** The line is drawn smaller past this many characters. */
const SAY_LONG_LINE = 24;
/** The say result's glass card, the ladder stage's line card. */
const GLASS = 'rgba(20,28,44,0.72)';
const RIM = 'rgba(255,255,255,0.14)';

type Phase = 'idle' | 'recording' | 'review' | 'building' | 'done';
type RecordMode = 'say' | 'island';
/** The say frame: what was said, the first voiced line and how many there are. */
type SayResult = { id: string; said: string; native: api.NativeLanguage; line: api.Line; count: number };

function clock(seconds: number, padMinutes = true): string {
  const s = Math.max(0, Math.floor(seconds));
  const m = String(Math.floor(s / 60));
  return `${padMinutes ? m.padStart(2, '0') : m}:${String(s % 60).padStart(2, '0')}`;
}

/** A timing strip of one voiced line: per bucket, the share of its time a
 * word sounds (words carry seconds from the line's start). */
function wordBars(words: api.Word[], duration: number): number[] {
  if (duration <= 0) return new Array<number>(WAVE_BARS).fill(WAVE_FLOOR);
  const bucket = duration / WAVE_BARS;
  return Array.from({ length: WAVE_BARS }, (_, i) => {
    const from = i * bucket;
    const to = from + bucket;
    let sounding = 0;
    for (const w of words) sounding += Math.max(0, Math.min(to, w.end) - Math.max(from, w.start));
    return Math.max(WAVE_FLOOR, Math.min(1, sounding / bucket));
  });
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
function TakeWave({ bars, progress, color = tide.lang.ja }: { bars: number[]; progress: number; color?: string }) {
  const { t } = useT();
  const played = Math.round(progress * bars.length);
  return (
    <View style={styles.wave} accessibilityLabel={t('record.waveform')}>
      {bars.map((v, i) => (
        <View
          key={i}
          style={[
            styles.waveBar,
            {
              height: WAVE_MIN_H + (WAVE_MAX_H - WAVE_MIN_H) * v,
              backgroundColor: i < played ? tide.text : color,
            },
          ]}
        />
      ))}
    </View>
  );
}

/** The play or pause disc of the take card and the say frame. */
function TakePlay({ playing, disabled, onPress }: { playing: boolean; disabled: boolean; onPress: () => void }) {
  const { t } = useT();
  return (
    <PrismButton
      shape="round"
      size={prism.sizes.roundSm}
      verb="listen"
      onPress={onPress}
      disabled={disabled}
      accessibilityRole="button"
      accessibilityLabel={playing ? t('record.pauseRecording') : t('record.playRecording')}>
      {playing ? (
        <View style={styles.pauseIcon}>
          <View style={styles.pauseBar} />
          <View style={styles.pauseBar} />
        </View>
      ) : (
        <View style={styles.playIcon} />
      )}
    </PrismButton>
  );
}

export default function RecordScreen() {
  const { t } = useT();
  const energy = useEnergy();
  const dir = useDir();
  // The energy note: the chip's centre and bottom edge, in the screen body's coordinates.
  const chipRef = useRef<View>(null);
  const bodyRef = useRef<View>(null);
  const [energyInfo, setEnergyInfo] = useState<{ x: number; bottom: number; parentW: number } | null>(null);
  function openEnergyInfo() {
    chipRef.current?.measureInWindow((cx, cy, cw, ch) => {
      bodyRef.current?.measureInWindow((bx, by, bw) => {
        if (![cx, cy, cw, ch, bx, by, bw].every(Number.isFinite)) return;
        setEnergyInfo({ x: cx - bx + cw / 2, bottom: cy - by + ch, parentW: bw });
      });
    });
  }
  const router = useRouter();
  const modeParam = useLocalSearchParams<{ mode?: string }>().mode;
  const topic = modeParam === 'topic';
  // say-it: one sentence in the native language (the default) or the My day
  // island. Topic keeps its own param and no switch.
  const [mode, setMode] = useState<RecordMode>(modeParam === 'island' ? 'island' : 'say');
  const say = !topic && mode === 'say';
  const minSeconds = topic ? TOPIC_MIN_SECONDS : say ? SAY_MIN_SECONDS : MIN_SECONDS;
  const maxSeconds = topic ? TOPIC_MAX_SECONDS : say ? SAY_MAX_SECONDS : MAX_SECONDS;
  const recorder = useAudioRecorder({ ...RecordingPresets.HIGH_QUALITY, isMeteringEnabled: true });

  // Dev `record.sayResult`: the screen opens on the result frame with a canned line.
  const [phase, setPhase] = useState<Phase>(() => (say && devSayResult() ? 'done' : 'idle'));
  const [complexity, setComplexity] = useState<api.Complexity>('simple');
  const [register, setRegister] = useState<api.Register>(DEFAULT_REGISTER);
  const [uri, setUri] = useState<string | null>(null);
  // say-it: the result frame stays on this screen (no route); a failed say
  // goes back to idle with the record button live.
  const { stage, setStage, follow, stop: stopFollow } = useFollowBuild(
    say ? null : '/island/[id]',
    (message) => {
      setError(message);
      setPhase(say ? 'idle' : 'review');
      // A failed say is refunded on the server: re-read the meter for the chip and the button.
      if (say) void refreshEnergy();
    },
    (id) => {
      if (say) void landSay(id);
    },
  );
  const [error, setError] = useState('');
  const [result, setResult] = useState<SayResult | null>(() => {
    const sim = devSayResult();
    return sim && say ? { id: sim.id, said: sim.said, native: sim.native, line: sim.line, count: sim.count } : null;
  });
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
  // A stop in progress: a second tap, the cap or the app going to the
  // background must not stop (and build) the same take twice.
  const stoppingRef = useRef(false);
  const [bars, setBars] = useState<number[]>([]);
  // D57: the recorder is polled into shared values; the screen renders once a second.
  const meter = useRecorderMeter(recorder, phase === 'recording', maxSeconds, (level) => samplesRef.current.push(level));
  const trackProgress = meter.progress;
  const trackFillStyle = useAnimatedStyle(() => ({ width: `${Math.min(100, trackProgress.value * 100)}%` }));

  // Listening back to the take, or to the voiced line on the say frame. Only
  // loaded on those screens, so a file is never open while the microphone is.
  const player = useAudioPlayer(
    phase === 'done' && result
      ? { uri: api.withUser(api.lineAudioUrl(result.id, 0)) }
      : phase === 'review' && uri
        ? { uri }
        : null,
    { updateInterval: 100, keepAudioSessionActive: true },
  );
  const playStatus = useAudioPlayerStatus(player);
  useSessionPlayer(player);

  useEffect(() => {
    getRegister().then(setRegister);
    getSettings().then((s) => {
      setLanguage(toIslandLanguage(s.learningLanguage));
      setNative(toNativeLanguage(s.understoodLanguage));
      void getVoice(s.learningLanguage).then(setVoice);
    });
  }, []);

  // Remembered for next time, same as the voice picker in island settings.
  function chooseRegister(next: api.Register) {
    setRegister(next);
    void persistRegister(next);
  }
  const elapsed = phase === 'review' ? taken : meter.seconds;
  const recording = phase === 'recording';

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
    stopFollow();
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

  // Stop on our own once the cap is hit, so an island never runs long enough to
  // make transcription slow.
  useEffect(() => {
    if (phase === 'recording' && elapsed >= maxSeconds) void stop();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase, elapsed]);

  // The microphone never runs in the background: a recording caught by the
  // app going to the background either becomes the take (if it is already
  // long enough) or is dropped back to idle with a message.
  useEffect(() => {
    const sub = AppState.addEventListener('change', (next) => {
      if (next !== 'background' || phase !== 'recording') return;
      if (elapsed >= minSeconds) {
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
        setError(t('record.backgroundStopped'));
      })();
    });
    return () => sub.remove();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase, elapsed]);

  async function start() {
    if (stoppingRef.current) return;
    setError('');
    stopPlayback(player);
    const perm = await requestRecordingPermissionsAsync();
    if (!perm.granted) {
      setError(t('record.micOff'));
      return;
    }
    await applyRecordingMode();
    await recorder.prepareToRecordAsync();
    samplesRef.current = [];
    recorder.record();
    setPhase('recording');
  }

  async function stop() {
    if (stoppingRef.current) return;
    stoppingRef.current = true;
    try {
      setTaken(meter.millisRef.current / 1000);
      setBars(toBars(samplesRef.current));
      // Leave the recording phase before the awaits: the meter stops polling a
      // stopped recorder, so the clock never drops to 00:00 under "Keep going".
      // The last take's file is dropped first, so review never plays or builds
      // it. say-it: no listen-back, the loop is speak, hear, shadow.
      setUri(null);
      setPhase(say ? 'building' : 'review');
      try {
        await recorder.stop();
      } catch {
        // The file written so far is still read below.
      }
      try {
        await applyPlaybackMode();
        scheduleAudioSessionRelease();
      } catch {
        // Best effort: the next recording attempt fixes the mode.
      }
      const recorded = recorder.uri;
      setUri(recorded);
      if (say) {
        await buildSay(recorded);
      }
    } finally {
      stoppingRef.current = false;
    }
  }

  // say-it: upload the take and follow the build; the frame lands here.
  async function buildSay(fileUri: string | null) {
    // The upload shows "queued", not the last say's "Ready".
    setStage('queued');
    setPhase('building');
    setError('');
    try {
      if (!fileUri || devSayOffline()) throw new Error(t('record.uploadFailed'));
      const { id } = await api.createSay(
        fileUri,
        voice,
        language === 'ja' ? register : undefined,
        language,
        native,
        devSayTranscript(),
      );
      follow(id);
    } catch (e) {
      setError(e instanceof Error ? e.message : t('record.uploadFailed'));
      setPhase('idle');
    }
  }

  // say-it: the island is ready; read it back for the frame. A failed read
  // leaves the island on Home and the record button live.
  async function landSay(id: string) {
    try {
      const island = await api.getIsland(id);
      const line = island.lines[0];
      if (!line) throw new Error(t('islandError.no_lines'));
      setResult({ id, said: island.transcript, native: island.native ?? native, line, count: island.lines.length });
      setPhase('done');
    } catch (e) {
      setError(e instanceof Error ? e.message : t('record.uploadFailed'));
      setPhase('idle');
    }
  }

  function shadowIt() {
    if (!result) return;
    stopPlayback(player);
    router.replace({ pathname: '/island/[id]', params: { id: result.id } });
  }

  async function build() {
    if (!uri) return;
    stopPlayback(player);
    if (topic) {
      // A spoken topic goes to the phrases build, which uploads it itself.
      router.replace({ pathname: '/phrases/build', params: { uri } });
      return;
    }
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
      follow(id);
    } catch (e) {
      setError(e instanceof Error ? e.message : t('record.uploadFailed'));
      setPhase('review');
    }
  }

  const longEnough = elapsed >= minSeconds;
  // Not gated on isLoaded: a short local file can load before the status
  // listener subscribes, and play() on a loading file starts once it is ready.
  const canPlay = (phase === 'review' && !!uri) || (phase === 'done' && !!result);
  const progress =
    playStatus.duration > 0 ? Math.min(1, playStatus.currentTime / playStatus.duration) : 0;

  const languageName: Record<api.Language, string> = {
    ja: t('record.language.ja'),
    es: t('record.language.es'),
    en: t('record.language.en'),
  };
  const nativeName = t(native === 'he' ? 'record.language.he' : 'record.language.en');
  // The said text follows the language the take was sent in (the island stores
  // the request's native), not the settings: Hebrew sits on the right.
  const saidNative = result?.native ?? native;
  const saidName = t(saidNative === 'he' ? 'record.language.he' : 'record.language.en');
  const saidAlign = saidNative === 'he' ? styles.rtlText : styles.ltrText;
  const screenBg = tide.sky[0];
  const titleKey = say
    ? (`record.say.title.${recording ? 'recording' : 'idle'}` as const)
    : (`record.${topic ? 'topic.' : ''}title.${phase === 'review' ? 'review' : recording ? 'recording' : 'idle'}` as 'record.title.idle');
  const modeOptions: readonly SegmentOption<RecordMode>[] = [
    { value: 'say', label: t('record.mode.say') },
    { value: 'island', label: t('record.mode.island') },
  ];
  const complexityOptions: readonly SegmentOption<api.Complexity>[] = [
    { value: 'simple', label: t('record.complexity.simple.label'), description: t('record.complexity.simple.description') },
    { value: 'complex', label: t('record.complexity.complex.label'), description: t('record.complexity.complex.description') },
  ];
  const registerChoices: readonly SegmentOption<api.Register>[] = [
    { value: 'polite', label: t('record.register.polite.label'), description: t('record.register.polite.description') },
    { value: 'casual', label: t('record.register.casual.label'), description: t('record.register.casual.description') },
  ];

  const sayBack = say && (phase === 'building' || phase === 'done');
  // say-it: a back link, designs/sl-r4-4.png frame 4. A build in progress keeps going.
  const backLink = (
    <Pressable onPress={cancel} hitSlop={12} style={styles.backLink} accessibilityRole="button">
      <Text style={styles.backLinkText}>{`${dir.chevron === '›' ? '‹' : '›'} ${t('record.say.back')}`}</Text>
    </Pressable>
  );

  return (
    <SafeAreaView ref={bodyRef} collapsable={false} edges={['bottom']} style={StyleSheet.flatten([styles.fill, { backgroundColor: screenBg }])}>
      <StatusBar style="light" />
      <Stack.Screen
        options={{
          headerStyle: { backgroundColor: screenBg },
          headerTintColor: tide.text,
          headerShadowVisible: false,
          // The back link already names the screen; the route title would sit beside it.
          ...(say && (phase === 'building' || phase === 'done') ? { title: '' } : {}),
          // Hebrew mirrors the header: the back link sits top-right, like the stage header.
          headerLeft: () =>
            sayBack ? (dir.rtl ? null : backLink) : (
              <HeaderClosePill label={phase === 'building' || phase === 'done' ? t('record.close') : t('common.cancel')} onPress={cancel} />
            ),
          ...(sayBack && dir.rtl ? { headerRight: () => backLink } : {}),
        }}
      />

      {phase === 'building' ? (
        <View style={styles.center}>
          <CatConstellation size={120} label={api.stageLabel(stage).replace(/…$/, '')} />
          <Text style={[styles.hint, styles.centerText]}>{t(say ? 'record.say.buildHint' : 'record.buildHint')}</Text>
        </View>
      ) : phase === 'done' && result ? (
        // say-it: the result frame on a Tide glass card, with the take card's play disc and wave.
        <>
          <ScrollView style={styles.fill} contentContainerStyle={styles.sayContent}>
            <View style={styles.sayCard}>
              <View style={styles.sayStatus}>
                <View style={styles.sayDot} />
                <Text style={styles.sayStatusText}>{t('record.say.ready')}</Text>
              </View>
              <Text style={[styles.sayLabel, styles.saySaidLabel, { textAlign: saidAlign.textAlign }]}>
                {t('record.say.youSaid', { language: saidName })}
              </Text>
              <Text style={[styles.saySaid, saidAlign]}>{result.said}</Text>
              <Text style={[styles.sayLabel, styles.sayLangLabel]}>{languageName[language]}</Text>
              <Text style={[styles.sayLine, result.line.ja.length > SAY_LONG_LINE && styles.sayLineLong]}>{result.line.ja}</Text>
              <Text style={styles.sayTranslation}>{result.line.en}</Text>
              {result.count > 1 ? <Text style={styles.sayMore}>{t('record.say.more', { count: result.count - 1 })}</Text> : null}
              <View style={styles.sayAudio}>
                <TakePlay playing={playStatus.playing} disabled={!canPlay} onPress={togglePlay} />
                <TakeWave bars={wordBars(result.line.words, result.line.duration)} progress={progress} />
                <Text style={styles.sayTime}>{clock(result.line.duration, false)}</Text>
              </View>
            </View>
            {error ? <Text style={[styles.error, styles.sayError, dir.text]}>{error}</Text> : null}
          </ScrollView>
          <View style={[styles.actions, styles.sayActions]}>
            <PrismButton
              shape="pill"
              verb="tools"
              label={t('record.say.again')}
              height={56}
              press="light"
              onPress={start}
              disabled={!canAfford(energy, 'say')}
              accessibilityRole="button"
            />
            <PrismButton shape="pill" verb="speak" label={t('record.say.shadow')} height={56} onPress={shadowIt} accessibilityRole="button" />
          </View>
        </>
      ) : (
        <>
          <ScrollView style={styles.fill} contentContainerStyle={styles.content}>
            <View style={styles.header}>
              <View style={[styles.titleRow, dir.row]}>
                <Text style={[styles.title, styles.titleText, dir.text]}>{t(titleKey, { language: nativeName })}</Text>
                {say && energy?.on ? (
                  <Pressable ref={chipRef} onPress={openEnergyInfo} hitSlop={10} accessibilityRole="button" accessibilityLabel={t('energy.info.what')}>
                    <EnergyChip energy={energy} cost={priceOf(energy, 'say')} />
                  </Pressable>
                ) : null}
              </View>
              {phase !== 'review' ? (
                <Text style={[styles.hint, dir.text]}>
                  {say
                    ? t('record.say.hint', { language: languageName[language] })
                    : topic
                      ? t('record.topic.hint')
                      : t('record.promptHint', { language: languageName[language] })}
                </Text>
              ) : null}
            </View>

            {phase === 'idle' && !topic ? <Segmented options={modeOptions} value={mode} onChange={setMode} /> : null}

            {phase === 'review' ? (
              <>
                <View style={styles.takeCard}>
                  <TakePlay playing={playStatus.playing} disabled={!canPlay} onPress={togglePlay} />
                  <TakeWave bars={bars} progress={progress} />
                  <Text style={styles.takeTime}>{clock(taken)}</Text>
                </View>

                {topic ? null : (
                  <Segmented
                  label={t('record.sentencesLabel')}
                  options={complexityOptions}
                  value={complexity}
                  onChange={setComplexity}
                  />
                )}
                {/* Register only applies to Japanese (there is no desu/masu
                    style split in Spanish or English). */}
                {!topic && language === 'ja' ? (
                  <Segmented
                    label={t('record.styleLabel')}
                    options={registerChoices}
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
                <LevelBars level={meter.level} live={recording} />
                <View style={styles.track}>
                  <Animated.View style={[styles.trackFill, trackFillStyle]} />
                </View>
              </View>
            )}

            {error ? <Text style={[styles.error, dir.text]}>{error}</Text> : null}
          </ScrollView>

          <View style={styles.actions}>
            {phase === 'review' ? (
              <>
                <PrismButton
                  shape="pill"
                  verb="speak"
                  on
                  height={prism.sizes.bigRound}
                  label={t(topic ? 'record.topic.build' : 'record.buildIsland')}
                  onPress={build}
                  disabled={!topic && !canAfford(energy, 'create')}
                  trailing={topic ? undefined : <EnergyChip energy={energy} cost={priceOf(energy, 'create')} />}
                  accessibilityRole="button"
                />
                <View style={styles.secondaryRow}>
                  {/* prism-record: edited region, one balanced group centred under the primary button */}
                  <PrismButton shape="pill" verb="tools" label={t('record.recordAgain')} onPress={start} />
                  {/* icon-buttons: Discard */}
                  <PrismButton
                    shape="round"
                    size={prism.sizes.roundSm}
                    verb="speak"
                    onPress={cancel}
                    accessibilityLabel={t('record.discard')}>
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
                  disabled={(recording && !longEnough) || (say && !recording && !canAfford(energy, 'say'))}
                  accessibilityRole="button"
                  accessibilityLabel={recording ? t('record.stopRecording') : t('record.startRecording')}>
                  <View style={[styles.recordDot, recording && styles.recordDotActive]} />
                </PrismButton>
                {/* Always laid out, so the button does not move when it appears. */}
                <Text style={[styles.keepGoing, dir.text]}>
                  {recording && !longEnough
                    ? t('record.keepGoing', { seconds: minSeconds - Math.floor(elapsed) })
                    : recording
                      ? t('record.tapToStop')
                      : t('record.tapToStart')}
                </Text>
              </View>
            )}
          </View>
        </>
      )}
      {energyInfo && energy?.on ? (
        <PopoverBubble
          anchorX={energyInfo.x}
          anchorTop={energyInfo.bottom}
          parentWidth={energyInfo.parentW}
          width={ENERGY_POP_W}
          height={ENERGY_POP_H}
          radius={POP.radius}
          side="bottom"
          gap={4}
          bodyStyle={styles.energyPop}
          onClose={() => setEnergyInfo(null)}>
          <Text style={[styles.energyPopText, dir.text]}>{t('energy.info.what')}</Text>
          <Text style={[styles.energyPopMeta, dir.text]}>{`${t('energy.info.left', { n: energy.daily_left + energy.granted_left })}. ${t('energy.info.refill')}.`}</Text>
        </PopoverBubble>
      ) : null}
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
  energyPop: { padding: 14, gap: 6, justifyContent: 'center' },
  energyPopText: { fontSize: 14, lineHeight: 19, color: POP.ink, fontFamily: fonts.ui },
  energyPopMeta: { fontSize: 13, lineHeight: 18, color: POP.goldInk, fontFamily: fonts.uiMedium, fontWeight: '600' },
  titleRow: { flexDirection: 'row', alignItems: 'flex-start', gap: Spacing.sm },
  titleText: { flex: 1 },
  title: { fontSize: 20, lineHeight: 26, color: tide.text, fontFamily: fonts.uiMedium, fontWeight: '500' },
  hint: { fontSize: 14, lineHeight: 20, color: tide.textDim, fontFamily: fonts.ui, alignSelf: 'stretch', flexShrink: 1 },
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
  // say-it: the result frame on a glass card (the ladder stage's line card).
  sayContent: { flexGrow: 1, paddingHorizontal: SIDE, paddingTop: Spacing.lg, paddingBottom: Spacing.xl },
  sayCard: { borderRadius: 24, paddingHorizontal: Spacing.lg, paddingBottom: Spacing.lg, backgroundColor: GLASS, borderWidth: 1, borderColor: RIM },
  sayError: { marginTop: Spacing.md },
  sayStatus: { flexDirection: 'row', alignItems: 'center', gap: Spacing.sm, marginTop: Spacing.lg },
  sayDot: { width: 8, height: 8, borderRadius: 4, backgroundColor: tide.record },
  sayStatusText: { fontSize: 13, lineHeight: 18, color: tide.textDim, fontFamily: fonts.ui },
  sayLabel: { letterSpacing: 1, textTransform: 'uppercase', color: tide.textDim, fontFamily: fonts.ui },
  saySaidLabel: { fontSize: 12, lineHeight: 16, marginTop: Spacing.xxl, marginBottom: Spacing.sm },
  saySaid: { fontSize: 24, lineHeight: 36, color: tide.text, fontFamily: fonts.ui },
  sayLangLabel: { fontSize: 13, lineHeight: 18, marginTop: Spacing.xxl, marginBottom: Spacing.sm },
  sayLine: { fontSize: 44, lineHeight: 62, color: tide.text, fontFamily: fonts.uiMedium, fontWeight: '500' },
  sayLineLong: { fontSize: 32, lineHeight: 44 },
  sayTranslation: { fontSize: 16, lineHeight: 24, color: tide.textDim, fontFamily: fonts.ui, marginTop: Spacing.xl },
  sayMore: { fontSize: 13, lineHeight: 18, color: tide.textDim, fontFamily: fonts.ui, marginTop: Spacing.sm },
  sayAudio: { flexDirection: 'row', alignItems: 'center', gap: Spacing.lg, marginTop: Spacing.xxl },
  sayTime: { fontSize: 13, fontVariant: ['tabular-nums'], color: tide.textDim, fontFamily: fonts.ui },
  // Say again over Shadow it, both full-width Prism pills.
  sayActions: { alignItems: 'stretch', gap: 12, paddingBottom: 32 },
  backLink: { marginStart: 12 },
  backLinkText: { fontSize: 14, color: tide.textDim, fontFamily: fonts.ui },
  rtlText: { textAlign: 'right', writingDirection: 'rtl' },
  ltrText: { textAlign: 'left', writingDirection: 'ltr' },
});
