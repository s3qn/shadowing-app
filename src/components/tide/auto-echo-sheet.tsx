import { SymbolView } from 'expo-symbols';
import { memo, useEffect, useRef, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import Animated, {
  cancelAnimation,
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
import { PASSES, PassExplainer } from '@/components/onboarding/pass-step';
import { StepAction } from '@/components/onboarding/step-frame';
import { PressScale } from '@/components/press-scale';
import { BottomSheet } from '@/components/sheet/bottom-sheet';
import { SheetToggle, type SheetIcon } from '@/components/sheet/sheet-rows';
import { ROW_HEIGHT, TakeFeedback } from '@/components/take-feedback';
import { SparkleResult, type SparkleResultData } from '@/components/tide/sparkle-result';
import { STRIP_HEIGHT, VoiceRipples } from '@/components/tide/voice-ripples';
import { fonts } from '@/constants/fonts';
import { tide } from '@/constants/theme';
import { useDir, useT } from '@/lib/i18n';
import type { Mora, NativeLanguage, TakeAnalysis } from '@/lib/api';
import {
  COUNT_IN_BEAT_MS,
  helpPassOf,
  hintKeyOf,
  isArmedStep,
  isPlayStep,
  isSpeakStep,
  segmentsOf,
  segmentIndexOf,
  type PassStep,
  type Programme,
} from '@/lib/pass-programme';
import type { LearningLanguage } from '@/lib/settings';

/** The help affordance's symbol: quiet, and the same question mark on both
 * platforms. */
const HELP_ICON: SheetIcon = { ios: 'questionmark.circle', android: 'help_outline' };

/** Old name for `PassStep`, kept so a step prop typed against it still
 * compiles. */
export type EchoStep = PassStep;

type AutoEchoSheetProps = {
  open: boolean;
  onClose: () => void;
  onDismissed?: () => void;
  sentence: string | null;
  english: string | null;
  /** The island's understood language: 'he' lays the translation line out
   * right to left. Defaults to 'en'. */
  native?: NativeLanguage;
  /** The island's learning language: the Read along help shows its sample
   * words. Defaults to Japanese. */
  language?: LearningLanguage;
  /** The line's moras, for the feedback row's kana and phrase grouping. */
  moras: Mora[] | null;
  /** The last take's mora feedback, shown under the English at Play and Done. */
  analysis: TakeAnalysis | null;
  step: PassStep;
  /** The step machine the record button runs: the five-pass ladder or the
   * plain Auto Echo loop, chosen in Settings > Playback. The sheet only reads
   * it to pick its title and its segments; it has no control to change it. */
  programme?: Programme;
  countdown: number | null;
  /** The beat the count before a hand-started take is on (3, 2, 1), or `null`
   * when no count is running. The record button shows it instead of its dot,
   * and one ring pulses out of the button per beat. */
  countIn: number | null;
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
  /** Whether the current recording input is a headset mic: Speak plays the
   * line under the voice with one in, and stays silent without. `null` means
   * not probed yet this app run. */
  headset: boolean | null;
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
  native = 'en',
  language = 'ja',
  moras,
  analysis,
  step,
  programme = 'ladder',
  countdown,
  countIn,
  level,
  fill,
  stopping,
  result,
  error,
  autoEcho,
  autoRecord,
  onToggleAutoEcho,
  onToggleAutoRecord,
  headset,
  onStart,
  onRecord,
  onStop,
  onRetry,
}: AutoEchoSheetProps) {
  const segmentIndex = segmentIndexOf(step, programme);
  const reducedMotion = useReducedMotion();
  const { t } = useT();
  const dir = useDir();
  const segments = segmentsOf(programme);
  const speaking = isSpeakStep(step);
  const armed = isArmedStep(step);
  const played = isPlayStep(step);

  // The one active segment's width, read from the screen's shared value.
  // Segments before and after it are plain static styles below, so this
  // never runs for a step that has no active segment (idle, done).
  const fillStyle = useAnimatedStyle(() => ({
    width: `${Math.max(0, Math.min(1, fill.value)) * 100}%`,
  }));

  // One ring leaves the record button per count beat: 0 at the beat, 1 when
  // the next one is due. With reduced motion it does not move at all and the
  // ring simply stands around the button while the count runs, so the digit
  // is never the only sign of it.
  const beat = useSharedValue(0);
  useEffect(() => {
    if (countIn === null) {
      cancelAnimation(beat);
      beat.value = 0;
      return;
    }
    if (reducedMotion) {
      beat.value = 0;
      return;
    }
    beat.value = 0;
    beat.value = withTiming(1, { duration: COUNT_IN_BEAT_MS, easing: Easing.out(Easing.cubic) });
  }, [countIn, reducedMotion, beat]);
  useEffect(() => () => cancelAnimation(beat), [beat]);

  // Guarded: a NaN or undefined here would throw on the UI thread, which
  // Expo Go ends the app for without a red box.
  const beatStyle = useAnimatedStyle(() => {
    const b = Number.isFinite(beat.value) ? Math.min(Math.max(beat.value, 0), 1) : 0;
    if (reducedMotion) return { opacity: 0.8, transform: [{ scale: 1.1 }] };
    return { opacity: 0.85 * (1 - b), transform: [{ scale: 1 + 0.22 * b }] };
  }, [reducedMotion]);

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

  // The pass the help button explains, and whether it is showing. Help is
  // display only: the run behind it keeps going (the line plays on, a
  // recording keeps recording, a saved take stays saved), so one tap on Got
  // it puts the practice back exactly where it was. Nothing pauses: the
  // passes are timed against the audio, and pausing mid-record would cut the
  // take short. The body below stays mounted under `display: none`, so the
  // only clocks help starts are the explanation's own, and closing it
  // unmounts them.
  const helpPass = helpPassOf(step, programme);
  const [helpOpen, setHelpOpen] = useState(false);
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (!open) setHelpOpen(false);
  }, [open]);

  return (
    <BottomSheet
      open={open}
      onClose={onClose}
      onDismissed={onDismissed}
      title={t(programme === 'ladder' ? 'player.ladder' : 'player.autoEcho')}>
      <View style={helpOpen ? styles.hidden : undefined}>
        {helpPass === null ? null : (
          <PressScale
            onPress={() => setHelpOpen(true)}
            accessibilityRole="button"
            accessibilityLabel={t('player.help')}
            style={[styles.help, dir.rtl ? styles.helpStart : styles.helpEnd]}>
            <SymbolView name={HELP_ICON} size={19} weight="regular" tintColor={tide.textDim} />
          </PressScale>
        )}
        <View style={styles.sentenceArea}>
          {sentence ? <Text style={styles.sentence}>{sentence}</Text> : null}
          {english ? <Text style={[styles.english, native === 'he' && styles.englishRtl]}>{english}</Text> : null}
          <View style={styles.feedbackRow}>
            {(played || step === 'done') && moras ? <TakeFeedback moras={moras} analysis={analysis} /> : null}
          </View>
          <SparkleResult result={result} />
        </View>

        <View style={[styles.segments, dir.row]}>
          {segments.map((segment, i) => (
            <View key={segment.labelKey} style={styles.segmentCol}>
              <View style={styles.segmentBar}>
                {i < segmentIndex ? (
                  <View
                    style={[
                      styles.segmentFill,
                      dir.rtl && styles.segmentFillRtl,
                      styles.segmentFillDone,
                      { backgroundColor: segment.colour },
                    ]}
                  />
                ) : null}
                {i === segmentIndex ? (
                  <Animated.View
                    style={[styles.segmentFill, dir.rtl && styles.segmentFillRtl, fillStyle, { backgroundColor: segment.colour }]}
                  />
                ) : null}
              </View>
              {i === glowAt ? (
                <Animated.View
                  pointerEvents="none"
                  style={[
                    styles.segmentGlow,
                    dir.rtl && styles.segmentGlowRtl,
                    glowStyle,
                    { backgroundColor: segment.colour, shadowColor: segment.colour },
                  ]}
                />
              ) : null}
              <Text style={[styles.segmentLabel, i <= segmentIndex && styles.segmentLabelDone]}>{t(segment.labelKey)}</Text>
            </View>
          ))}
        </View>

        <View style={styles.ripplesRow}>{speaking ? <VoiceRipples level={level} /> : null}</View>

        <View style={styles.hintRow}>
          <Animated.Text
            key={step}
            entering={reducedMotion ? FadeIn.duration(180) : SlideInRight.duration(220).easing(Easing.out(Easing.cubic))}
            exiting={reducedMotion ? FadeOut.duration(180) : SlideOutLeft.duration(220).easing(Easing.out(Easing.cubic))}
            style={styles.hint}>
            {t(hintKeyOf(step, programme))}
          </Animated.Text>
          {step === 'echo' && countdown !== null ? <Text style={styles.countdown}>{countdown}</Text> : null}
          {speaking ? <LevelBars level={level} live /> : null}
        </View>

        <View style={styles.buttonRow}>
          {step === 'idle' || step === 'done' ? (
            <PressScale onPress={onStart} accessibilityRole="button" accessibilityLabel={step === 'idle' ? t('player.start') : t('player.startAgain')} style={styles.pill}>
              <Text style={styles.pillLabel}>{step === 'idle' ? t('player.start') : t('player.startAgain')}</Text>
            </PressScale>
          ) : null}
          {armed ? (
            <PressScale
              onPress={onRecord}
              accessibilityRole="button"
              accessibilityLabel={countIn === null ? t('player.record') : t('player.cancelCountIn')}
              style={[styles.round, styles.recordRound]}>
              {countIn === null ? (
                <View style={styles.recordDot} />
              ) : (
                <>
                  <Animated.View pointerEvents="none" style={[styles.beatRing, beatStyle]} />
                  <Text style={styles.countIn}>{countIn}</Text>
                </>
              )}
            </PressScale>
          ) : null}
          {speaking && !stopping ? (
            <>
              <PressScale onPress={onStop} accessibilityRole="button" accessibilityLabel={t('player.stop')} style={[styles.round, styles.recordRound]}>
                <View style={styles.stopSquare} />
              </PressScale>
              <PressScale onPress={onRetry} accessibilityRole="button" accessibilityLabel={t('common.retry')} style={[styles.round, styles.retryRound]}>
                <Text style={styles.retryGlyph}>↻</Text>
              </PressScale>
            </>
          ) : null}
        </View>

        <SheetToggle
          label={t('player.autoEchoToggle')}
          value={autoEcho}
          onValueChange={onToggleAutoEcho}
          icon={{ ios: 'forward.end', android: 'skip_next' }}
        />
        <SheetToggle
          label={t('player.autoRecordToggle')}
          value={autoRecord}
          onValueChange={onToggleAutoRecord}
          icon={{ ios: 'mic', android: 'mic' }}
        />
        <Text style={[styles.note, dir.text]}>
          {headset === true ? t('player.headsetIn') : t('player.headsetPrompt')}
        </Text>
        {error ? <Text style={styles.error}>{error}</Text> : null}
      </View>

      {helpOpen && helpPass !== null ? (
        <View style={styles.helpBody}>
          <PassExplainer pass={helpPass} learning={language} understood={native} />
          <View style={styles.helpAction}>
            <StepAction
              verb={PASSES[helpPass].nextVerb}
              label={t('settings.onboarding.gotIt')}
              onPress={() => setHelpOpen(false)}
            />
          </View>
        </View>
      ) : null}
    </BottomSheet>
  );
}

