import { memo, useEffect, useMemo, useRef, useState } from 'react';
import { Pressable, StyleSheet, Text, useWindowDimensions, View } from 'react-native';
import { GestureDetector } from 'react-native-gesture-handler';
import Animated, { FadeIn, FadeOut, useAnimatedReaction, useAnimatedStyle, useReducedMotion, useSharedValue } from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { StageChips } from '@/components/tide/ladder/chips';
import { CountHairline } from '@/components/tide/ladder/count-hairline';
import { CubeStage } from '@/components/tide/ladder/cube-stage';
import { PausedLayer, usePausedDim } from '@/components/tide/ladder/paused-layer';
import { ScoreSlot } from '@/components/tide/ladder/score-slot';
import { Sentence } from '@/components/tide/ladder/sentence';
import { SentenceDots } from '@/components/tide/ladder/sentence-dots';
import { StageHint } from '@/components/tide/ladder/stage-hint';
import { StageSky } from '@/components/tide/ladder/stage-sky';
import { COMPARE, FINAL, frameOf, jumpStep, STEPS, stepOf } from '@/components/tide/ladder/stage-model';
import { LadderHelpButton } from '@/components/tide/ladder/stage-tile';
import { CHIPS_H, OUT, SCORE_H, SLOT_GAP } from '@/components/tide/ladder/stage-tokens';
import { StepBar } from '@/components/tide/ladder/step-bar';
import { StepList } from '@/components/tide/ladder/step-list';
import { TranslationSlot } from '@/components/tide/ladder/translation-slot';
import { useBodyGesture } from '@/components/tide/ladder/use-body-gesture';
import { useCountClock } from '@/components/tide/ladder/use-count-in';
import { useCubePan } from '@/components/tide/ladder/use-cube-pan';
import { WordPanelLayer } from '@/components/tide/ladder/word-panel-layer';
import { PaceSheet } from '@/components/tide/pace-sheet';
import { fonts } from '@/constants/fonts';
import { tide, tideSkies, withAlpha } from '@/constants/theme';
import type { LadderStageProps, SentenceHit } from '@/hooks/ladder/ladder-types';
import { useDir, useT } from '@/lib/i18n';
import { holdInlineXp } from '@/lib/level-up-store';
import { revealCard } from '@/lib/content-reveal';
import { loaderShown } from '@/lib/loading-overlay';
import { COUNT_IN_BEATS, LADDER_PACING } from '@/lib/pass-programme';

// Built to the picked mocks: scratchpad/stepbar/index.html figure A (the Stories
// bar with its label line) and scratchpad/session-layout/index.html figure 7
// (Focus: a dim chevron, the bar, the big centred sentence, one hint line, no
// buttons). Gestures on the body replace the dock and the pace sheet takes the
// chips. The sentence, the slot under it and the hint are one stable tree: a
// frame change remounts nothing (D53), the segment fill runs on the UI thread.

const HEADER_H = 48;
const TOP_H = 44;

/**
 * The ladder's stage view, laid over the player under its header: the top row,
 * the Stories bar and its label line, the centred sentence over its slot, the
 * hint, and the paused dim. Mounted by the island, video and podcast players
 * for the ladder; once the run is done the player's own dock is back. `top` is
 * the space above it: the island's own header by default, 0 under a native
 * header, the video's height under a video. `followsReveal` is for the island
 * player, the only one whose content fades in through lib/content-reveal.
 * `hidden` keeps it mounted at opacity 0 and untouchable. `ownsHeader` is for a
 * player whose header the stage covers (the island): it starts under the status
 * bar and draws the chevron (End) at the row's start, so one header is on screen.
 * `easy` is the host's Easy mark for the chip row (the island's). `still` is for a
 * stage that opens under a cover that already looks like it (the island after a
 * cube hop): no fade in. `onFitted` reports each line's sentence once it has its size.
 */
