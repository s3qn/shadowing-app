import { useState } from 'react';
import { Skia } from '@shopify/react-native-skia';
import { type StyleProp, StyleSheet, Text, View, type ViewStyle, useWindowDimensions } from 'react-native';
import Animated, { type AnimatedStyle, type SharedValue, useAnimatedProps, useAnimatedStyle, useDerivedValue, useSharedValue } from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { StepAction, StepFrame } from '@/components/onboarding/step-frame';
import { TAIL_BOX, TAIL_TIP, TailMark, getTailPath } from '@/components/onboarding/tail-mark';
import { IOC, IOS, OUT, clamp, lerp, springAt } from '@/components/tide/ladder/clock-curves';
import { fin } from '@/components/tide/ladder/stage-hint';
import { fonts } from '@/constants/fonts';
import { Spacing, tide, verb } from '@/constants/theme';
import { useDir, useT } from '@/lib/i18n';

/** The route's clock (`hero-clock.ts`): `tk` is ms since mount, `tapT` the ms of the Get started tap, Infinity before it. */
export type HeroClock = { tk: SharedValue<number>; tapT: SharedValue<number> };

/** Bisect a silent Expo Go exit by turning parts off one at a time (memory `expo-go-worklet-crash`). */
const HERO_PARTS = { dots: true, curl: true, greetings: true, ring: true, words: true };

// Design units: the board's 390x844 frame, status bar included. The hero layer
// is its top 390x600, scaled down only on a screen too short for it.
const HERO_W = 390;
const HERO_H = 600;
// The head's sweep before the curl: six cubics from off-screen left to the curl's base at (147,443).
const LEAD_D =
  'M-20 262 C20 210 50 186 88 190 C126 194 160 170 195 168 C232 166 268 192 305 196 C345 200 352 252 330 290 C300 330 140 318 90 330 C70 345 146 480 147 443';
const CURL_AT = { x: 105, y: 245 };
const TIP = { x: CURL_AT.x + TAIL_TIP.x, y: CURL_AT.y + TAIL_TIP.y };
/** The flight's control point: the bead curves through here on its way to the kicker slot. */
const FLIGHT_CP = { x: 60, y: 240 };
/** The greetings and the point each one is centred on; literal strings, not i18n. */
const WORDS = [
  { x: 88, y: 160, text: 'こんにちは' },
  { x: 195, y: 138, text: 'שלום' },
  { x: 305, y: 166, text: 'hello' },
  { x: 322, y: 250, text: '¡hola!' },
  { x: 78, y: 302, text: 'bonjour' },
];
const WORDMARK_AT = 2400;
const TAGLINE_AT = WORDMARK_AT + 90;
const N_DOTS = 18;
const TABLE_N = 128;
const RING = 24;
const HEAD = 9;
/** The head settles to a 7pt bead at the tip; a scale of the 9pt head. */
const BEAD = 7 / 9;

function mixHex(a: string, b: string, k: number): string {
  const ch = (hex: string, i: number) => parseInt(hex.slice(1 + 2 * i, 3 + 2 * i), 16);
  return `rgb(${[0, 1, 2].map((i) => Math.round(lerp(ch(a, i), ch(b, i), k))).join(',')})`;
}
const DOT_SIZE = Array.from({ length: N_DOTS }, (_, k) => lerp(HEAD, 2.5, k / 17));
/** Speak red at the head through read amber to listen blue at the tail. */
const DOT_COLOUR = Array.from({ length: N_DOTS }, (_, k) => {
  const u = k / 17;
  return u < 0.5 ? mixHex(verb.speak.c1, verb.read.c1, u * 2) : mixHex(verb.read.c1, verb.listen.c1, (u - 0.5) * 2);
});
/** Render order: the tail first, so the head is on top. */
const DOT_ORDER = Array.from({ length: N_DOTS }, (_, i) => N_DOTS - 1 - i);
const EMPTY: number[] = [];

