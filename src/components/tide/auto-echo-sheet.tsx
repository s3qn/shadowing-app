import { SymbolView } from 'expo-symbols';
import { BlurView } from 'expo-blur';
import { memo, useEffect, useRef, useState } from 'react';
import { StyleSheet, Text, useWindowDimensions, View } from 'react-native';
import Animated, {
  cancelAnimation,
  Easing,
  Extrapolation,
  interpolate,
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
  withDelay,
  withSpring,
  withTiming,
  type SharedValue,
} from 'react-native-reanimated';

import { LevelBars } from '@/components/level-bars';
import { PASSES, PassExplainer } from '@/components/onboarding/pass-step';
import { StepAction } from '@/components/onboarding/step-frame';
import { PressScale } from '@/components/press-scale';
import { PrismButton } from '@/components/prism';
import { BottomSheet } from '@/components/sheet/bottom-sheet';
import { SheetToggle, type SheetIcon } from '@/components/sheet/sheet-rows';
import { ROW_HEIGHT, TakeFeedback } from '@/components/take-feedback';
import { SparkleResult, type SparkleResultData } from '@/components/tide/sparkle-result';
import { STRIP_HEIGHT, VoiceRipples } from '@/components/tide/voice-ripples';
import { fonts } from '@/constants/fonts';
import { prism, tide, verb, withAlpha } from '@/constants/theme';
import { useDir, useT } from '@/lib/i18n';
import type { Mora, NativeLanguage, TakeAnalysis } from '@/lib/api';
import type { AutoChain } from '@/lib/auto-practice';
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

/**
 * The five rows of the lower zone, top to bottom: the pass rail, the pass
 * label, the guidance line, the result, the control. Everything about the
 * current pass is one of these; the sentence above the rule is none of them.
 */
const ROWS = 5;

/** The cut. Each row keeps full contrast and falls, bottom row first, and is
 * gone the instant its own fall lands. Last row out at 4 * 12 + 150 = 198ms. */
const CUT_MS = 150;
const CUT_STAGGER_MS = 12;
const CUT_EASING = Easing.bezier(0.4, 0, 0.72, 0.52);

/** The rise, from the same floor the old rows fell into. The zone is bare
 * between 198ms and 205ms, so the two passes are never on screen together. */
const SWAP_MS = 205;
const RISE_STAGGER_MS = 26;
const RISE_SPRING = { stiffness: 170, damping: 16, mass: 1 } as const;

/**
 * How far a row travels, as a fraction of the sheet's width. A fraction of
 * one shared width, not of each row's own type size: in em the small guidance
 * text travelled less than the pass name above it and the two closed on each
 * other on the way up.
 */
const RISE_FRACTION = 0.1;
const FALL_FRACTION = 0.044;

export type AutoEchoSheetProps = {
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
  /** The auto practice chain this sheet is part of, or null/absent for a normal run. */
  auto?: AutoChain | null;
  onSkip?: () => void;
  onDone?: () => void;
  /** Offers the review project with the most due cards once the lesson is over. */
  review?: { label: string; onPress: () => void } | null;
};

/**
 * One row of the lower zone. `y` is the row's offset in points: positive is
 * below its resting place, which is where both the fall and the rise live.
 * `phase` is 0 while the old pass is falling and 1 while the new one rises,
 * and it is set, never animated.
 *
 * Falling, the row holds full contrast until its own fall lands and then it
 * is simply gone: the exit is a cut, not a fade, so the new pass never has to
 * rise through a ghost of the old one. Rising, the contrast comes back over
 * the first quarter of the travel.
 */
/**
 * Puts every row at rest with nothing running: for reduced motion, for a
 * closed sheet, and for the first pass of a fresh sheet.
 */
function settleRows(rows: readonly SharedValue<number>[], phase: SharedValue<number>) {
  phase.value = 0;
  for (const y of rows) {
    cancelAnimation(y);
    y.value = 0;
  }
}

/**
 * The cut. Every row is driven from this one call, so five rows can never
 * drift apart, and each one leaves from wherever it stands at that instant:
 * a tap that lands mid-transition retimes the whole zone rather than waiting
 * for it or jumping.
 */
