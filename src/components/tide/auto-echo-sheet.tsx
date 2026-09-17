import { memo, useEffect, useRef, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import Animated, {
  Easing,
  FadeIn,
  FadeOut,
  SlideInRight,
  SlideOutLeft,
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
  withSequence,
  withTiming,
  type SharedValue,
} from 'react-native-reanimated';

import { LevelBars } from '@/components/level-bars';
import { PressScale } from '@/components/press-scale';
import { BottomSheet } from '@/components/sheet/bottom-sheet';
import { SheetToggle } from '@/components/sheet/sheet-rows';
import { SparkleResult, type SparkleResultData } from '@/components/tide/sparkle-result';
import { STRIP_HEIGHT, VoiceRipples } from '@/components/tide/voice-ripples';
import { fonts } from '@/constants/fonts';
import { tide } from '@/constants/theme';

/** The four steps of one Echo pass, in order. `idle` is before Start and
 * `done` is after the last Play, both outside the segment row. */
export type EchoStep = 'idle' | 'listen' | 'echo' | 'armed' | 'speak' | 'play' | 'done';

export const STEP_HINT: Record<EchoStep, string> = {
  idle: 'Ready',
  listen: 'Listen to the audio',
  echo: 'Recall and understand the content just heard',
  armed: 'Try to say this sentence',
  speak: 'Try to say this sentence',
  play: 'Listen to and compare your voice',
  done: 'Pass complete',
};

const SEGMENT_LABELS = ['Listen', 'Echo', 'Speak', 'Play'];

// idle has no filled segment; done fills every segment (the pass is over).
const SEGMENT_INDEX: Record<EchoStep, number> = {
  idle: -1,
  listen: 0,
  echo: 1,
  armed: 2,
  speak: 2,
  play: 3,
  done: 4,
};

type AutoEchoSheetProps = {
  open: boolean;
  onClose: () => void;
  onDismissed?: () => void;
  sentence: string | null;
  english: string | null;
  step: EchoStep;
  countdown: number | null;
  /** 0..1 live meter level, read on the UI thread by the ripples and bars. */
  level: SharedValue<number>;
  /** 0..1, animated on the UI thread by the screen: how far the current
   * step's segment has filled. Steps before it are always full, steps after
   * it are always empty; this only drives the one that is active now. */
  fill: SharedValue<number>;
  /** Stop was tapped and the take is saving: Stop and Retry are hidden. */
  stopping: boolean;
  /** The last Play step's outcome, shown as a sparkle and word over the hint
   * row. `null` before any Play step has finished this sheet session. */
  result: SparkleResultData;
  error: string;
  autoEcho: boolean;
  autoRecord: boolean;
  onToggleAutoEcho: () => void;
  onToggleAutoRecord: () => void;
  /** Speak plays the line under the voice; off records with the line silent. */
  playLineWhileSpeaking: boolean;
  onTogglePlayLineWhileSpeaking: () => void;
  onStart: () => void;
  onRecord: () => void;
  onStop: () => void;
  onRetry: () => void;
};

/**
 * The Auto Echo loop: listen to the line, echo it in the pad's silence, speak
 * it back (recorded), then play the take back. Runs on its own while the
 * sheet is open; closing it stops everything.
 */
function AutoEchoSheetBase({
  open,
  onClose,
  onDismissed,
  sentence,
  english,
  step,
  countdown,
  level,
  fill,
  stopping,
  result,
  error,
  autoEcho,
  autoRecord,
  onToggleAutoEcho,
  onToggleAutoRecord,
  playLineWhileSpeaking,
  onTogglePlayLineWhileSpeaking,
  onStart,
  onRecord,
  onStop,
  onRetry,
}: AutoEchoSheetProps) {
  const segmentIndex = SEGMENT_INDEX[step];
  const reducedMotion = useReducedMotion();

  // The one active segment's width, read from the screen's shared value.
  // Segments before and after it are plain static styles below, so this
  // never runs for a step that has no active segment (idle, done).
  const fillStyle = useAnimatedStyle(() => ({
    width: `${Math.max(0, Math.min(1, fill.value)) * 100}%`,
  }));

  // A short soft glow at the boundary where a segment just finished and the
  // next one takes over. Display only: it reads `step` (via segmentIndex)
  // and never touches the step machine, recording or fill logic.
  const prevSegmentIndex = useRef(segmentIndex);
  const glow = useSharedValue(0);
  const [glowAt, setGlowAt] = useState<number | null>(null);
  useEffect(() => {
    if (segmentIndex > prevSegmentIndex.current) {
      const boundary = prevSegmentIndex.current;
      setGlowAt(boundary);
      glow.value = 0;
      glow.value = withSequence(
        withTiming(1, { duration: 140, easing: Easing.out(Easing.cubic) }),
        withTiming(0, { duration: 360, easing: Easing.inOut(Easing.cubic) }),
      );
      const t = setTimeout(() => setGlowAt(null), 520);
      prevSegmentIndex.current = segmentIndex;
      return () => clearTimeout(t);
    }
    prevSegmentIndex.current = segmentIndex;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [segmentIndex]);
  const glowStyle = useAnimatedStyle(() => ({ opacity: glow.value }));

  return (
    <BottomSheet open={open} onClose={onClose} onDismissed={onDismissed} title="Auto Echo">
      <View style={styles.sentenceArea}>
        {sentence ? <Text style={styles.sentence}>{sentence}</Text> : null}
        {english ? <Text style={styles.english}>{english}</Text> : null}
        <SparkleResult result={result} />
      </View>

      <View style={styles.segments}>
        {SEGMENT_LABELS.map((label, i) => (
          <View key={label} style={styles.segmentCol}>
            <View style={styles.segmentBar}>
              {i < segmentIndex ? <View style={[styles.segmentFill, styles.segmentFillDone]} /> : null}
              {i === segmentIndex ? <Animated.View style={[styles.segmentFill, fillStyle]} /> : null}
            </View>
            {i === glowAt ? <Animated.View pointerEvents="none" style={[styles.segmentGlow, glowStyle]} /> : null}
            <Text style={[styles.segmentLabel, i <= segmentIndex && styles.segmentLabelDone]}>{label}</Text>
          </View>
        ))}
      </View>

      <View style={styles.ripplesRow}>{step === 'speak' ? <VoiceRipples level={level} /> : null}</View>

      <View style={styles.hintRow}>
        <Animated.Text
          key={step}
          entering={reducedMotion ? FadeIn.duration(180) : SlideInRight.duration(220).easing(Easing.out(Easing.cubic))}
          exiting={reducedMotion ? FadeOut.duration(180) : SlideOutLeft.duration(220).easing(Easing.out(Easing.cubic))}
          style={styles.hint}>
          {STEP_HINT[step]}
        </Animated.Text>
        {step === 'echo' && countdown !== null ? <Text style={styles.countdown}>{countdown}</Text> : null}
        {step === 'speak' ? <LevelBars level={level} live /> : null}
      </View>

      <View style={styles.buttonRow}>
        {step === 'idle' || step === 'done' ? (
          <PressScale onPress={onStart} accessibilityRole="button" accessibilityLabel={step === 'idle' ? 'Start' : 'Start again'} style={styles.pill}>
            <Text style={styles.pillLabel}>{step === 'idle' ? 'Start' : 'Start again'}</Text>
          </PressScale>
        ) : null}
        {step === 'armed' ? (
          <PressScale onPress={onRecord} accessibilityRole="button" accessibilityLabel="Record" style={[styles.round, styles.recordRound]}>
            <View style={styles.recordDot} />
          </PressScale>
        ) : null}
        {step === 'speak' && !stopping ? (
          <>
            <PressScale onPress={onStop} accessibilityRole="button" accessibilityLabel="Stop" style={[styles.round, styles.recordRound]}>
              <View style={styles.stopSquare} />
            </PressScale>
            <PressScale onPress={onRetry} accessibilityRole="button" accessibilityLabel="Retry" style={[styles.round, styles.retryRound]}>
              <Text style={styles.retryGlyph}>↻</Text>
            </PressScale>
          </>
        ) : null}
      </View>

      <SheetToggle
        label="Go on to the next line, and start over after the last"
        value={autoEcho}
        onValueChange={onToggleAutoEcho}
      />
      <SheetToggle label="Speak opens the microphone on its own" value={autoRecord} onValueChange={onToggleAutoRecord} />
      <SheetToggle
        label="Play the line while I speak"
        value={playLineWhileSpeaking}
        onValueChange={onTogglePlayLineWhileSpeaking}
      />
      {playLineWhileSpeaking ? (
        <Text style={styles.note}>Use headphones, the phone speaker bleeds into your take.</Text>
      ) : null}
      {error ? <Text style={styles.error}>{error}</Text> : null}
    </BottomSheet>
  );
}

/** Memoised: the player screen renders often, and a closed sheet has
 * nothing to redraw. Its handler props come through useStableHandler. */
export const AutoEchoSheet = memo(AutoEchoSheetBase);

const styles = StyleSheet.create({
  // minHeight keeps room for the SparkleResult overlay even when Blind hides
  // the sentence and English is off, so the result still has a place to sit.
  sentenceArea: { minHeight: 56, justifyContent: 'center' },
  sentence: { fontFamily: fonts.serifJp, fontSize: 20, color: tide.text, textAlign: 'center' },
  english: { fontFamily: fonts.ui, fontSize: 13, color: tide.textDim, textAlign: 'center', marginTop: 4 },
  // Reserved at this height on every step, not just speak, so VoiceRipples
  // mounting in only doesn't move the segments and hint row below it.
  ripplesRow: { height: STRIP_HEIGHT },
  segments: { flexDirection: 'row', gap: 8, marginTop: 20 },
  segmentCol: { flex: 1, alignItems: 'center', gap: 4 },
  segmentBar: {
    alignSelf: 'stretch',
    height: 6,
    borderRadius: 3,
    backgroundColor: 'rgba(255,255,255,0.14)',
    overflow: 'hidden',
  },
  segmentFill: { position: 'absolute', left: 0, top: 0, bottom: 0, borderRadius: 3, backgroundColor: tide.lang.ja },
  segmentFillDone: { width: '100%' },
  // Sits over the gap to the right of a segment bar, at the boundary where
  // it just finished and the next one takes over.
  segmentGlow: {
    position: 'absolute',
    top: -4,
    right: -8,
    width: 16,
    height: 14,
    borderRadius: 7,
    backgroundColor: tide.lang.ja,
    shadowColor: tide.lang.ja,
    shadowOpacity: 0.9,
    shadowRadius: 8,
    shadowOffset: { width: 0, height: 0 },
    elevation: 6,
  },
  segmentLabel: { fontFamily: fonts.ui, fontSize: 11, color: tide.textDim },
  segmentLabelDone: { color: tide.text },
  hintRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 10, marginTop: 14, minHeight: 32 },
  hint: { fontFamily: fonts.ui, fontSize: 13, color: tide.textDim, textAlign: 'center' },
  countdown: { fontFamily: fonts.uiMedium, fontWeight: '500', fontSize: 16, color: tide.text, fontVariant: ['tabular-nums'] },
  buttonRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 20, marginTop: 16, minHeight: 52 },
  pill: { paddingVertical: 14, paddingHorizontal: 36, borderRadius: 26, backgroundColor: tide.lang.ja, alignItems: 'center', justifyContent: 'center' },
  pillLabel: { fontFamily: fonts.uiMedium, fontWeight: '500', fontSize: 16, color: tide.water },
  round: { width: 52, height: 52, borderRadius: 26, alignItems: 'center', justifyContent: 'center' },
  recordRound: { backgroundColor: tide.record },
  retryRound: { backgroundColor: tide.lang.ja },
  recordDot: { width: 16, height: 16, borderRadius: 8, backgroundColor: tide.sky[0] },
  stopSquare: { width: 16, height: 16, borderRadius: 3, backgroundColor: tide.sky[0] },
  retryGlyph: { fontFamily: fonts.ui, fontSize: 24, color: tide.sky[0] },
  note: { fontFamily: fonts.ui, fontSize: 12, lineHeight: 17, color: tide.textDim, marginTop: 4 },
  error: { fontFamily: fonts.ui, fontSize: 13, lineHeight: 19, textAlign: 'center', color: tide.record, marginTop: 12 },
});
