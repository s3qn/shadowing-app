// The stage stamp (plan stage-stamp, board V6 "Stamp Becomes Stop"): the layer over the
// ladder body that drops one emoji plate on each listening step and parks it as a chip
// under the bar, and on the Shadow and Final take steps drops the red seal (`StageHint`)
// that slides down and becomes the stop button. The layer mounts once with the stage: a
// step edge fades what is on screen out (150ms), commits the next step's content while
// the part is off screen, and lets the UI thread run the fall, squash, rings, park and
// travel. JS only commits, starts the travel on the count's edge, and fires the haptic.
import { useCallback, useEffect, useRef, useState } from 'react';
import { type LayoutChangeEvent, type StyleProp, StyleSheet, Text, View, type ViewStyle } from 'react-native';
import Animated, { type AnimatedStyle, cancelAnimation, Easing, type SharedValue, useAnimatedReaction, useAnimatedStyle, useReducedMotion, useSharedValue, withDelay, withRepeat, withSequence, withSpring, withTiming } from 'react-native-reanimated';
import { scheduleOnRN } from 'react-native-worklets';

import { fin, GLASS, SEAL, SEAL_RED, type SealActive, StageHint } from '@/components/tide/ladder/stage-hint';
import { isRecordingStep, STAMPS, STEPS } from '@/components/tide/ladder/stage-model';
import { fonts } from '@/constants/fonts';
import { withAlpha } from '@/constants/theme';
import { devStampSlow } from '@/lib/dev-simulate';
import { hapticImpact } from '@/lib/haptics';
import { useDir, useT } from '@/lib/i18n';

export type StageStampProps = {
  stepIndex: number; // STEPS index on screen now (vis[cur])
  stageKey: string;
  isRecording: boolean;
  stopped: boolean;
  waiting: boolean;
  counting: boolean;
  countRun: number;
  countMs: number;
  stopOnce: () => void;
  setStopped: (v: boolean) => void;
  onRecord?: () => void;
  width: number;
  hintBottom: number;
  chipY: number;
  still?: boolean;
  gate: SharedValue<number>;
  chipsStyle: StyleProp<AnimatedStyle<ViewStyle>>;
};

/** The plate's height; the parked chip is 32pt of it. */
const PLATE_H = 84;
const PLATE_MIN_W = 168;
const CHIP = 32 / PLATE_H;
/** The fall's start, fully above the screen (the layer's top is under the status bar). */
const FROM = -400;
/** The slide to the stop slot starts this long after the count starts, clamped so the button is in place before the mic opens. */
const TRAVEL_LEAD = 650;
const TRAVEL_MAX = 1200;

const haptic = () => {
  void hapticImpact();
};

/** The park and travel spring (board: ratio 0.8, stiffness 220, mass 1), slowed `s` times for the dev key. */
function settle(s: number) {
  'worklet';
  return { stiffness: 220 / (s * s), damping: 23.73 / s, mass: 1 };
}

type Shown = { key: string; step: number; rec: boolean };

/** One Tide Drop ring at the stop slot: out-cubic growth to 1.8x, a linear fade from 0.4; hidden at rest. */
function useDropStyle(r: SharedValue<number>) {
  return useAnimatedStyle(() => {
    const v = fin(r.value);
    const grow = 1 - (1 - v) ** 3;
    return { opacity: v <= 0 || v >= 1 ? 0 : 0.4 * (1 - v), transform: [{ scale: 0.75 * (1 + 0.8 * grow) }] };
  });
}

