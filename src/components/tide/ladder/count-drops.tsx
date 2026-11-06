// The Listen count-in (BL-106, Pre-Animator V2 "Ripple Lifts the Words", the board at
// research/pre-animator/countin-drops/index.html): a caption, three drops that fill on the
// beats, a beat ring each, the last drop's crouch, fall and flatten into the waterline, one
// flat ring and two wavelets along it. Every part is a pure worklet of the clock `tk` (recipe
// ms, from useCountClock); the words that rise under the wavelets are the live Sentence's
// units (RiseUnit in sentence.tsx). It lives in the zero-height anchor under the sentence and
// stays mounted for the whole session: a new line only restarts the clock.
import { Platform, StyleSheet, Text, View } from 'react-native';
import Animated, { useAnimatedStyle, type SharedValue } from 'react-native-reanimated';

import { clamp, IOS, lerp, OUT, springAt, wob } from '@/components/tide/ladder/clock-curves';
import { fin } from '@/components/tide/ladder/stage-hint';
import { ENTRY_MS, REST } from '@/components/tide/ladder/use-count-in';
import { fonts } from '@/constants/fonts';
import { tide, verb } from '@/constants/theme';
import { COUNT_DROPS } from '@/lib/pass-programme';

/** A drop's size and radius; the drops sit 40pt apart, the last one (the 1) falls at `cx + 40`. */
const D = 26;
const R = D / 2;
const GAP = 40;
const INK = verb.listen.c1;
const LIGHT = '#B7B1C6';
const DARK = '#0B1020';
const WAVE = 'linear-gradient(90deg, rgba(124,200,255,0), rgba(190,228,255,0.95), rgba(124,200,255,0))';
// react-native-web passes `backgroundImage` to CSS; native takes the experimental prop (the StageSky pattern).
const wave = Platform.select<object>({ web: { backgroundImage: WAVE }, default: { experimental_backgroundImage: WAVE } });

type Clock = {
  tk: SharedValue<number>;
  /** 1 while the count's parts may show; 0 for a count cancelled before anything entered (the words still rise). */
  shown: SharedValue<number>;
  reduced: boolean;
};

export type CountDropsProps = Clock & {
  /** The anchor's width: the sentence's width, `width - 48`. */
  innerW: number;
  /** The drops' centre line, in pt above the anchor (the sentence's bottom edge). */
  rise: number;
  /** The waterline, in pt below the anchor: the empty slot's centre. */
  water: number;
  beatMs: number;
  /** "Sentence n of m" or "Next sentence · n of m"; null on a host without lines. Never changes while visible. */
  caption: string | null;
};

export function CountDrops({ tk, shown, reduced, innerW, rise, water, beatMs, caption }: CountDropsProps) {
  const cx = innerW / 2;
  const impactX = cx + GAP;
  const y0 = -rise;
  const go = 3 * beatMs;
  const impact = go + COUNT_DROPS.impactMs;
  // The caption: in over 240ms with a 6pt rise as the drops enter, out over 200ms at go.
  const cap = useAnimatedStyle(() => {
    const t = fin(tk.value, REST);
    const on = fin(shown.value);
    if (reduced) return { opacity: on * clamp((t + 150) / 150) * (1 - clamp((t - go) / 150)), transform: [{ translateY: 0 }] };
    const ci = OUT((t + ENTRY_MS) / 240);
    const co = clamp((t - go) / 200);
    return { opacity: on * ci * (1 - co), transform: [{ translateY: 6 * (1 - ci) }] };
  });
  // The waterline (option A): a 1pt Tide waterline the drop has a surface to flatten into.
  const line = useAnimatedStyle(() => {
    const t = fin(tk.value, REST);
    const on = fin(shown.value);
    if (reduced) return { opacity: on * clamp((t + 150) / 150) * (1 - clamp((t - go) / 150)) };
    return { opacity: on * OUT((t + ENTRY_MS) / 240) * (1 - clamp((t - impact - 700) / 300)) };
  });
  // The flat ring opens on the waterline at the impact, 700ms OUT.
  const flat = useAnimatedStyle(() => {
    const t = fin(tk.value, REST) - impact;
    if (reduced || !(fin(shown.value) > 0) || t < 0 || t > 700) return { opacity: 0, transform: [{ scale: 0.4 }] };
    const k = OUT(t / 700);
    return { opacity: 0.5 * clamp(t / 80) * (1 - k), transform: [{ scale: lerp(0.4, 1.9, k) }] };
  });
  return (
    <>
      {caption !== null ? (
        <Animated.Text pointerEvents="none" numberOfLines={1} allowFontScaling={false} style={[styles.caption, { top: y0 - 38 - 9 }, cap]}>
          {caption}
        </Animated.Text>
      ) : null}
      <Animated.View pointerEvents="none" style={[styles.line, { top: water }, line]} />
      {[0, 1, 2].map((i) => (
        <Drop key={i} i={i} tk={tk} shown={shown} reduced={reduced} x={cx - GAP + GAP * i} y0={y0} water={water} beatMs={beatMs} />
      ))}
      <Animated.View pointerEvents="none" style={[styles.flat, { left: impactX - 30, top: water - 8 }, flat]} />
      <Wavelet dir={-1} tk={tk} shown={shown} reduced={reduced} impact={impact} impactX={impactX} water={water} />
      <Wavelet dir={1} tk={tk} shown={shown} reduced={reduced} impact={impact} impactX={impactX} water={water} />
    </>
  );
}