/** The head's track, measured once with Skia: a 128-point arc-length table of
 * the lead plus the curl (x,y pairs), its length `L`, where the curl starts
 * (`sc0`) and how long it is, and the ms the head passes each greeting. */
type Track = { table: number[]; L: number; sc0: number; curlLen: number; tw: number[] };
let trackCache: Track | null | undefined;
/** Null when Skia cannot build it (web without CanvasKit): the hero then shows the words and the pill only. */
function getTrack(): Track | null {
  if (trackCache === undefined) {
    try {
      trackCache = buildTrack();
    } catch {
      trackCache = null;
    }
  }
  return trackCache;
}
function buildTrack(): Track | null {
  const curl = getTailPath();
  const lead = Skia.Path.MakeFromSVGString(LEAD_D);
  if (!curl || !lead) return null;
  const path = lead.copy();
  // `extend`: the curl continues the lead's contour (both meet at 147,443), so one measure covers the whole track.
  path.addPath(curl, Skia.Matrix().translate(CURL_AT.x, CURL_AT.y), true);
  const whole = Skia.ContourMeasureIter(path, false, 1).next();
  const curlOnly = Skia.ContourMeasureIter(curl, false, 1).next();
  if (!whole || !curlOnly) return null;
  const L = whole.length();
  const curlLen = curlOnly.length();
  const table: number[] = [];
  for (let i = 0; i < TABLE_N; i++) {
    const [p] = whole.getPosTan((i / (TABLE_N - 1)) * L);
    table.push(p.x, p.y);
  }
  // When the head passes each greeting: the table point nearest it, then s(t) = L IOC((t-200)/2500) inverted by bisection.
  const tw = WORDS.map((w) => {
    let best = 0;
    let bd = Infinity;
    for (let i = 0; i < TABLE_N; i++) {
      const d = Math.hypot(table[2 * i] - w.x, table[2 * i + 1] - w.y);
      if (d < bd) {
        bd = d;
        best = (i / (TABLE_N - 1)) * L;
      }
    }
    let lo = 0;
    let hi = 1;
    for (let i = 0; i < 40; i++) {
      const m = (lo + hi) / 2;
      if (IOC(m) * L < best) lo = m;
      else hi = m;
    }
    return 200 + lo * 2500;
  });
  return { table, L, sc0: L - curlLen, curlLen, tw };
}

/** The per-frame scalars every part reads: the clock `t`, the tap `g` (Infinity
 * before it), `h` ms since the tap (-1 before it), the head's arc length `s`,
 * how much of the curl is drawn, the fold at 2.7s, the idle bead's ms `iu` (-1
 * when none runs), the tip ring's ms `rr` (-1 when none) and where the head
 * was at the tap (`ax`,`ay`), the start of its flight. */
type Frame = { t: number; g: number; h: number; s: number; curlEnd: number; fold: number; iu: number; rr: number; ax: number; ay: number };

/** The point `s` along the track, lerped between the two nearest table entries. */
function at(tb: number[], L: number, s: number): { x: number; y: number } {
  'worklet';
  if (tb.length < 4) return { x: 0, y: 0 };
  const u = clamp(s / L) * (TABLE_N - 1);
  const i = Math.min(TABLE_N - 2, Math.floor(u));
  const f = u - i;
  return { x: lerp(tb[2 * i], tb[2 * i + 2], f), y: lerp(tb[2 * i + 1], tb[2 * i + 3], f) };
}

/** Where the head was at the tap `g`: on the sweep, or on the idle bead's run (the tip once it has faded). */
function headAt(tb: number[], L: number, sc0: number, curlLen: number, g: number): { x: number; y: number } {
  'worklet';
  if (g > 3400) {
    const st = 3400 + Math.floor((g - 3400) / 3400) * 3400;
    if (st < g) return at(tb, L, Math.max(sc0, sc0 + curlLen * IOS((g - st) / 2200)));
  }
  return at(tb, L, L * IOC((g - 200) / 2500));
}