export function StageStamp(props: StageStampProps) {
  const { stepIndex, stageKey, isRecording, stopped, waiting, counting, countRun, countMs, stopOnce, setStopped, onRecord, width, hintBottom, chipY, still, gate, chipsStyle } = props;
  const reduced = useReducedMotion();
  const { t } = useT();
  const dir = useDir();
  const rtl = dir.rtl;
  // What is drawn: it changes only at a commit, with the part off screen or at opacity 0.
  const [shown, setShown] = useState<Shown>(() => ({ key: stageKey, step: stepIndex, rec: isRecordingStep(stepIndex) }));
  const [layerH, setLayerH] = useState(0);
  const [plateW, setPlateW] = useState(PLATE_MIN_W);
  const rec = shown.rec;

  const goN = useSharedValue(0);
  const fired = useSharedValue(0);
  const hit = useSharedValue(0);
  const fall = useSharedValue(0);
  const sq = useSharedValue(0);
  const ring = useSharedValue(0);
  const park = useSharedValue(0);
  const travel = useSharedValue(0);
  const pulse = useSharedValue(0);
  const pulseOn = useSharedValue(0);
  const press = useSharedValue(0);
  const out = useSharedValue(1);
  const ct = useSharedValue(0);
  const cover = useSharedValue(still ? 1 : 0);
  const r1 = useSharedValue(0);
  const r2 = useSharedValue(0);
  const slow = useSharedValue(1);

  // Geometry in layer coordinates (centres); every motion is a transform from the rest centre.
  const rest = chipY + 100;
  const cx = width / 2;
  const stopY = layerH > 0 ? layerH - (hintBottom + 103) : rest;
  const startX = rtl ? width - 16 - (plateW * CHIP) / 2 : 16 + (plateW * CHIP) / 2;
  const dx = startX - cx;
  const dy = chipY - rest;

  const emoji = STAMPS[shown.step] ?? '';
  const word = t(STEPS[shown.step]!.name);
  const tint = STEPS[shown.step]!.look.tint;

  // A fade-out started by an edge whose commit has not landed yet.
  const fading = useRef(false);

  // Commit: the drawn step changed. Reset every clock with the part off screen, then go.
  // Declared before the edge effect: when the key moved again before this commit landed,
  // the edge's new fade-out must start after this reset, or the reset cancels it.
  useEffect(() => {
    fading.current = false;
    const s = devStampSlow();
    slow.set(s);
    for (const v of [fall, sq, ring, park, travel, press, out, pulse]) cancelAnimation(v);
    fall.set(0);
    sq.set(0);
    ring.set(0);
    park.set(0);
    travel.set(0);
    press.set(0);
    pulse.set(0);
    pulse.set(reduced ? 0.35 : withRepeat(withTiming(1, { duration: 1400 * s, easing: Easing.linear }), -1, false));
    if (reduced) {
      // No fall: the end state fades in from scale 0.96 (the travel effect sets the seal's end).
      fired.set(goN.get());
      hit.set(goN.get());
      fall.set(1);
      park.set(shown.rec ? 0 : 1);
      out.set(0);
      out.set(withTiming(1, { duration: 150 * s }));
    } else {
      out.set(1);
      goN.set(goN.get() + 1);
    }
  }, [shown, reduced, slow, fall, sq, ring, park, travel, press, out, pulse, fired, hit, goN]);

  // Edge: the step on screen is not the one drawn. Fade the part out, then commit. The
  // newest edge wins: a new key restarts the fade with its own commit, and a key back to
  // the drawn one cancels the pending commit and fades the part back in.
  useEffect(() => {
    const s = fin(slow.value, 1) || 1;
    if (stageKey === shown.key) {
      if (fading.current) {
        fading.current = false;
        cancelAnimation(out);
        out.set(withTiming(1, { duration: 150 * s }));
      }
      return;
    }
    const next: Shown = { key: stageKey, step: stepIndex, rec: isRecordingStep(stepIndex) };
    if (shown.rec && !next.rec && !reduced) {
      ct.set(0);
      ct.set(withTiming(1, { duration: 600 * s, easing: Easing.linear }));
    }
    fading.current = true;
    out.set(
      withTiming(0, { duration: 150 * s }, (done) => {
        'worklet';
        if (done) scheduleOnRN(setShown, next);
      }),
    );
  }, [stageKey, stepIndex, shown, reduced, slow, ct, out]);

  useEffect(() => {
    cover.set(still ? 1 : 0);
  }, [still, cover]);

  // The fall starts on the UI thread once the stage is uncovered (no hop cover, no root loader).
  useAnimatedReaction(
    () => [fin(goN.value), fin(gate.value), fin(cover.value)] as const,
    ([n, g, c]) => {
      if (n === fin(fired.value) || g !== 0 || c !== 0) return;
      fired.set(n);
      const s = fin(slow.value, 1) || 1;
      fall.set(withSpring(1, { stiffness: 260 / (s * s), damping: 17.7 / s, mass: 1 }));
      if (!rec) park.set(withDelay(1200 * s, withSpring(1, settle(s))));
    },
    [rec],
  );

  // Contact: the first frame the fall crosses 1. Squash, the contact ring, one light tap.
  useAnimatedReaction(
    () => fin(fall.value),
    (f, prev) => {
      if (f < 1 || (prev ?? 0) >= 1 || fin(hit.value) === fin(goN.value)) return;
      hit.set(fin(goN.value));
      const s = fin(slow.value, 1) || 1;
      sq.set(withSequence(withTiming(1, { duration: 80 * s, easing: Easing.out(Easing.quad) }), withTiming(0, { duration: 80 * s, easing: Easing.in(Easing.quad) })));
      ring.set(0);
      ring.set(withTiming(1, { duration: 480 * s, easing: Easing.linear }));
      scheduleOnRN(haptic);
    },
  );

  // The count's edge, so a commit that lands after it still times the travel from the count's start.
  const countAt = useRef(0);
  const countMsRef = useRef(countMs);
  useEffect(() => {
    countMsRef.current = countMs;
  }, [countMs]);
  useEffect(() => {
    if (counting) countAt.current = Date.now();
  }, [counting, countRun]);

  // Travel (recording steps): to the stop slot on the count, back to the band while waiting. Once per key.
  useEffect(() => {
    if (!rec) return;
    const s = fin(slow.value, 1) || 1;
    const spring = settle(s);
    if (waiting) {
      cancelAnimation(travel);
      if (travel.get() > 0) travel.set(reduced ? 0 : withSpring(0, spring));
      return;
    }
    const tr = fin(travel.get());
    if (isRecording) {
      if (tr !== 0) return;
      cancelAnimation(travel);
      travel.set(reduced ? 1 : withSpring(1, spring));
      return;
    }
    // A count started while the seal is still springing back from a cancelled count travels again.
    if (!counting || tr >= 1) return;
    const lead = Math.min(Math.max(countMsRef.current - TRAVEL_LEAD, 0), TRAVEL_MAX) * s;
    const delay = Math.max(0, lead - (Date.now() - countAt.current));
    travel.set(reduced ? 1 : withDelay(delay, withSpring(1, spring)));
  }, [shown.key, rec, counting, countRun, isRecording, waiting, reduced, slow, travel]);

  useEffect(() => {
    pulseOn.set(rec && (waiting || (isRecording && !stopped)) ? 1 : 0);
  }, [rec, waiting, isRecording, stopped, pulseOn]);

  // The pulse ring shows only at the band or the slot (StageHint); each time it turns on, its loop restarts from 0.
  useAnimatedReaction(
    () => {
      const tr = fin(travel.value);
      return fin(pulseOn.value) > 0.5 && (tr > 0.98 || tr < 0.02);
    },
    (on, prev) => {
      if (reduced || !on || prev !== false) return;
      const s = fin(slow.value, 1) || 1;
      cancelAnimation(pulse);
      pulse.set(0);
      pulse.set(withRepeat(withTiming(1, { duration: 1400 * s, easing: Easing.linear }), -1, false));
    },
    [reduced],
  );

  // The stop's bookkeeping (the composer's `stopped` is shared with the body's tap).
  useEffect(() => {
    if (isRecording) setStopped(false);
  }, [isRecording, setStopped]);
  useEffect(() => {
    if (!stopped) return;
    const id = setTimeout(() => setStopped(false), 900);
    return () => clearTimeout(id);
  }, [stopped, setStopped]);

  const active: SealActive = rec && isRecording && !stopped ? 'stop' : rec && waiting ? 'start' : 'off';
  const onSealPress = useCallback(() => {
    if (active === 'stop') {
      if (!reduced) {
        const s = fin(slow.value, 1) || 1;
        r1.set(0);
        r2.set(0);
        r1.set(withTiming(1, { duration: 480 * s, easing: Easing.linear }));
        r2.set(withDelay(90 * s, withTiming(1, { duration: 480 * s, easing: Easing.linear })));
      }
      stopOnce();
    } else if (active === 'start') {
      onRecord?.();
    }
  }, [active, reduced, slow, r1, r2, stopOnce, onRecord]);

  const onLayerLayout = useCallback((e: LayoutChangeEvent) => {
    const h = Math.round(e.nativeEvent.layout.height);
    setLayerH((prev) => (prev === h ? prev : h));
  }, []);
  const onPlateLayout = useCallback((e: LayoutChangeEvent) => {
    const w = Math.round(e.nativeEvent.layout.width);
    setPlateW((prev) => (prev === w || w <= 0 ? prev : w));
  }, []);

  const plateStyle = useAnimatedStyle(() => {
    const f = fin(fall.value);
    const k = fin(park.value);
    const q = fin(sq.value);
    const o = fin(out.value, 1);
    const soft = reduced ? 0.96 + 0.04 * o : 1;
    const s0 = 1.25 - 0.25 * f;
    return {
      opacity: rec ? 0 : o,
      transform: [
        { translateX: dx * k },
        { translateY: FROM * (1 - f) + dy * k },
        { rotate: `${-6 * (1 - k)}deg` },
        { scale: (s0 * (1 - k) + CHIP * k) * soft },
        { scaleX: 1 + 0.033 * q },
        { scaleY: 1 - 0.06 * q },
      ],
    };
  });

  // The contact ring: up to 0.5 over the first 60ms, then down over 420ms, growing out-cubic to 1.6.
  // Capped so a wide plate's ring stays 16pt inside each screen edge.
  const ringW = rec ? SEAL : plateW;
  const ringCap = ringW > 0 && width > 32 ? Math.max(1, Math.min(1.6, (width - 32) / ringW)) : 1.6;
  const ringStyle = useAnimatedStyle(() => {
    const r = fin(ring.value);
    const grow = 1 - (1 - r) ** 3;
    const o = r <= 0 || r >= 1 ? 0 : 0.5 * Math.min(r / 0.125, (1 - r) / 0.875);
    return { opacity: o, transform: [{ rotate: rec ? '0deg' : '-6deg' }, { scale: 1 + (fin(ringCap, 1.6) - 1) * grow }] };
  });

  const drop1 = useDropStyle(r1);
  const drop2 = useDropStyle(r2);

  // The contracting ring: from the stop slot up to the band as the button leaves.
  const ctStyle = useAnimatedStyle(() => {
    const c = fin(ct.value);
    const e = 1 - (1 - c) ** 3;
    return {
      opacity: c <= 0 || c >= 1 ? 0 : 0.6 * Math.min(Math.min(4 * c, 1), 1 - c),
      transform: [{ translateY: (stopY - rest) * (1 - e) }, { scale: 0.75 * (1 - 0.6 * e) }],
    };
  });

  const ringBox = rec ? { width: SEAL, height: SEAL, borderRadius: SEAL / 2, top: rest - SEAL / 2 } : { width: plateW, height: PLATE_H, borderRadius: 22, top: rest - PLATE_H / 2 };

  return (
    <Animated.View style={[styles.layer, chipsStyle]} pointerEvents="box-none" onLayout={onLayerLayout}>
      <View style={[styles.row, { top: rest - SEAL / 2 }]} pointerEvents="none">
        <Animated.View style={[styles.circle, { borderColor: SEAL_RED }, ctStyle]} />
      </View>
      <View style={[styles.row, { top: ringBox.top }]} pointerEvents="none">
        <Animated.View style={[styles.contact, { width: ringBox.width, height: ringBox.height, borderRadius: ringBox.borderRadius, borderColor: tint }, ringStyle]} />
      </View>
      <View style={[styles.row, { top: stopY - SEAL / 2 }]} pointerEvents="none">
        <Animated.View style={[styles.circle, { borderColor: SEAL_RED }, drop1]} />
        <Animated.View style={[styles.circle, styles.onTop, { borderColor: SEAL_RED }, drop2]} />
      </View>
      <View style={[styles.row, { top: rest - PLATE_H / 2 }]} pointerEvents="none">
        <Animated.View style={[styles.plate, dir.row, { borderColor: tint }, plateStyle]} onLayout={onPlateLayout}>
          <View style={[styles.plateInner, { borderColor: withAlpha(tint, 0.55) }]} pointerEvents="none" />
          <Text style={styles.emoji}>{emoji}</Text>
          <Text style={[styles.word, { color: withAlpha(tint, 0.92) }]}>{word}</Text>
        </Animated.View>
      </View>
      <StageHint
        fall={fall}
        sq={sq}
        out={out}
        travel={travel}
        press={press}
        pulse={pulse}
        pulseOn={pulseOn}
        emoji={emoji}
        word={word}
        active={active}
        onPress={onSealPress}
        rest={rest}
        stopY={stopY}
        rec={rec}
        reduced={reduced}
      />
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  layer: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0 },
  row: { position: 'absolute', left: 0, right: 0, alignItems: 'center' },
  circle: { width: SEAL, height: SEAL, borderRadius: SEAL / 2, borderWidth: 2 },
  onTop: { position: 'absolute', top: 0 },
  contact: { borderWidth: 2 },
  plate: {
    minWidth: PLATE_MIN_W,
    height: PLATE_H,
    borderRadius: 20,
    borderWidth: 3,
    backgroundColor: GLASS,
    paddingHorizontal: 20,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 12,
  },
  // Inset 4 from the plate's outer edge: an absolute child sits inside the 3pt border, so 1 from there.
  plateInner: { position: 'absolute', top: 1, left: 1, right: 1, bottom: 1, borderRadius: 14, borderWidth: 1.5 },
  emoji: { fontSize: 40, lineHeight: 48 },
  word: { fontFamily: fonts.ui, fontSize: 26, lineHeight: 30, fontWeight: '800', textTransform: 'uppercase', letterSpacing: 2 },
});