/**
 * One drop (the 3, the 2 or the 1): a rim that clips a disc growing from the centre on its
 * beat, the light numeral under it and the dark one over it. Drops 0 and 1 shrink away after
 * go; drop 2 crouches, falls with gravity and flattens into the waterline, its bottom kept on
 * the line. A beat ring opens at its rest position 40ms after the beat.
 */
function Drop({ i, tk, shown, reduced, x, y0, water, beatMs }: Clock & { i: number; x: number; y0: number; water: number; beatMs: number }) {
  const beat = i * beatMs;
  const go = 3 * beatMs;
  const impact = go + COUNT_DROPS.impactMs;
  const end = go + COUNT_DROPS.endMs;
  const leaveAt = go + 40 + 60 * i;
  const falls = i === 2;
  const body = useAnimatedStyle(() => {
    const t = fin(tk.value, REST);
    const on = fin(shown.value);
    if (!(t < end) || !(on > 0)) return { opacity: 0, transform: [{ translateY: 0 }, { scaleX: 1 }, { scaleY: 1 }] };
    if (reduced) return { opacity: on * clamp((t + 150) / 150) * (1 - clamp((t - go) / 150)), transform: [{ translateY: 0 }, { scaleX: 1 }, { scaleY: 1 }] };
    // Entry from scale 0, 60ms apart, times the fill's swell.
    const e = springAt(t + ENTRY_MS - 60 * i, 14, 260) * (1 + wob(t - beat, 0.12, 160, 280));
    let sx = e;
    let sy = e;
    let y = 0;
    if (!falls) {
      if (t >= leaveAt) {
        // Follow-through: shrinks to 0 (cubic in) and sinks 4pt.
        const k = clamp((t - leaveAt) / 240);
        sx = 1 - k * k * k;
        sy = sx;
        y = 4 * k;
      }
    } else if (t >= go - 140) {
      // Anticipation: a 5pt crouch and a squash over the 140ms before go.
      const a = t >= go ? 1 : IOS((t - (go - 140)) / 140);
      sx = 1 + 0.06 * a;
      sy = 1 - 0.08 * a;
      y = -5 * a;
      if (t >= go) {
        // Gravity (p squared) to the waterline, stretching on the way down.
        const p = clamp((t - go) / 260);
        y = -5 + (water - R - (y0 - 5)) * p * p;
        sy = lerp(0.92, 1.32, p);
        sx = lerp(1.06, 0.86, p);
      }
      if (t >= impact) {
        // Flattens into the water over 150ms; the bottom stays on the waterline, never a cut.
        const q = IOS((t - impact) / 150);
        sy = 1.32 * (1 - q);
        sx = 0.86 + 0.9 * q;
        y = water - R * 1.32 * (1 - q) - y0;
      }
    }
    return { opacity: on, transform: [{ translateY: y }, { scaleX: Math.max(0.001, sx) }, { scaleY: Math.max(0.001, sy) }] };
  });
  const disc = useAnimatedStyle(() => {
    const t = fin(tk.value, REST);
    if (reduced) return { opacity: clamp((t - beat) / 150), transform: [{ scale: 1 }] };
    return { opacity: 1, transform: [{ scale: Math.max(0.001, springAt(t - beat, 16, 260)) }] };
  });
  const dark = useAnimatedStyle(() => {
    const t = fin(tk.value, REST);
    if (reduced) return { opacity: clamp((t - beat) / 150) };
    return { opacity: clamp((springAt(t - beat, 16, 260) - 0.45) / 0.35) };
  });
  const ring = useAnimatedStyle(() => {
    const r = fin(tk.value, REST) - (beat + 40);
    if (reduced || !(fin(shown.value) > 0) || r < 0 || r > 620) return { opacity: 0, transform: [{ scale: 1 }] };
    const k = OUT(r / 620);
    return { opacity: 0.38 * clamp(r / 80) * (1 - k), transform: [{ scale: 1 + 1.3 * k }] };
  });
  const n = String(3 - i);
  return (
    <>
      <Animated.View pointerEvents="none" style={[styles.drop, { left: x - R, top: y0 - R }, body]}>
        <View style={styles.rim}>
          <Animated.View style={[styles.disc, disc]} />
          <Text style={[styles.num, styles.light]} allowFontScaling={false}>
            {n}
          </Text>
          <Animated.Text style={[styles.num, styles.dark, dark]} allowFontScaling={false}>
            {n}
          </Animated.Text>
        </View>
      </Animated.View>
      <Animated.View pointerEvents="none" style={[styles.ring, { left: x - R, top: y0 - R }, ring]} />
    </>
  );
}