export const LadderStageView = memo(function LadderStageView({ top, ownsHeader, followsReveal, hidden, easy, still, onFitted, ...p }: LadderStageProps & { top?: number; ownsHeader?: boolean; followsReveal?: boolean; hidden?: boolean; easy?: { on: boolean; onPress: () => void }; still?: boolean; onFitted?: () => void }) {
  const insets = useSafeAreaInsets();
  const reduced = useReducedMotion();
  const { t } = useT();
  const dir = useDir();
  const { width } = useWindowDimensions();
  const [h, setH] = useState(0);
  const [bodyH, setBodyH] = useState(0);
  const frame = frameOf(p);
  const vis = useMemo(() => (p.finalOn ? [0, 1, 2, 3, FINAL, COMPARE] : [0, 1, 2, 3, COMPARE]), [p.finalOn]);
  const cur = Math.max(0, vis.indexOf(stepOf(p, frame)));
  const step = STEPS[vis[cur]!]!;
  const name = t(step.name);
  // Peek: the hidden text while the body is held.
  const [peek, setPeek] = useState(false);
  const [sheet, setSheet] = useState(false);
  const hasSheet = !!(p.onPace || p.onSpeed || p.chip);
  // The chips above the hint: each only where its host takes it; a hold on any opens the pace sheet.
  const speedChip = typeof p.speed === 'number' && Number.isFinite(p.speed) && p.onSpeed ? p.speed : null;
  const paceChip = p.pace && p.onPace ? p.pace : null;
  const hasChips = speedChip !== null || paceChip !== null || !!easy;
  // XP paid while the stage is up pops in its slot, not the toast.
  useEffect(() => holdInlineXp(), []);
  useEffect(() => setPeek(false), [p.textHidden, p.lineIndex, p.round]);
  const hintBottom = insets.bottom + 16;
  // The sentence's room: the body less the slot under it, the hint's line and the chips.
  const textMax = bodyH > 0 ? Math.max(1, bodyH - SCORE_H - SLOT_GAP - hintBottom - 36 - (hasChips ? CHIPS_H : 0)) : 0;
  // The gestures run on JS (`runOnJS`), so they read these captured values, never `p` on the UI thread.
  const { onStop, onRecord, onPause, onResume, onSkip, onPrev, onJump, onFinal, isRecording, textHidden } = p;
  const waiting = p.phase === 'waiting';
  const paused = !!p.paused;
  const last = cur === vis.length - 1;
  const nextStep = vis[cur + 1];
  const noMotion = !!reduced;
  // One stop per press: the hint's Pressable and the stage's tap can both see the same touch, so a second
  // stop inside 400ms is dropped. `stopped` keeps the dot and "Stopped" on screen for a moment.
  const [stopped, setStopped] = useState(false);
  const lastStop = useRef(0);
  const stopOnce = useMemo(
    () => () => {
      const now = Date.now();
      if (now - lastStop.current < 400) return;
      lastStop.current = now;
      setStopped(true);
      onStop?.();
    },
    [onStop],
  );
  // focus-stories D8: the sentence's word boxes (the tap's hit test, the panel's anchor) and the open panel's word.
  const hitRef = useRef<SentenceHit | null>(null);
  const [wordAt, setWordAt] = useState<number | null>(null);
  // The panel closes with its line (a render-time reset, like `countRun` below).
  const [wordLine, setWordLine] = useState(p.lineIndex);
  if (wordLine !== p.lineIndex) {
    setWordLine(p.lineIndex);
    setWordAt(null);
  }
  const closeWord = useMemo(
    () => () => {
      setWordAt(null);
      onResume?.();
    },
    [onResume],
  );
  // focus-stories D9: the step list, open at the step chip's centre x; the chip's tap is the forward rule
  // (recording: stop; the last step: the next line; else the next step).
  const [stepList, setStepList] = useState<number | null>(null);
  const forward = useMemo(
    () => () => {
      if (isRecording) stopOnce();
      else if (last) onSkip?.();
      else if (nextStep !== undefined) jumpStep(onJump, onFinal, nextStep);
    },
    [isRecording, stopOnce, last, onSkip, nextStep, onJump, onFinal],
  );
  // focus-stories D3/D4: the cube's pan and its finger-driven x, raced against the hold and the tap.
  const cube = useCubePan({ width, neighbours: p.neighbours, onHop: p.onHop, noMotion });
  const { gesture } = useBodyGesture({ stopOnce, onRecord, onPause, onSkip, onPrev, onJump, isRecording, textHidden, waiting, paused, setPeek, cube: cube.pan, hitTestRef: hitRef, wordAt, onWord: p.word ? setWordAt : undefined, onResume });
  // The count-in starts with the hint's "get ready": the announce, then the beats. The sentence dims
  // as the announce starts and the band sweeps once over the announce and all the beats, so the
  // count-in lasts as long as before. The phase alone decides it: the first frame of a stage that
  // mounts in 'count' has no beat yet, and the sentence must already be dimming then.
  const counting = p.phase === 'announce' || p.phase === 'count';
  const pacing = LADDER_PACING[p.pace ?? 'steady'];
  const sweepMs = p.phase === 'announce' ? pacing.announceMs + COUNT_IN_BEATS * pacing.beatMs : (p.beat ?? COUNT_IN_BEATS) * pacing.beatMs;
  // A new announce (a jump mid-count to another step) restarts the dim and the sweep.
  const [countRun, setCountRun] = useState({ phase: p.phase, n: 0 });
  if (countRun.phase !== p.phase) setCountRun({ phase: p.phase, n: p.phase === 'announce' ? countRun.n + 1 : countRun.n });
  const { countP, cueOn } = useCountClock({ counting, countRun: countRun.n, countMs: sweepMs });
  // The paused dim over the body only: the top row and the bar stay live under it.
  // A hold (D5) and the word panel (D8) pause without the dim and the pills: only the middle tap's pause dims.
  const softPause = peek || wordAt !== null;
  const { dimStyle, chipsStyle } = usePausedDim(paused && !softPause);
  const lines = typeof p.lineCount === 'number' && p.lineCount > 0;
  // Mounted while the root loader is still drawn (a session opening on a network wait): the stage's
  // opaque sky covers the player at once, and its content stays hidden until the loader has faded,
  // then shows at once, so the loader never draws over it or over the player's own line.
  const [behindLoader] = useState(() => loaderShown.value > 0.01);
  // Mounted while the player's own content is still fading in (a session opening straight into
  // the stage): no fade of its own, the opaque stage covers that content at once instead of
  // crossfading over it. Only the island's content reveals that way: the video and podcast players
  // never reset the shared reveal, so after an island's back fade it still reads 0 there.
  const [overReveal] = useState(() => followsReveal === true && revealCard.value < 0.99);
  const gate = useSharedValue(behindLoader ? 1 : 0);
  useAnimatedReaction(
    () => loaderShown.value,
    (v) => {
      if (gate.value === 1 && !(v > 0.01)) gate.value = 0;
    },
  );
  const gateStyle = useAnimatedStyle(() => ({ opacity: gate.value === 1 ? 0 : 1 }));
  return (
    <Animated.View
      entering={reduced || behindLoader || overReveal || still ? undefined : FadeIn.duration(220).easing(OUT)}
      exiting={reduced ? undefined : FadeOut.duration(180)}
      onLayout={(e) => setH(e.nativeEvent.layout.height || 0)}
      pointerEvents={hidden ? 'none' : 'auto'}
      style={[
        styles.root,
        { backgroundColor: tideSkies.night[0], top: top ?? insets.top + HEADER_H },
        ownsHeader && { paddingTop: insets.top },
        hidden && styles.hiddenRoot,
      ]}>
      <Animated.View style={[styles.fill, gateStyle]}>
        {/* focus-stories D4: the cube turns this whole tree to a neighbour island. */}
        <CubeStage cubeX={cube.cubeX} sides={cube.sides} width={width} neighbours={p.neighbours} noMotion={noMotion} sky={<StageSky />}>
          {/* Mock 7 `.hdr`: the dim chevron (End) at the start, `?` at the end, no title. */}
          <View style={[styles.top, dir.row]}>
            {ownsHeader ? (
              <Pressable onPress={p.onEnd} hitSlop={10} accessibilityRole="button" accessibilityLabel={t('ladder.end')} style={({ pressed }) => [styles.chev, pressed && { opacity: 0.7 }]}>
                <Text style={styles.chevGlyph}>{dir.rtl ? '›' : '‹'}</Text>
              </Pressable>
            ) : (
              <View />
            )}
            <View style={[styles.icons, dir.row]}>
              {p.onHelp ? <LadderHelpButton onPress={p.onHelp} /> : null}
            </View>
          </View>
          <StepBar p={p} vis={vis} cur={cur} tint={step.look.tint} />
          {/* focus-stories D10: one dot per sentence under the bar. */}
          {lines ? <SentenceDots index={p.lineIndex ?? 0} count={p.lineCount ?? 0} tint={step.look.tint} /> : null}
          {/* Mock A `.lab`: "Mumble · 2 of 5" at the start, "Line 2 / 7" at the end. */}
          <View style={[styles.lab, dir.row]}>
            <Text style={[styles.labDim, dir.text]} numberOfLines={1}>
              <Text style={styles.labName}>{name}</Text>
              {` · ${t('ladder.stepCount', { n: cur + 1, total: vis.length })}`}
            </Text>
            {lines ? <Text style={[styles.labDim, styles.tabular, dir.text]}>{t('ladder.lineSlash', { n: (p.lineIndex ?? 0) + 1, total: p.lineCount ?? 0 })}</Text> : null}
          </View>
          <GestureDetector gesture={gesture}>
            <View style={styles.body} onLayout={(e) => setBodyH(Math.round(e.nativeEvent.layout.height) || 0)}>
              <View style={styles.centre}>
                {/* A direct child of the centre (no wrapper), so the sentence's word boxes land in body coordinates (D8). */}
                {textMax > 0 ? <Sentence p={p} frame={frame} hidden={textHidden && !peek} maxH={textMax} counting={counting} countRun={countRun.n} tint={step.look.tint} sweepMs={sweepMs} hitRef={hitRef} onFitted={onFitted} /> : null}
                {/* focus-stories D5: the translation while the body is held. A zero-height anchor right under the sentence, so the text sits in the score slot's room and never moves anything. */}
                <View style={{ width: width - 48, height: 0 }} pointerEvents="none">
                  <TranslationSlot text={p.translation} shown={peek} width={width - 48} />
                  <CountHairline tint={step.look.tint} countP={countP} cueOn={cueOn} />
                </View>
                {/* The slot never changes height, so the sentence never jumps: the live meter or the score, empty through the count. */}
                {/* The translation takes this slot's room while held: the slot hides (same height), so the two never overlap. */}
                <View style={{ opacity: peek && p.translation ? 0 : 1 }}>
                  <ScoreSlot isRecording={isRecording} level={p.level} score={p.score} />
                </View>
              </View>
              <StageHint p={p} frame={frame} name={name} hintBottom={hintBottom} isRecording={isRecording} stopped={stopped} stopOnce={stopOnce} setStopped={setStopped} />
              <PausedLayer paused={paused && !softPause} dimStyle={dimStyle} hintBottom={hintBottom} onResume={p.onResume} onEnd={p.onEnd} />
              {/* focus-stories D8: the word panel under the tapped word, over everything in the body. */}
              {p.word ? <WordPanelLayer p={p} wordAt={wordAt} hitRef={hitRef} onClose={closeWord} bodyW={width} bodyH={bodyH} clearBottom={hintBottom + 31 + (hasChips ? CHIPS_H : 0) + 8} /> : null}
            </View>
          </GestureDetector>
          {/* Mock `.mini`, directly above the hint's 44pt target. Outside the body's detector, so a chip tap never pauses the stage. */}
          {hasChips ? (
            <StageChips speedChip={speedChip} paceChip={paceChip} easy={easy} onSpeed={p.onSpeed} onPace={p.onPace} onLong={() => setSheet(true)} hintBottom={hintBottom} paused={paused} chipsStyle={chipsStyle} stepName={name} onStep={forward} onStepHold={setStepList} />
          ) : null}
        </CubeStage>
      </Animated.View>
      {/* focus-stories D9: the step list over the stage root, anchored at the step chip. */}
      <StepList
        open={stepList !== null}
        vis={vis}
        cur={cur}
        anchorX={stepList ?? 0}
        anchorTop={h - (hintBottom + 31) - CHIPS_H}
        parentWidth={width}
        onPick={(s) => {
          jumpStep(onJump, onFinal, s);
          setStepList(null);
        }}
        onClose={() => setStepList(null)}
      />
      {hasSheet ? <PaceSheet open={sheet} onClose={() => setSheet(false)} pace={p.pace} onPace={p.onPace} speed={p.speed} onSpeed={p.onSpeed} chip={p.chip} /> : null}
    </Animated.View>
  );
});

const styles = StyleSheet.create({
  // Opaque and clipped: nothing of the player under it shows or pokes through.
  root: { position: 'absolute', left: 0, right: 0, bottom: 0, zIndex: 20, elevation: 20, overflow: 'hidden' },
  hiddenRoot: { opacity: 0 },
  fill: { flex: 1 },
  top: { height: TOP_H, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 16 },
  chev: { minWidth: 26, height: 30, justifyContent: 'center' },
  chevGlyph: { fontSize: 26, lineHeight: 30, color: withAlpha(tide.text, 0.36) },
  icons: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  lab: { marginTop: 8, marginHorizontal: 16, flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', gap: 12 },
  labName: { fontFamily: fonts.uiMedium, fontWeight: '600', color: tide.text },
  labDim: { fontFamily: fonts.ui, fontSize: 13, color: tide.textDim, flexShrink: 1 },
  tabular: { fontVariant: ['tabular-nums'] },
  body: { flex: 1 },
  centre: { flex: 1, alignItems: 'center', justifyContent: 'center' },
});