/** Memoised: the player screen renders often, and a closed sheet has
 * nothing to redraw. Its handler props come through useStableHandler. */
export const AutoEchoSheet = memo(AutoEchoSheetBase);

const styles = StyleSheet.create({
  // The running sheet stays mounted while help is up: hiding it keeps the
  // segment fill, the ripples and a recording in progress exactly as they
  // were, and costs no layout.
  hidden: { display: 'none' },
  // A quiet mark in the sheet's top corner, clear of the Start and Record
  // controls in the middle. Temporary: this sheet is being redesigned.
  help: { position: 'absolute', top: -6, width: 36, height: 36, alignItems: 'center', justifyContent: 'center', zIndex: 2 },
  helpEnd: { right: -8 },
  helpStart: { left: -8 },
  helpBody: { gap: 16, paddingTop: 4, paddingBottom: 8 },
  helpAction: { alignItems: 'center' },
  // minHeight keeps room for the SparkleResult overlay even when Blind hides
  // the sentence and English is off, so the result still has a place to sit.
  sentenceArea: { minHeight: 56, justifyContent: 'center' },
  sentence: { fontFamily: fonts.serifJp, fontSize: 20, color: tide.text, textAlign: 'center' },
  english: { fontFamily: fonts.ui, fontSize: 13, color: tide.textDim, textAlign: 'center', marginTop: 4 },
  englishRtl: { writingDirection: 'rtl' },
  // Reserved at this height on every step, not just play/done, so the row
  // mounting in and out doesn't resize the sheet (bottom-sheet.tsx sizes to
  // content) on every Play and every Echo.
  feedbackRow: { minHeight: ROW_HEIGHT, justifyContent: 'center' },
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
  // The bars run in reading order, so each one fills from the end it starts at.
  segmentFillRtl: { left: undefined, right: 0 },
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
  segmentGlowRtl: { right: undefined, left: -8 },
  segmentLabel: { fontFamily: fonts.ui, fontSize: 11, color: tide.textDim },
  segmentLabelDone: { color: tide.text },
  hintRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 10, marginTop: 14, minHeight: 32 },
  hint: { fontFamily: fonts.ui, fontSize: 13, color: tide.textDim, textAlign: 'center' },
  countdown: { fontFamily: fonts.uiMedium, fontWeight: '500', fontSize: 16, color: tide.text, fontVariant: ['tabular-nums'] },
  buttonRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 20, marginTop: 16, minHeight: 52 },
  pill: { paddingVertical: 14, paddingHorizontal: 36, borderRadius: 26, backgroundColor: tide.lang.ja, alignItems: 'center', justifyContent: 'center' },
  pillLabel: { fontFamily: fonts.uiMedium, fontWeight: '500', fontSize: 16, color: tide.water },
  round: { width: 52, height: 52, borderRadius: 26, alignItems: 'center', justifyContent: 'center' },
  // overflow: the count's ring grows past the button and must not be clipped.
  recordRound: { backgroundColor: tide.record, overflow: 'visible' },
  retryRound: { backgroundColor: tide.lang.ja },
  recordDot: { width: 16, height: 16, borderRadius: 8, backgroundColor: tide.sky[0] },
  // Sits around the 52pt record button and grows past it on each count beat.
  beatRing: {
    position: 'absolute',
    top: -8,
    left: -8,
    width: 68,
    height: 68,
    borderRadius: 34,
    borderWidth: 2,
    borderColor: tide.record,
  },
  countIn: { fontFamily: fonts.uiMedium, fontWeight: '500', fontSize: 24, color: tide.sky[0], fontVariant: ['tabular-nums'] },
  stopSquare: { width: 16, height: 16, borderRadius: 3, backgroundColor: tide.sky[0] },
  retryGlyph: { fontFamily: fonts.ui, fontSize: 24, color: tide.sky[0] },
  note: { fontFamily: fonts.ui, fontSize: 12, lineHeight: 17, color: tide.textDim, marginTop: 4 },
  error: { fontFamily: fonts.ui, fontSize: 13, lineHeight: 19, textAlign: 'center', color: tide.record, marginTop: 12 },
});