/** A line of copy rising in at `t0` (10pt, spring 16/200, opacity OUT 320ms) and leaving on the hand-off (board `wmStd`). */
function riseStyle(f: Frame, t0: number) {
  'worklet';
  const on = t0 < f.g;
  const k = on ? springAt(f.t - t0, 16, 200) : 0;
  const o = on ? OUT((f.t - t0) / 320) : 0;
  const ex = f.h >= 0 ? IOS((f.h - 40) / 240) : 0;
  return { opacity: fin(o * (1 - ex)), transform: [{ translateY: fin(10 * (1 - k) - 10 * ex) }] };
}

/** One of the 18 trail dots; k=0 is the head. Sweeps the track behind the
 * head, runs the curl with the idle bead, and flies to the kicker slot on
 * the hand-off (a quadratic from where the head was through `FLIGHT_CP`). */
function Dot({
  k,
  fr,
  table,
  L,
  sc0,
  curlLen,
  tx,
  ty,
}: {
  k: number;
  fr: SharedValue<Frame>;
  table: SharedValue<number[]>;
  L: number;
  sc0: number;
  curlLen: number;
  tx: number;
  ty: number;
}) {
  const size = DOT_SIZE[k];
  const style = useAnimatedStyle(() => {
    const f = fr.value;
    const tb = table.value;
    let o = lerp(1, 0.15, k / 17);
    let show = f.t > 200;
    let sc = 1;
    let x = 0;
    let y = 0;
    if (f.h >= 0) {
      const q = IOC((f.h - 14 * k) / 420);
      const u = 1 - q;
      x = u * u * f.ax + 2 * u * q * FLIGHT_CP.x + q * q * tx;
      y = u * u * f.ay + 2 * u * q * FLIGHT_CP.y + q * q * ty;
      if (k > 5) o *= 1 - clamp(f.h / 200);
      else if (k > 0) o *= 1 - clamp((f.h - 380) / 120);
      else sc = (1 - IOS((f.h - 420) / 120)) * BEAD;
    } else if (f.iu >= 0 && f.fold >= 1) {
      const p = at(tb, L, Math.max(sc0, sc0 + curlLen * IOS(f.iu / 2200) - 7 * k));
      x = p.x;
      y = p.y;
      if (k > 5) show = false;
      const life = clamp(f.iu / 200) * (1 - clamp((f.iu - 2700) / 300));
      o *= k === 0 ? life : clamp(1 - f.iu / 2200) * 0.8 * life;
      if (k === 0) sc = BEAD;
    } else {
      const sk = f.s - 10 * k * (1 - f.fold);
      if (sk < 0) show = false;
      const p = at(tb, L, sk);
      x = p.x;
      y = p.y;
      if (k > 0) o *= 1 - f.fold;
      else {
        // Untapped past the idle start: the head fades at the tip before the first idle bead takes over.
        if (f.g > 3400) o *= 1 - clamp((f.t - 3100) / 300);
        if (f.fold >= 1) sc = BEAD;
      }
    }
    return {
      opacity: show ? fin(o) : 0,
      // Scale floors at the board's .0001, never 0: the head leaves by scale alone at the end of its flight.
      transform: [{ translateX: fin(x - size / 2) }, { translateY: fin(y - size / 2) }, { scale: Math.max(0.0001, fin(sc, 1)) }],
    };
  });
  return <Animated.View style={[styles.dot, { width: size, height: size, borderRadius: size / 2, backgroundColor: DOT_COLOUR[k] }, style]} />;
}

/** A greeting: dark until the head passes it at `tw`, lit .95 settling to .6,
 * brightened again as each idle bead crosses, and faded 30ms apart on the hand-off. */