/** A wavelet running out from the impact along the waterline at 0.9pt per ms, fading over 520ms. */
function Wavelet({ dir, tk, shown, reduced, impact, impactX, water }: Clock & { dir: -1 | 1; impact: number; impactX: number; water: number }) {
  const style = useAnimatedStyle(() => {
    const t = fin(tk.value, REST) - impact;
    if (reduced || !(fin(shown.value) > 0) || t < 0 || t > 520) return { opacity: 0, transform: [{ translateX: 0 }] };
    return { opacity: 0.9 * clamp(t / 60) * (1 - clamp(t / 520)), transform: [{ translateX: dir * 0.9 * t }] };
  });
  return <Animated.View pointerEvents="none" style={[styles.wave, wave, { left: impactX - 13, top: water - 2 }, style]} />;
}

const styles = StyleSheet.create({
  caption: { position: 'absolute', left: 0, right: 0, textAlign: 'center', fontFamily: fonts.ui, fontSize: 13, lineHeight: 18, letterSpacing: 0.26, color: LIGHT },
  line: { position: 'absolute', left: 0, right: 0, height: 1, backgroundColor: tide.waterline },
  drop: { position: 'absolute', width: D, height: D },
  // The rim clips the disc; the disc is a plain colour (never a gradient or shadow inside the clip).
  rim: { width: D, height: D, borderRadius: R, borderWidth: 1.5, borderColor: 'rgba(124,200,255,0.45)', overflow: 'hidden' },
  disc: { position: 'absolute', left: -1.5, top: -1.5, width: D, height: D, borderRadius: R, backgroundColor: INK },
  // Inside the rim's border: a 23pt box, the numeral centred in it. The text never changes.
  num: { position: 'absolute', left: 0, top: 0, right: 0, bottom: 0, textAlign: 'center', lineHeight: D - 3, fontFamily: fonts.ui, fontSize: 13, fontWeight: '600', fontVariant: ['tabular-nums'] },
  light: { color: LIGHT },
  dark: { color: DARK },
  ring: { position: 'absolute', width: D, height: D, borderRadius: R, borderWidth: 1.5, borderColor: INK },
  flat: { position: 'absolute', width: 60, height: 16, borderRadius: 999, borderWidth: 1.5, borderColor: INK },
  wave: { position: 'absolute', width: 26, height: 2, borderRadius: 1 },
});