function cutRows(rows: readonly SharedValue<number>[], phase: SharedValue<number>, fall: number) {
  phase.value = 0;
  rows.forEach((y, k) => {
    y.value = withDelay((ROWS - 1 - k) * CUT_STAGGER_MS, withTiming(fall, { duration: CUT_MS, easing: CUT_EASING }));
  });
}

/** The rise, out of the floor the old rows fell into, on a real spring. */
function riseRows(rows: readonly SharedValue<number>[], phase: SharedValue<number>, rise: number) {
  phase.value = 1;
  rows.forEach((y, k) => {
    y.value = rise;
    y.value = withDelay(k * RISE_STAGGER_MS, withSpring(0, RISE_SPRING));
  });
}

function useRowStyle(y: SharedValue<number>, phase: SharedValue<number>, rise: number, fall: number) {
  return useAnimatedStyle(() => {
    // A NaN on the UI thread ends the app in Expo Go without a red box.
    const v = Number.isFinite(y.value) ? y.value : 0;
    const opacity =
      phase.value === 0
        ? v >= fall - 0.01
          ? 0
          : 1
        : interpolate(v, [rise * 0.24, rise * 0.53, rise * 0.84, rise], [1, 0.8, 0.4, 0], Extrapolation.CLAMP);
    return { opacity, transform: [{ translateY: v }] };
  }, [rise, fall]);
}

