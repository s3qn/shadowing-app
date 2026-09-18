import { StyleSheet, View } from 'react-native';
import Animated, {
  Easing,
  Extrapolation,
  interpolate,
  useAnimatedStyle,
  useFrameCallback,
  useReducedMotion,
  useSharedValue,
  type SharedValue,
} from 'react-native-reanimated';
import { useEffect } from 'react';

import { fonts } from '@/constants/fonts';

/** A finite number or the fallback. Every value below reaches a Reanimated
 * style on the UI thread, where a NaN throws and exits Expo Go with no red
 * box (see `cat-constellation.tsx`). */
export function finiteOr(x: number, fallback: number) {
  'worklet';
  return Number.isFinite(x) ? x : fallback;
}

/** Positive modulo: keeps a repeating phase in `[0, period)` even while
 * `now - delay` is still negative, just after mount. */
export function phase(now: number, delay: number, period: number) {
  'worklet';
  return finiteOr((((now - delay) % period) + period) % period, 0);
}

/** A UI-thread millisecond clock for one mounted step's effects, frozen at 0
 * under reduced motion and stopped when the step unmounts. Every effect below
 * derives its motion from this one clock instead of its own timers, so nothing
 * here is per-frame JS. The microphone step's rings (`mic-art.tsx`) run on the
 * same three helpers. */