function Greeting({ i, tw, fr }: { i: number; tw: number; fr: SharedValue<Frame> }) {
  const w = WORDS[i];
  const style = useAnimatedStyle(() => {
    const f = fr.value;
    if (!(tw < f.g)) return { opacity: 0, transform: [{ translateY: 6 }] };
    const u = f.t - tw;
    let a = u < 0 ? 0 : u < 260 ? 0.95 * OUT(u / 260) : 0.95 - 0.35 * OUT((u - 260) / 900);
    if (f.iu >= 0 && f.fold >= 1) {
      const du = f.iu - 2200 * (i / 5 + 0.1);
      if (du > 0) a = Math.max(a, 0.6 + 0.35 * Math.exp(-du / 600));
    }
    if (f.h >= 0) a *= 1 - clamp((f.h - 30 * i) / 200);
    return { opacity: fin(a), transform: [{ translateY: fin(6 * (1 - springAt(u, 14, 200)), 6) }] };
  });
  return (
    <Animated.View style={[styles.word, { left: w.x - 80, top: w.y - 10 }, style]}>
      <Text style={styles.wordText}>{w.text}</Text>
    </Animated.View>
  );
}

/** The wordmark centred at (195,497) and the tagline under it, one renderer for the moving and the still hero. */
function Words({
  tagline,
  wordmarkStyle,
  taglineStyle,
}: {
  tagline: string;
  wordmarkStyle?: StyleProp<AnimatedStyle<ViewStyle>>;
  taglineStyle?: StyleProp<AnimatedStyle<ViewStyle>>;
}) {
  return (
    <>
      <Animated.View style={[styles.wordmarkWrap, wordmarkStyle]}>
        <Text style={styles.wordmark}>Echo Tail</Text>
      </Animated.View>
      <Animated.View style={[styles.taglineWrap, taglineStyle]}>
        <Text style={styles.tagline}>{tagline}</Text>
      </Animated.View>
    </>
  );
}

/** The moving hero: one derived `fr` per frame, every part a worklet of it. With no track (Skia unavailable) only the words run. */
function HeroMotion({ tk, tapT, track, tx, ty, tagline }: HeroClock & { track: Track | null; tx: number; ty: number; tagline: string }) {
  const L = track ? track.L : 1;
  const sc0 = track ? track.sc0 : 0;
  const curlLen = track ? track.curlLen : 1;
  const table = useSharedValue<number[]>(track ? track.table : EMPTY);

  const fr = useDerivedValue<Frame>(() => {
    const t = fin(tk.value);
    const gate = tapT.value;
    const g = Number.isNaN(gate) ? Infinity : gate;
    const h = g === Infinity ? -1 : t - g;
    const te = Math.min(t, g);
    const s = L * IOC((te - 200) / 2500);
    const fold = t > 2700 && 2700 < g ? OUT((t - 2700) / 400) : 0;
    let iu = -1;
    if (t >= 3400) {
      const st = 3400 + Math.floor((t - 3400) / 3400) * 3400;
      if (st < g) iu = t - st;
    }
    let rr = -1;
    if (t > 2700 && 2700 < g && t - 2700 < 700) rr = t - 2700;
    if (iu > 2200 && iu < 2900) rr = iu - 2200;
    let ax = 0;
    let ay = 0;
    if (h >= 0) {
      const p = headAt(table.value, L, sc0, curlLen, g);
      ax = p.x;
      ay = p.y;
    }
    return { t, g, h, s, curlEnd: Math.min(curlLen, Math.max(0, s - sc0)), fold, iu, rr, ax, ay };
  });

  const curlEnd = useDerivedValue(() => fin(fr.value.curlEnd / curlLen));
  const curlStart = useDerivedValue(() => {
    const f = fr.value;
    return fin(f.h >= 0 ? (f.curlEnd / curlLen) * IOC(f.h / 380) : 0);
  });
  // Nothing drawn under half a point (the board's threshold), so a trim that collapses never shows the whole path.
  const curlOpacity = useDerivedValue<number>(() => {
    const f = fr.value;
    const s0 = f.h >= 0 ? f.curlEnd * IOC(f.h / 380) : 0;
    return f.curlEnd - s0 < 0.5 ? 0 : 0.95;
  });
  const ringStyle = useAnimatedStyle(() => {
    const f = fr.value;
    if (f.rr < 0 || f.h >= 0) return { opacity: 0, transform: [{ scale: 0.5 }] };
    const kk = OUT(f.rr / 700);
    return { opacity: fin(0.6 * (1 - kk)), transform: [{ scale: fin(lerp(0.5, 2.8, kk), 0.5) }] };
  });
  const wordmarkStyle = useAnimatedStyle(() => riseStyle(fr.value, WORDMARK_AT));
  const taglineStyle = useAnimatedStyle(() => riseStyle(fr.value, TAGLINE_AT));

  return (
    <>
      {track && HERO_PARTS.curl ? (
        <View style={styles.curl}>
          <TailMark start={curlStart} end={curlEnd} opacity={curlOpacity} />
        </View>
      ) : null}
      {track && HERO_PARTS.greetings ? WORDS.map((_, i) => <Greeting key={i} i={i} tw={track.tw[i]} fr={fr} />) : null}
      {track && HERO_PARTS.dots
        ? DOT_ORDER.map((k) => <Dot key={k} k={k} fr={fr} table={table} L={L} sc0={sc0} curlLen={curlLen} tx={tx} ty={ty} />)
        : null}
      {track && HERO_PARTS.ring ? <Animated.View style={[styles.ring, ringStyle]} /> : null}
      {HERO_PARTS.words ? <Words tagline={tagline} wordmarkStyle={wordmarkStyle} taglineStyle={taglineStyle} /> : null}
    </>
  );
}