/**
 * The practice sheet: the sentence and its translation in a zone that never
 * moves, and everything about the current pass under the rule below it.
 * Passes are swapped by cutting the old rows away and springing the new ones
 * up out of the same floor.
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
  auto = null,
  onSkip,
  onDone,
  review = null,
}: AutoEchoSheetProps) {
  const reducedMotion = useReducedMotion();
  const { t } = useT();
  const dir = useDir();
  const { width } = useWindowDimensions();
  const segments = segmentsOf(programme);
  const passIndex = segmentIndexOf(step, programme);

  // The pass the lower zone is showing, which lags the real one by the length
  // of the cut so the old rows fall with the old words on them. Only a change
  // of pass animates: Record to Stop inside one pass swaps straight away, so
  // the control is never missing at the moment it is wanted.
  const [shown, setShown] = useState<{ step: PassStep; index: number; end: boolean }>({ step, index: passIndex, end: !!auto?.end });
  const shownRef = useRef(shown);

  const rise = Math.round(width * RISE_FRACTION);
  const fall = Math.round(width * FALL_FRACTION);

  const phase = useSharedValue(0);
  const y0 = useSharedValue(0);
  const y1 = useSharedValue(0);
  const y2 = useSharedValue(0);
  const y3 = useSharedValue(0);
  const y4 = useSharedValue(0);
  const rowStyles = [
    useRowStyle(y0, phase, rise, fall),
    useRowStyle(y1, phase, rise, fall),
    useRowStyle(y2, phase, rise, fall),
    useRowStyle(y3, phase, rise, fall),
    useRowStyle(y4, phase, rise, fall),
  ];
  const swapTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    const ys = [y0, y1, y2, y3, y4];
    const next = { step, index: passIndex, end: !!auto?.end };
    const samePass = passIndex === shownRef.current.index && next.end === shownRef.current.end;
    if (samePass || reducedMotion || !open) {
      if (swapTimer.current !== null) {
        clearTimeout(swapTimer.current);
        swapTimer.current = null;
      }
      if (!samePass) settleRows(ys, phase);
      shownRef.current = next;
      setShown(next);
      return;
    }

    cutRows(ys, phase, fall);
    if (swapTimer.current !== null) clearTimeout(swapTimer.current);
    swapTimer.current = setTimeout(() => {
      swapTimer.current = null;
      shownRef.current = next;
      setShown(next);
      riseRows(ys, phase, rise);
    }, SWAP_MS);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [step, passIndex, auto?.end, reducedMotion, open, rise, fall]);

  useEffect(
    () => () => {
      if (swapTimer.current !== null) clearTimeout(swapTimer.current);
      cancelAnimation(y0);
      cancelAnimation(y1);
      cancelAnimation(y2);
      cancelAnimation(y3);
      cancelAnimation(y4);
    },
    [y0, y1, y2, y3, y4],
  );

  const shownIndex = shown.index;
  const shownPass = shownIndex >= 0 && shownIndex < segments.length ? segments[shownIndex] : null;
  const passColour = shownPass?.colour ?? tide.lang.ja;
  const speaking = isSpeakStep(shown.step);
  const armed = isArmedStep(shown.step);
  const played = isPlayStep(step);

  // Which tab fills and which ones read as finished. While the zone is
  // between two passes the outgoing one is already finished, so it falls with
  // a full underline instead of collapsing to nothing under the screen's
  // reset of `fill`, and no tab is live until the new pass has risen.
  const liveTab = passIndex === shownIndex ? shownIndex : -1;
  const doneBefore = passIndex > shownIndex ? shownIndex + 1 : shownIndex;

  // The live pass's underline, read from the screen's shared value. Rails
  // before it are full and rails after it are empty, both plain static styles
  // below, so this never runs for a step with no active segment.
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

  // auto-practice: the chain's progress line and the end summary.
  const autoHint = !auto
    ? undefined
    : auto.end
      ? t('player.autoDoneTitle')
      : auto.next !== null
        ? t('player.autoNext', { title: auto.next })
        : t('player.autoIslandOf', { n: auto.at + 1, total: auto.total });
  const summary = auto?.end ?? null;

  return (
    <BottomSheet
      open={open}
      onClose={onClose}
      onDismissed={onDismissed}
      title={t(programme === 'ladder' ? 'player.ladder' : 'player.autoEcho')}
      hint={autoHint}>
      <View style={helpOpen ? styles.hidden : undefined}>
        {auto && !auto.end && onSkip ? (
          <PressScale
            onPress={onSkip}
            accessibilityRole="button"
            accessibilityLabel={t('player.autoSkip')}
            style={[styles.skip, dir.rtl ? styles.skipEnd : styles.skipStart, dir.row]}>
            <Text style={styles.skipLabel}>{t('player.autoSkip')}</Text>
            <SymbolView name={{ ios: 'forward.end', android: 'skip_next' }} size={14} weight="regular" tintColor={tide.textDim} />
          </PressScale>
        ) : null}
        {helpPass === null || auto?.end ? null : (
          <PressScale
            onPress={() => setHelpOpen(true)}
            accessibilityRole="button"
            accessibilityLabel={t('player.help')}
            style={[styles.help, dir.rtl ? styles.helpStart : styles.helpEnd]}>
            <SymbolView name={HELP_ICON} size={19} weight="regular" tintColor={tide.textDim} />
          </PressScale>
        )}

        {/* The upper zone. Its height is the same on every pass: the two
            reserved rows below the sentence see to that, so nothing here
            moves when the pass under the rule changes. */}
        <View style={styles.topZone}>
          {sentence ? <Text style={styles.sentence}>{sentence}</Text> : null}
          {english ? <Text style={[styles.english, native === 'he' && styles.englishRtl]}>{english}</Text> : null}
          <View style={styles.feedbackRow}>
            {(played || step === 'done') && moras ? <TakeFeedback moras={moras} analysis={analysis} /> : null}
          </View>
        </View>

        <View style={styles.rule}>
          {shownPass ? <View style={[styles.ruleLit, { backgroundColor: withAlpha(passColour, 0.45) }]} /> : null}
        </View>

        <View style={styles.lowZone}>
          {/* One pane of glass with the five passes marked on it: a rail, not
              five chips. It carries the prism rim and the warm and cool
              fringe, and withholds the lip, the shadow and any press state,
              because it says where you are rather than offering a tap. */}
          <Animated.View style={rowStyles[0]}>
            {shown.end && summary ? (
              <View style={styles.summaryTitleRow}>
                <Text style={styles.summaryTitle}>{t('player.autoDoneTitle')}</Text>
              </View>
            ) : (
            <View style={styles.rail}>
              <BlurView style={StyleSheet.absoluteFill} intensity={prism.blur.intensity} tint={prism.blur.tint} />
              <View style={[StyleSheet.absoluteFill, styles.railFill]} />
              <View pointerEvents="none" style={[StyleSheet.absoluteFill, styles.railRim]} />
              <View pointerEvents="none" style={styles.railTop} />
              <View pointerEvents="none" style={[styles.railFringe, styles.railFringeLeft]} />
              <View pointerEvents="none" style={[styles.railFringe, styles.railFringeRight]} />
              <View style={[styles.railRow, dir.row]}>
                {segments.map((segment, i) => (
                  <View key={segment.labelKey} style={[styles.tab, { backgroundColor: withAlpha(segment.colour, 0.05) }]}>
                    {i > 0 ? (
                      <View pointerEvents="none" style={[styles.divider, dir.rtl ? styles.dividerRtl : styles.dividerLtr]} />
                    ) : null}
                    {i === shownIndex ? (
                      <>
                        <View
                          pointerEvents="none"
                          style={[styles.bloom, styles.bloomLow, { backgroundColor: withAlpha(segment.colour, 0.06) }]}
                        />
                        <View
                          pointerEvents="none"
                          style={[styles.bloom, styles.bloomMid, { backgroundColor: withAlpha(segment.colour, 0.09) }]}
                        />
                        <View
                          pointerEvents="none"
                          style={[styles.bloom, styles.bloomHigh, { backgroundColor: withAlpha(segment.colour, 0.14) }]}
                        />
                      </>
                    ) : null}
                    <Text
                      numberOfLines={1}
                      style={[
                        styles.tabLabel,
                        i < shownIndex && styles.tabLabelDone,
                        i === shownIndex && { color: tide.text },
                      ]}>
                      {t(segment.labelKey)}
                    </Text>
                    {i < doneBefore ? (
                      <View
                        pointerEvents="none"
                        style={[styles.underline, styles.underlineDone, { backgroundColor: withAlpha(segment.colour, 0.5) }]}
                      />
                    ) : null}
                    {i === liveTab ? (
                      <Animated.View
                        pointerEvents="none"
                        style={[
                          styles.underline,
                          dir.rtl ? styles.underlineRtl : styles.underlineLtr,
                          fillStyle,
                          { backgroundColor: segment.colour },
                        ]}
                      />
                    ) : null}
                  </View>
                ))}
              </View>
            </View>
            )}
          </Animated.View>

          <Animated.View style={[styles.passLine, dir.row, rowStyles[1]]}>
            {shown.end && summary ? (
              <Text style={styles.summaryLine}>{t('player.autoShadowed', { count: summary.shadowed })}</Text>
            ) : shownPass ? (
              <>
                <View style={[styles.passDot, { backgroundColor: passColour, shadowColor: passColour }]} />
                <Text style={[styles.passName, { color: passColour }]}>{t(shownPass.labelKey)}</Text>
                <View style={styles.spacer} />
                <Text style={styles.passCount}>{t('player.passOf', { n: shownIndex + 1, total: segments.length })}</Text>
              </>
            ) : null}
          </Animated.View>

          <Animated.View style={[styles.guideRow, dir.row, rowStyles[2]]}>
            {shown.end && summary ? (
              <Text style={[styles.guide, dir.text]}>
                {[t('home.minutes', { count: summary.minutes }), summary.skipped > 0 ? t('player.autoSkipped', { count: summary.skipped }) : null]
                  .filter(Boolean)
                  .join(' · ')}
              </Text>
            ) : (
              <Text style={[styles.guide, dir.text]}>{t(hintKeyOf(shown.step, programme))}</Text>
            )}
            {!shown.end && shown.step === 'echo' && countdown !== null ? <Text style={styles.countdown}>{countdown}</Text> : null}
          </Animated.View>

          <Animated.View style={[styles.resultRow, rowStyles[3]]}>
            {shown.end ? null : speaking ? <VoiceRipples level={level} /> : null}
            {shown.end ? null : <SparkleResult result={result} />}
          </Animated.View>

          <Animated.View style={[styles.controlRow, dir.row, rowStyles[4]]}>
            {review && (shown.end || shown.step === 'done') ? (
              <PrismButton
                shape="pill"
                verb="read"
                label={review.label}
                onPress={review.onPress}
                accessibilityRole="button"
                accessibilityLabel={review.label}
              />
            ) : null}
            {shown.end && onDone ? (
              <PrismButton
                shape="pill"
                verb="tools"
                label={t('player.autoDone')}
                onPress={onDone}
                accessibilityRole="button"
                accessibilityLabel={t('player.autoDone')}
              />
            ) : null}
            {/* auto-practice: no Start again while the hold moves on to the next island. */}
            {shown.end || auto?.next ? null : shown.step === 'idle' || shown.step === 'done' ? (
              <PrismButton
                shape="pill"
                verb="listen"
                label={shown.step === 'idle' ? t('player.start') : t('player.startAgain')}
                onPress={onStart}
                accessibilityRole="button"
                accessibilityLabel={shown.step === 'idle' ? t('player.start') : t('player.startAgain')}
              />
            ) : null}
            {!shown.end && armed ? (
              <View style={styles.recordWrap}>
              <PrismButton
                shape="round"
                verb="speak"
                size={52}
                onPress={onRecord}
                accessibilityRole="button"
                accessibilityLabel={countIn === null ? t('player.record') : t('player.cancelCountIn')}>
                {countIn === null ? (
                  <View style={styles.recordDot} />
                ) : (
                  <>
                    <Text style={styles.countIn}>{countIn}</Text>
                  </>
                )}
              </PrismButton>
              {countIn !== null ? <Animated.View pointerEvents="none" style={[styles.beatRing, beatStyle]} /> : null}
              </View>
            ) : null}
            {!shown.end && speaking && !stopping ? (
              <>
                <PrismButton shape="round" verb="speak" size={52} onPress={onStop} accessibilityRole="button" accessibilityLabel={t('player.stop')}>
                  <View style={styles.stopSquare} />
                </PrismButton>
                <PrismButton shape="round" verb="tools" size={52} onPress={onRetry} accessibilityRole="button" accessibilityLabel={t('common.retry')}>
                  <Text style={styles.retryGlyph}>↻</Text>
                </PrismButton>
              </>
            ) : null}
            {!shown.end && speaking ? <LevelBars level={level} live /> : null}
          </Animated.View>
        </View>

        {auto ? null : (
          <SheetToggle
            label={t('player.autoEchoToggle')}
            value={autoEcho}
            onValueChange={onToggleAutoEcho}
            icon={{ ios: 'forward.end', android: 'skip_next' }}
          />
        )}
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