export function useEffectClock(reducedMotion: boolean) {
  const now = useSharedValue(0);
  const frame = useFrameCallback((info) => {
    now.value = finiteOr(info.timeSinceFirstFrame, 0);
  }, false);
  useEffect(() => {
    frame.setActive(!reducedMotion);
    if (reducedMotion) now.value = 0;
    return () => frame.setActive(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reducedMotion]);
  return now;
}

// ---------------------------------------------------------------- Listen --

const LISTEN_SYLLABLES = ['ka', 'ño', 'ra', '시', 'mu', 'lá'];
const LISTEN_DY = [-14, -4, 8, -10, 2, 12];
const LISTEN_PERIOD = 1600;
const LISTEN_MOVE = 800;

function ListenSyllable({
  text,
  dy,
  delay,
  colour,
  a,
  now,
}: {
  text: string;
  dy: number;
  delay: number;
  colour: string;
  a: number;
  now: SharedValue<number>;
}) {
  const style = useAnimatedStyle(() => {
    const t = phase(now.value, delay, LISTEN_PERIOD);
    const raw = Math.min(t / LISTEN_MOVE, 1);
    const visible = t < LISTEN_MOVE;
    const eased = Easing.in(Easing.quad)(raw);
    const x = 140 + (0.35 * a - 140) * eased;
    const y = -dy * eased;
    const scale = 1.1 + (0.2 - 1.1) * eased;
    const opacity = visible ? (raw < 0.15 ? raw / 0.15 : 1 - (raw - 0.15) / 0.85) : 0;
    return {
      opacity: finiteOr(Math.max(0, Math.min(1, opacity)), 0),
      transform: [
        { translateX: finiteOr(x, 0) },
        { translateY: finiteOr(y, 0) },
        { scale: finiteOr(scale, 1) },
      ],
    };
  });
  return (
    <Animated.Text style={[styles.syllable, { color: colour, textShadowColor: colour }, style]}>
      {text}
    </Animated.Text>
  );
}

function HitRing({ delay, colour, a, now }: { delay: number; colour: string; a: number; now: SharedValue<number> }) {
  const period = 400;
  const style = useAnimatedStyle(() => {
    const t = phase(now.value, delay, period);
    const p = t / period;
    const scale = 0.5 + (1.9 - 0.5) * Easing.out(Easing.quad)(p);
    const opacity = 0.9 * (1 - p);
    return {
      opacity: finiteOr(opacity, 0),
      transform: [{ scale: finiteOr(scale, 1) }],
    };
  });
  const d = 0.55 * a;
  return (
    <Animated.View
      pointerEvents="none"
      style={[styles.hitRing, { width: d, height: d, borderRadius: d / 2, borderColor: colour }, style]}
    />
  );
}

/** Six syllables shoot from off-stage into the ear on a fast beat, each with
 * a flash ring at the moment of impact. Nothing renders under reduced
 * motion: the Lottie ear (paused at rest) is the only art left. */
export function ListenEffect({ colour, a }: { colour: string; a: number }) {
  const reducedMotion = useReducedMotion();
  const now = useEffectClock(reducedMotion);
  if (reducedMotion) return null;
  return (
    <>
      {LISTEN_SYLLABLES.map((text, i) => (
        <ListenSyllable key={text + i} text={text} dy={LISTEN_DY[i]} delay={i * 130} colour={colour} a={a} now={now} />
      ))}
      <HitRing delay={0} colour={colour} a={a} now={now} />
      <HitRing delay={200} colour={colour} a={a} now={now} />
    </>
  );
}

// ---------------------------------------------------------------- Mumble --

const WHISPER_TEXT = ['mm', 'hm', 'la'];
const WHISPER_TARGETS: readonly (readonly [number, number])[] = [
  [18, -40],
  [30, -26],
  [8, -48],
];

function MumbleDot({ index, colour, a, now }: { index: number; colour: string; a: number; now: SharedValue<number> }) {
  const period = 900;
  const style = useAnimatedStyle(() => {
    const t = phase(now.value, index * 150, period);
    const p = t / period;
    const lift = p < 0.5 ? -3 * (p / 0.5) : -3 * (1 - (p - 0.5) / 0.5);
    const opacity = p < 0.5 ? 0.2 + 0.7 * (p / 0.5) : 0.9 - 0.7 * ((p - 0.5) / 0.5);
    return {
      opacity: finiteOr(opacity, 0.2),
      transform: [{ translateX: finiteOr(0.42 * a + index * 8, 0) }, { translateY: finiteOr(-3 + lift, 0) }],
    };
  });
  return <Animated.View pointerEvents="none" style={[styles.mumbleDot, { backgroundColor: colour }, style]} />;
}

function Whisper({ index, colour, a, now }: { index: number; colour: string; a: number; now: SharedValue<number> }) {
  const period = 3000;
  const [tx, ty] = WHISPER_TARGETS[index];
  const style = useAnimatedStyle(() => {
    const t = phase(now.value, index * 1000, period);
    const p = t / period;
    const eased = Easing.out(Easing.quad)(p);
    const x = 0.4 * a + (tx - 0.4 * a) * eased;
    const y = ty * eased;
    const opacity = p < 0.3 ? 0.6 * (p / 0.3) : 0.6 * (1 - (p - 0.3) / 0.7);
    return {
      opacity: finiteOr(Math.max(0, opacity), 0),
      transform: [{ translateX: finiteOr(x, 0) }, { translateY: finiteOr(y, 0) }],
    };
  });
  return (
    <Animated.Text style={[styles.whisper, { color: colour, textShadowColor: colour }, style]}>
      {WHISPER_TEXT[index]}
    </Animated.Text>
  );
}

/** Three humming dots by the lips, plus three tiny whispers drifting away.
 * Nothing renders under reduced motion. */
export function MumbleEffect({ colour, a }: { colour: string; a: number }) {
  const reducedMotion = useReducedMotion();
  const now = useEffectClock(reducedMotion);
  if (reducedMotion) return null;
  return (
    <>
      {[0, 1, 2].map((i) => (
        <MumbleDot key={i} index={i} colour={colour} a={a} now={now} />
      ))}
      {[0, 1, 2].map((i) => (
        <Whisper key={i} index={i} colour={colour} a={a} now={now} />
      ))}
    </>
  );
}

// ------------------------------------------------------------ Read along --

function ReadAlongWord({
  word,
  index,
  total,
  colour,
  now,
}: {
  word: string;
  index: number;
  total: number;
  colour: string;
  now: SharedValue<number>;
}) {
  const style = useAnimatedStyle(() => {
    const active = Math.floor(finiteOr((now.value / 700) % total, 0)) === index;
    return {
      color: active ? colour : 'rgba(236,232,244,0.45)',
      borderBottomColor: active ? colour : 'transparent',
    };
  });
  return (
    <Animated.Text style={[styles.readWord, style]}>
      {word}
    </Animated.Text>
  );
}

/** The learning-language sentence, lit one word at a time from one shared
 * clock. Under reduced motion every word renders unlit and still. */
export function ReadAlongRow({ words, colour }: { words: string[]; colour: string }) {
  const reducedMotion = useReducedMotion();
  const now = useEffectClock(reducedMotion);
  return (
    <>
      {words.map((word, i) => (
        <ReadAlongWord key={i} word={word} index={i} total={words.length} colour={colour} now={now} />
      ))}
    </>
  );
}

// ---------------------------------------------------------------- Shadow --

const BUBBLES: readonly { text: string; bg: string }[] = [
  { text: 'こんにちは', bg: '#E8506A' },
  { text: 'Hola', bg: '#F0964A' },
  { text: 'Bonjour', bg: '#3FB585' },
  { text: '안녕', bg: '#9A73E8' },
  { text: 'Hello', bg: '#4A8FCF' },
];
const BUBBLE_PERIOD = 3500;
const BX = [0, 0.08, 0.12, 0.5, 0.62];
const BX_X = [-6, 0, 2, 22, 26];
const BX_Y = [10, 0, -3, -58, -72];
const BX_SCALE_IN = [0, 0.08, 0.12, 0.62];
const BX_SCALE_OUT = [0.4, 1.12, 1.0, 0.9];
const BX_OPACITY_IN = [0, 0.08, 0.5, 0.62, 1];
const BX_OPACITY_OUT = [0, 1, 1, 0, 0];

function ShadowBubble({ index, a, now }: { index: number; a: number; now: SharedValue<number> }) {
  const bubble = BUBBLES[index];
  const style = useAnimatedStyle(() => {
    const t = phase(now.value, index * 700, BUBBLE_PERIOD);
    const p = t / BUBBLE_PERIOD;
    const x = 0.3 * a + interpolate(p, BX, BX_X, Extrapolation.CLAMP);
    const y = -10 + interpolate(p, BX, BX_Y, Extrapolation.CLAMP);
    const scale = interpolate(p, BX_SCALE_IN, BX_SCALE_OUT, Extrapolation.CLAMP);
    const opacity = interpolate(p, BX_OPACITY_IN, BX_OPACITY_OUT, Extrapolation.CLAMP);
    return {
      opacity: finiteOr(opacity, 0),
      transform: [{ translateX: finiteOr(x, 0) }, { translateY: finiteOr(y, 0) }, { scale: finiteOr(scale, 1) }],
    };
  });
  return (
    <Animated.View pointerEvents="none" style={[styles.bubble, { backgroundColor: bubble.bg }, style]}>
      <Animated.Text style={styles.bubbleText}>{bubble.text}</Animated.Text>
    </Animated.View>
  );
}

/** Five language bubbles rising from the speaking head. Nothing renders
 * under reduced motion. */
export function ShadowBubbles({ a }: { a: number }) {
  const reducedMotion = useReducedMotion();
  const now = useEffectClock(reducedMotion);
  if (reducedMotion) return null;
  return (
    <>
      {BUBBLES.map((_, i) => (
        <ShadowBubble key={i} index={i} a={a} now={now} />
      ))}
    </>
  );
}

const BAR_HEIGHTS = [6, 14, 22, 10, 18, 26, 12, 20, 8, 16, 24, 14, 10, 18];
const BAR_PERIOD = 900;
const BAR_STAGGER = 60;

function WaveBar({
  index,
  height,
  colour,
  lagMs,
  now,
}: {
  index: number;
  height: number;
  colour: string;
  lagMs: number;
  now: SharedValue<number>;
}) {
  const style = useAnimatedStyle(() => {
    const t = phase(now.value, index * BAR_STAGGER + lagMs, BAR_PERIOD);
    const p = t / BAR_PERIOD;
    const scaleY = p < 0.5 ? 0.6 + 0.4 * (p / 0.5) : 1 - 0.4 * ((p - 0.5) / 0.5);
    return { transform: [{ scaleY: finiteOr(scaleY, 0.6) }] };
  });
  return <Animated.View style={[styles.bar, { height, backgroundColor: colour }, style]} />;
}

/** One waveform lane with each bar pulsing on a staggered beat. Used for the
 * "voice" lane (`lagMs=0`) and the trailing "you" lane (`lagMs=250`) in the
 * Shadow pass. Static bars (no beat) under reduced motion. */
export function WaveLane({ colour, opacity = 1, lagMs = 0 }: { colour: string; opacity?: number; lagMs?: number }) {
  const reducedMotion = useReducedMotion();
  const now = useEffectClock(reducedMotion);
  return (
    <Animated.View style={[styles.lane, { opacity }]}>
      {BAR_HEIGHTS.map((h, i) =>
        reducedMotion ? (
          <Animated.View key={i} style={[styles.bar, { height: h, backgroundColor: colour }]} />
        ) : (
          <WaveBar key={i} index={i} height={h} colour={colour} lagMs={lagMs} now={now} />
        ),
      )}
    </Animated.View>
  );
}

// --------------------------------------------------------------- Compare --

function CompareLane({
  colour,
  now,
  sign,
}: {
  colour: string;
  now: SharedValue<number>;
  sign: 1 | -1;
}) {
  const period = 3000;
  const style = useAnimatedStyle(() => {
    const p = phase(now.value, 0, period) / period;
    // 0 at 0%, ramp to the full 12pt by 20%, hold to 80%, back to 0 by 100%.
    let k = 0;
    if (p < 0.2) k = p / 0.2;
    else if (p < 0.55) k = 1;
    else if (p < 0.8) k = 1 - (p - 0.55) / 0.25;
    else k = 0;
    const eased = Easing.inOut(Easing.sin)(k);
    return { transform: [{ translateY: finiteOr(sign * 12 * eased, 0) }] };
  });
  return (
    <Animated.View style={style}>
      <WaveLane colour={colour} />
    </Animated.View>
  );
}

/** The two Compare waveforms sliding together: the voice lane drifts down,
 * the "you" lane drifts up by the same amount, on one slow loop. Bars stay
 * still under reduced motion (`WaveLane` handles that itself). */
export function CompareLanes({ topColour, bottomColour }: { topColour: string; bottomColour: string }) {
  const reducedMotion = useReducedMotion();
  const now = useEffectClock(reducedMotion);
  return (
    <View style={styles.compareStack}>
      <CompareLane colour={topColour} now={now} sign={1} />
      <CompareLane colour={bottomColour} now={now} sign={-1} />
    </View>
  );
}

const styles = StyleSheet.create({
  syllable: { position: 'absolute', fontFamily: fonts.uiMedium, fontSize: 17, fontWeight: '800', textShadowRadius: 10 },
  hitRing: { position: 'absolute', borderWidth: 2 },
  mumbleDot: { position: 'absolute', width: 5, height: 5, borderRadius: 3 },
  whisper: { position: 'absolute', fontFamily: fonts.uiMedium, fontSize: 10, textShadowRadius: 3 },
  readWord: { fontFamily: fonts.uiMedium, fontSize: 18, borderBottomWidth: 2 },
  bubble: {
    position: 'absolute',
    paddingHorizontal: 9,
    paddingVertical: 4,
    borderRadius: 12,
    borderBottomLeftRadius: 3,
    boxShadow: '0 4 12 rgba(0,0,0,0.35)',
  },
  bubbleText: { fontFamily: fonts.uiMedium, fontSize: 13, fontWeight: '800', color: '#FFFFFF' },
  lane: { flexDirection: 'row', alignItems: 'flex-end', gap: 2, height: 26 },
  bar: { width: 6, borderRadius: 2 },
  compareStack: { gap: 24 },
});