/** Reduced motion: the finished pose (full curl, 7pt bead at the tip,
 * greetings at .6, words at rest) fading in over 200ms and out over 150ms on the tap. */
function HeroStill({ tk, tapT, tagline }: HeroClock & { tagline: string }) {
  const zero = useSharedValue(0);
  const one = useSharedValue(1);
  const stroke = useSharedValue(0.95);
  const fade = useAnimatedStyle(() => {
    const t = fin(tk.value);
    const g = tapT.value;
    const h = g === Infinity || Number.isNaN(g) ? -1 : t - g;
    return { opacity: fin(clamp(t / 200) * (1 - clamp(h / 150)), 1) };
  });
  return (
    <Animated.View style={[StyleSheet.absoluteFill, fade]}>
      <View style={styles.curl}>
        <TailMark start={zero} end={one} opacity={stroke} />
      </View>
      {WORDS.map((w, i) => (
        <View key={i} style={[styles.word, styles.wordRest, { left: w.x - 80, top: w.y - 10 }]}>
          <Text style={styles.wordText}>{w.text}</Text>
        </View>
      ))}
      <View style={styles.bead} />
      <Words tagline={tagline} />
    </Animated.View>
  );
}

/**
 * The first onboarding screen: the Echo Tail hero (the head sweeping the
 * greetings and drawing the curl, then an idle bead every 3.4s) over the
 * flow's shared sky, with the wordmark, the tagline and the Get started pill.
 * Every part is a worklet of the route's clock; the tap is one write to
 * `tapT`, after which the bead flies to the kicker slot, the words leave and
 * the pill rides `travel` up into the Account step's first slot.
 */