const RAIL_HEIGHT = 34;

const styles = StyleSheet.create({
  // The running sheet stays mounted while help is up: hiding it keeps the
  // segment fill, the ripples and a recording in progress exactly as they
  // were, and costs no layout.
  hidden: { display: 'none' },
  // A quiet mark in the sheet's top corner: the one affordance here that
  // belongs to no pass, so it sits outside the zone that moves.
  help: { position: 'absolute', top: -6, width: 36, height: 36, alignItems: 'center', justifyContent: 'center', zIndex: 2 },
  helpEnd: { right: -8 },
  helpStart: { left: -8 },
  // auto-practice: Skip mirrors the help icon at the top-start corner.
  skip: { position: 'absolute', top: -6, height: 36, paddingHorizontal: 10, alignItems: 'center', justifyContent: 'center', gap: 4, zIndex: 2 },
  skipStart: { left: -8 },
  skipEnd: { right: -8 },
  skipLabel: { fontFamily: fonts.uiMedium, fontSize: 13, color: tide.textDim },
  summaryTitleRow: { height: RAIL_HEIGHT, justifyContent: 'center' },
  summaryTitle: { fontFamily: fonts.uiMedium, fontSize: 16, color: tide.text },
  summaryLine: { fontFamily: fonts.ui, fontSize: 14, color: tide.text },
  helpBody: { gap: 16, paddingTop: 4, paddingBottom: 8 },
  helpAction: { alignItems: 'center' },
  // The upper zone. minHeight keeps room for the sentence even when Blind
  // hides it and the translation is off, so the rule below never rides up.
  topZone: { minHeight: 56, justifyContent: 'center', paddingBottom: 12 },
  sentence: { fontFamily: fonts.serifJp, fontSize: 20, color: tide.text, textAlign: 'center' },
  english: { fontFamily: fonts.ui, fontSize: 13, color: tide.textDim, textAlign: 'center', marginTop: 4 },
  englishRtl: { writingDirection: 'rtl' },
  // Reserved at this height on every step, not just play/done, so the row
  // mounting in and out doesn't resize the sheet (bottom-sheet.tsx sizes to
  // content) on every Play and every Echo.
  feedbackRow: { minHeight: ROW_HEIGHT, justifyContent: 'center' },
  // The hard split: above it the sentence, below it the pass.
  rule: { height: 1, backgroundColor: 'rgba(255,255,255,0.1)', alignItems: 'center', justifyContent: 'center' },
  ruleLit: { width: 96, height: 1 },
  lowZone: { paddingTop: 14 },
  rail: { height: RAIL_HEIGHT, borderRadius: 10, overflow: 'hidden' },
  railFill: { backgroundColor: 'rgba(255,255,255,0.045)' },
  railRim: { borderRadius: 10, borderWidth: 1, borderColor: prism.panel.rim },
  // The rim light along the top edge, where a pane of glass catches it.
  railTop: { position: 'absolute', left: 8, right: 8, top: 0, height: 1, backgroundColor: prism.fringe.top },
  // The chromatic fringe: warm on one edge, cool on the other.
  railFringe: { position: 'absolute', top: 3, bottom: 3, width: prism.fringe.side },
  railFringeLeft: { left: 0, backgroundColor: prism.fringe.left },
  railFringeRight: { right: 0, backgroundColor: prism.fringe.right },
  railRow: { flexDirection: 'row', flex: 1 },
  tab: { flex: 1, minWidth: 0, alignItems: 'center', justifyContent: 'center' },
  // A hairline between two passes, not a border around one: the rail has to
  // read as a single surface.
  divider: { position: 'absolute', top: 6, bottom: 6, width: StyleSheet.hairlineWidth, backgroundColor: prism.panel.rim },
  dividerLtr: { left: 0 },
  dividerRtl: { right: 0 },
  // The live pass lit from under the glass: three bands, deepest at the foot.
  bloom: { position: 'absolute', left: 0, right: 0, bottom: 0 },
  bloomLow: { height: '70%' },
  bloomMid: { height: '42%' },
  bloomHigh: { height: '20%' },
  tabLabel: { fontFamily: fonts.ui, fontSize: 11, color: withAlpha(tide.textDim, 0.55), paddingHorizontal: 2 },
  tabLabelDone: { color: tide.textDim },
  // Doubles as the pass's progress: the live pass's underline grows with
  // playback, a finished pass keeps a full one.
  underline: { position: 'absolute', bottom: 0, height: 2 },
  underlineLtr: { left: 0 },
  underlineRtl: { right: 0 },
  underlineDone: { left: 0, right: 0 },
  passLine: { flexDirection: 'row', alignItems: 'center', gap: 7, height: 20, marginTop: 14 },
  passDot: { width: 7, height: 7, borderRadius: 4, shadowOpacity: 0.9, shadowRadius: 6, shadowOffset: { width: 0, height: 0 }, elevation: 4 },
  passName: { fontFamily: fonts.uiMedium, fontWeight: '600', fontSize: 12, letterSpacing: 1.4, textTransform: 'uppercase' },
  spacer: { flex: 1 },
  passCount: { fontFamily: fonts.ui, fontSize: 11, color: withAlpha(tide.textDim, 0.7), fontVariant: ['tabular-nums'] },
  guideRow: { flexDirection: 'row', alignItems: 'center', gap: 10, minHeight: 36, marginTop: 8 },
  guide: { flex: 1, fontFamily: fonts.ui, fontSize: 13, lineHeight: 18, color: tide.textDim },
  countdown: { fontFamily: fonts.uiMedium, fontWeight: '500', fontSize: 16, color: tide.text, fontVariant: ['tabular-nums'] },
  // Reserved at the ripples' height on every pass, so the take result and the
  // ripples both have a place and neither resizes the zone.
  resultRow: { height: STRIP_HEIGHT, alignItems: 'center', justifyContent: 'center' },
  controlRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 20, minHeight: 52, marginTop: 4 },
  recordWrap: { position: 'relative', width: 52, height: 52 },
  recordDot: { width: 16, height: 16, borderRadius: 8, backgroundColor: verb.speak.c1 },
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
  countIn: { fontFamily: fonts.uiMedium, fontWeight: '500', fontSize: 24, color: verb.speak.c1, fontVariant: ['tabular-nums'] },
  stopSquare: { width: 16, height: 16, borderRadius: 3, backgroundColor: verb.speak.c1 },
  retryGlyph: { fontFamily: fonts.ui, fontSize: 24, color: verb.tools.c1 },
  note: { fontFamily: fonts.ui, fontSize: 12, lineHeight: 17, color: tide.textDim, marginTop: 12 },
  error: { fontFamily: fonts.ui, fontSize: 13, lineHeight: 19, textAlign: 'center', color: tide.record, marginTop: 12 },
});
