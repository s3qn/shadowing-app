import * as Haptics from 'expo-haptics';
import { Image } from 'expo-image';
import { useRouter } from 'expo-router';
import { RecordingPresets, requestRecordingPermissionsAsync, useAudioRecorder, useAudioRecorderState } from 'expo-audio';
import { requireOptionalNativeModule } from 'expo-modules-core';
import { useEffect, useRef, useState } from 'react';
import { Platform, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import Animated, {
  Easing,
  useAnimatedStyle,
  useSharedValue,
  withRepeat,
  withSequence,
  withTiming,
} from 'react-native-reanimated';

import { CatConstellation } from '@/components/cat-constellation';
import { GuideBubble } from '@/components/onboarding/guide-bubble';
import { PrismButton } from '@/components/prism';
import { Segmented } from '@/components/segmented';
import { GlassInput } from '@/components/tide/glass-input';
import { fonts } from '@/constants/fonts';
import { Spacing, tide } from '@/constants/theme';
import { applyPlaybackMode, applyRecordingMode, scheduleAudioSessionRelease } from '@/lib/audio-mode';
import { flushFeedback, submitFeedback, type FeedbackKind } from '@/lib/feedback';
import { hapticNotify } from '@/lib/haptics';
import { useDir, useT } from '@/lib/i18n';

const FADE_MS = 180;
const MAX_IMAGES = 4;
const MAX_RECORD_S = 300;

type Picker = typeof import('expo-image-picker');

/**
 * The picker is a native module a dev client built before it was added does not have.
 * Ask for the native side first: in dev, Metro reports a failed require as fatal even
 * inside try/catch, so the JS package must not load when the native module is missing.
 */
function loadPicker(): Picker | null {
  if (Platform.OS !== 'web' && !requireOptionalNativeModule('ExponentImagePicker')) return null;
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    return require('expo-image-picker') as Picker;
  } catch {
    return null;
  }
}