export function WelcomeStep({
  tk,
  tapT,
  travel,
  reduced,
  onPress,
}: HeroClock & { travel: SharedValue<number>; reduced: boolean; onPress: () => void }) {
  const { t } = useT();
  const dir = useDir();
  const { width: W, height: H } = useWindowDimensions();
  const insets = useSafeAreaInsets();
  const track = reduced ? null : getTrack();
  const footerTop = H - insets.bottom - Spacing.lg - 52;
  const k = Math.max(0.1, Math.min(1, (footerTop - 12) / HERO_H));
  const left = (W - HERO_W * k) / 2;
  // The Account step's kicker slot, in hero units: where the bead lands.
  const tx = ((dir.rtl ? W - 30 : 30) - left) / k;
  const ty = (insets.top + 59) / k;
  const tagline = t('settings.onboarding.tagline');

  const pillStyle = useAnimatedStyle(() => {
    const tt = fin(tk.value);
    const g = tapT.value;
    const h = g === Infinity || Number.isNaN(g) ? -1 : tt - g;
    if (reduced) return { opacity: fin(1 - clamp(h / 150), 1), transform: [{ translateY: 0 }] };
    return { opacity: 1, transform: [{ translateY: fin(-travel.value * springAt(h - 120, 18, 180)) }] };
  });
  // The board's lbA: the label fades 120 to 260ms after the tap while the face rides on.
  const labelOpacity = useDerivedValue(() => {
    const g = tapT.value;
    const h = g === Infinity || Number.isNaN(g) ? -1 : fin(tk.value) - g;
    return fin(1 - clamp((h - 120) / 140), 1);
  });
  // Untouchable from the first press on, on the UI thread: a second tap would replay the Tide Drop and the haptic.
  // react-native-web ignores the animated pointerEvents, so a JS flag set once on the first press gates the pill there too.
  const [pressed, setPressed] = useState(false);
  const press = () => {
    if (pressed) return;
    setPressed(true);
    onPress();
  };
  const pillProps = useAnimatedProps(() => ({ pointerEvents: tapT.value === Infinity ? ('auto' as const) : ('none' as const) }));

  return (
    <>
      <View pointerEvents="none" style={[styles.hero, { left, transform: [{ scale: k }] }]}>
        {reduced ? (
          <HeroStill tk={tk} tapT={tapT} tagline={tagline} />
        ) : (
          <HeroMotion tk={tk} tapT={tapT} track={track} tx={tx} ty={ty} tagline={tagline} />
        )}
      </View>
      <StepFrame
        fill
        footer={
          <Animated.View style={pillStyle} animatedProps={pillProps} pointerEvents={pressed ? 'none' : 'auto'}>
            <StepAction verb="listen" label={t('settings.onboarding.getStarted')} labelOpacity={labelOpacity} onPress={press} />
          </Animated.View>
        }>
        {null}
      </StepFrame>
    </>
  );
}

const styles = StyleSheet.create({
  hero: { position: 'absolute', top: 0, width: HERO_W, height: HERO_H, transformOrigin: 'top left' },
  curl: { position: 'absolute', left: CURL_AT.x, top: CURL_AT.y, width: TAIL_BOX.w, height: TAIL_BOX.h },
  dot: { position: 'absolute', left: 0, top: 0 },
  ring: {
    position: 'absolute',
    left: TIP.x - RING / 2,
    top: TIP.y - RING / 2,
    width: RING,
    height: RING,
    borderRadius: RING / 2,
    borderWidth: 1.5,
    borderColor: verb.listen.c1,
  },
  bead: { position: 'absolute', left: TIP.x - 3.5, top: TIP.y - 3.5, width: 7, height: 7, borderRadius: 3.5, backgroundColor: verb.speak.c1 },
  word: { position: 'absolute', width: 160, alignItems: 'center' },
  wordRest: { opacity: 0.6 },
  wordText: { fontSize: 15, lineHeight: 20, color: tide.text, textAlign: 'center' },
  wordmarkWrap: { position: 'absolute', left: 0, top: 471, width: HERO_W, height: 52, alignItems: 'center', justifyContent: 'center' },
  taglineWrap: { position: 'absolute', left: 43, top: 539, width: 304, alignItems: 'center' },
  wordmark: {
    fontFamily: fonts.wordmark,
    fontStyle: 'italic',
    fontWeight: '600',
    fontSize: 44,
    letterSpacing: -0.5,
    color: tide.text,
  },
  // 300 pt of text plus 2 pt a side inside the 304 wrapper: a line's hanging trailing space is wider than the text box and was cut at its edge on the web.
  tagline: { fontFamily: fonts.ui, fontSize: 17, lineHeight: 24, color: tide.textDim, textAlign: 'center', width: 304, paddingHorizontal: 2 },
});