const clock = (ms: number) => {
  const s = Math.floor(ms / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
};

export default function FeedbackScreen() {
  const { t } = useT();
  const dir = useDir();
  const router = useRouter();
  const [kind, setKind] = useState<FeedbackKind>('bug');
  const [text, setText] = useState('');
  const [voice, setVoice] = useState<{ uri: string; ms: number } | null>(null);
  const [images, setImages] = useState<string[]>([]);
  const [recording, setRecording] = useState(false);
  const [micDenied, setMicDenied] = useState(false);
  const [sending, setSending] = useState(false);
  const [outcome, setOutcome] = useState<'' | 'sent' | 'queued'>('');
  const [error, setError] = useState('');
  const [picker] = useState<Picker | null>(loadPicker);

  const recorder = useAudioRecorder(RecordingPresets.HIGH_QUALITY);
  const rec = useAudioRecorderState(recorder, 250);
  const recordingRef = useRef(false);
  const autoStop = useRef<ReturnType<typeof setTimeout>>(undefined);
  const recMs = rec.durationMillis ?? 0;

  const done = outcome !== '';
  const canSend = (text.trim().length > 0 || !!voice || images.length > 0) && !sending && !recording && !done;

  useEffect(() => {
    void flushFeedback();
  }, []);

  // Leaving while recording discards the take.
  useEffect(
    () => () => {
      clearTimeout(autoStop.current);
      if (recordingRef.current) {
        recordingRef.current = false;
        void recorder.stop().catch(() => undefined);
        void applyPlaybackMode().catch(() => undefined);
        scheduleAudioSessionRelease();
      }
    },
    [recorder],
  );

  const buttonOpacity = useSharedValue(1);
  const loaderOpacity = useSharedValue(0);
  const sentOpacity = useSharedValue(0);
  const dot = useSharedValue(1);

  useEffect(() => {
    buttonOpacity.value = withTiming(!sending && !done ? 1 : 0, { duration: FADE_MS });
    loaderOpacity.value = withTiming(sending && !done ? 1 : 0, { duration: FADE_MS });
    sentOpacity.value = withTiming(done ? 1 : 0, { duration: FADE_MS });
  }, [sending, done, buttonOpacity, loaderOpacity, sentOpacity]);

  useEffect(() => {
    if (recording) {
      dot.value = withRepeat(
        withSequence(
          withTiming(0.4, { duration: 700, easing: Easing.inOut(Easing.ease) }),
          withTiming(1, { duration: 700, easing: Easing.inOut(Easing.ease) }),
        ),
        -1,
      );
    } else {
      dot.value = 1;
    }
  }, [recording, dot]);

  const buttonStyle = useAnimatedStyle(() => ({ opacity: buttonOpacity.value }));
  const loaderStyle = useAnimatedStyle(() => ({ opacity: loaderOpacity.value }));
  const sentStyle = useAnimatedStyle(() => ({ opacity: sentOpacity.value }));
  const dotStyle = useAnimatedStyle(() => ({ opacity: dot.value }));

  async function stopVoice() {
    clearTimeout(autoStop.current);
    recordingRef.current = false;
    setRecording(false);
    let uri: string | null = null;
    try {
      await recorder.stop();
      uri = recorder.uri;
    } catch {
      uri = recorder.uri;
    }
    await applyPlaybackMode().catch(() => undefined);
    scheduleAudioSessionRelease();
    if (uri) setVoice({ uri, ms: recMs });
  }

  async function toggleVoice() {
    if (recording) {
      await stopVoice();
      return;
    }
    try {
      if (!(await requestRecordingPermissionsAsync()).granted) {
        setMicDenied(true);
        return;
      }
      setMicDenied(false);
      await applyRecordingMode();
      await recorder.prepareToRecordAsync();
      recorder.record();
      recordingRef.current = true;
      autoStop.current = setTimeout(() => void stopVoice(), MAX_RECORD_S * 1000);
      setVoice(null);
      setRecording(true);
    } catch {
      setMicDenied(true);
    }
  }

  async function addImages() {
    const p = picker;
    if (!p) return;
    try {
      const res = await p.launchImageLibraryAsync({
        mediaTypes: ['images'],
        allowsMultipleSelection: true,
        selectionLimit: MAX_IMAGES - images.length,
        quality: 0.7,
      });
      if (res.canceled) return;
      setImages((cur) => [...cur, ...res.assets.map((a) => a.uri)].slice(0, MAX_IMAGES));
    } catch {
      // picker closed or unavailable: nothing to add
    }
  }

  async function send() {
    setError('');
    setSending(true);
    try {
      const result = await submitFeedback({ kind, text, voice: voice?.uri, images });
      setOutcome(result);
      void hapticNotify(Haptics.NotificationFeedbackType.Success);
      setTimeout(() => router.back(), result === 'sent' ? 1200 : 1600);
    } catch {
      setError(t('feedback.error'));
      setSending(false);
    }
  }

  const locked = sending || done;

  return (
    <SafeAreaView edges={['bottom']} style={StyleSheet.flatten([styles.fill, { backgroundColor: tide.sky[0] }])}>
      <ScrollView contentContainerStyle={styles.list} keyboardShouldPersistTaps="handled">
        <Segmented
          options={[
            { value: 'bug', label: t('feedback.kind.bug') },
            { value: 'suggestion', label: t('feedback.kind.suggestion') },
          ]}
          value={kind}
          onChange={setKind}
        />
        <Text style={[styles.hint, { color: tide.textDim }, dir.text]}>{t('feedback.hint')}</Text>

        <GlassInput
          value={text}
          onChangeText={(value) => {
            setText(value);
            if (error) setError('');
          }}
          editable={!locked}
          multiline
          maxLength={4000}
          numberOfLines={6}
          textAlignVertical="top"
          placeholder={t(kind === 'bug' ? 'feedback.placeholder.bug' : 'feedback.placeholder.suggestion')}
          placeholderTextColor={tide.textDim}
          style={[styles.input, dir.text]}
        />

        <View style={[styles.row, dir.row]} pointerEvents={locked ? 'none' : 'auto'}>
          {recording ? <Animated.View style={[styles.dot, dotStyle]} /> : null}
          <PrismButton
            shape="pill"
            verb="speak"
            on={recording}
            label={recording ? t('feedback.stop', { time: clock(recMs) }) : t('feedback.record')}
            onPress={() => void toggleVoice()}
            accessibilityRole="button"
          />
          {voice && !recording ? (
            <View style={[styles.voice, dir.row]}>
              <Text style={[styles.line, { color: tide.text }, dir.text]}>
                {t('feedback.voiceNote', { time: clock(voice.ms) })}
              </Text>
              <Pressable onPress={() => setVoice(null)} accessibilityRole="button" accessibilityLabel="Remove" hitSlop={8} style={styles.x}>
                <Text style={styles.xGlyph}>×</Text>
              </Pressable>
            </View>
          ) : null}
        </View>
        {micDenied ? <Text style={[styles.line, { color: tide.record }, dir.text]}>{t('feedback.micDenied')}</Text> : null}

        {picker ? (
          <View style={[styles.row, dir.row]} pointerEvents={locked ? 'none' : 'auto'}>
            {images.map((uri, i) => (
              <View key={uri} style={styles.thumbWrap}>
                <Image source={{ uri }} style={styles.thumb} contentFit="cover" />
                <Pressable
                  onPress={() => setImages((cur) => cur.filter((_, j) => j !== i))}
                  accessibilityRole="button"
                  accessibilityLabel="Remove"
                  hitSlop={8}
                  style={[styles.x, styles.thumbX]}>
                  <Text style={styles.xGlyph}>×</Text>
                </Pressable>
              </View>
            ))}
            {images.length < MAX_IMAGES ? (
              <PrismButton
                shape="pill"
                verb="tools"
                label={t('feedback.addImage')}
                onPress={() => void addImages()}
                accessibilityRole="button"
              />
            ) : null}
          </View>
        ) : null}

        <Text style={[styles.privacy, { color: tide.textDim }, dir.text]}>{t('feedback.privacy')}</Text>

        <Text style={[styles.error, { color: tide.record }, dir.text]}>{error}</Text>

        <View style={styles.stack}>
          <Animated.View style={[styles.layer, buttonStyle]} pointerEvents={locked ? 'none' : 'auto'}>
            <PrismButton
              shape="pill"
              verb="tools"
              on
              label={t('feedback.send')}
              disabled={!canSend}
              onPress={send}
              accessibilityRole="button"
              containerStyle={styles.send}
            />
          </Animated.View>
          <Animated.View style={[styles.layer, loaderStyle]} pointerEvents={sending && !done ? 'auto' : 'none'}>
            <CatConstellation size={90} label={t('feedback.sending')} />
          </Animated.View>
          <Animated.View style={[styles.layer, sentStyle]} pointerEvents="none">
            {done ? <GuideBubble kind="proud" text={t(outcome === 'sent' ? 'feedback.sent' : 'feedback.queued')} /> : null}
          </Animated.View>
        </View>
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1 },
  list: { padding: Spacing.lg, gap: Spacing.lg },
  hint: { fontFamily: fonts.ui, fontSize: 14 },
  input: { minHeight: 140 },
  row: { flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', gap: Spacing.sm },
  voice: { flexDirection: 'row', alignItems: 'center', gap: Spacing.sm },
  line: { fontFamily: fonts.ui, fontSize: 14 },
  dot: { width: 10, height: 10, borderRadius: 5, backgroundColor: tide.record },
  thumbWrap: { width: 72, height: 72 },
  thumb: { width: 72, height: 72, borderRadius: 12, borderWidth: 1, borderColor: 'rgba(255,255,255,0.18)' },
  x: { width: 22, height: 22, borderRadius: 11, backgroundColor: 'rgba(0,0,0,0.55)', alignItems: 'center', justifyContent: 'center' },
  thumbX: { position: 'absolute', top: 4, end: 4 },
  xGlyph: { color: '#fff', fontSize: 14, lineHeight: 16 },
  privacy: { fontFamily: fonts.ui, fontSize: 12 },
  error: { fontFamily: fonts.ui, fontSize: 14, minHeight: 20 },
  stack: { height: 150 },
  layer: { ...StyleSheet.absoluteFill, justifyContent: 'center', alignItems: 'center' },
  send: { alignSelf: 'center' },
});
