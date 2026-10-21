import { Canvas, LinearGradient, Rect, RoundedRect, vec } from '@shopify/react-native-skia';
import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, useWindowDimensions, View } from 'react-native';
import Animated, {
  Easing,
  FadeIn,
  FadeOut,
  LinearTransition,
  useAnimatedReaction,
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
  withDelay,
  withSequence,
  withTiming,
} from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { LevelBars } from '@/components/level-bars';
import { PrismButton } from '@/components/prism';
import { RubyWord } from '@/components/ruby-word';
import { fonts } from '@/constants/fonts';
import { tide, tideSkies, verb, withAlpha } from '@/constants/theme';
import type { LadderStageProps } from '@/hooks/use-ladder';
import { useDir, useT } from '@/lib/i18n';
import { isolate } from '@/lib/bidi';
import { kinsokuUnits } from '@/lib/kinsoku';
import { holdInlineXp, useInlineXp } from '@/lib/level-up-store';
import { revealCard } from '@/lib/content-reveal';
import { loaderShown } from '@/lib/loading-overlay';

// Built to the approved mock .claude/design/A2-r2.html: the emoji stage rail
// under the header, the 36pt line card centred in the gap, the stage sheet in
// the thumb zone. Motion is damped timing only (no springs).

const HEADER_H = 48;
const SHEET_H = 318;
// The score band under the rail: the 44pt number's 50pt line, the 13pt kept-up line and their gaps.
// It is this high only while it holds a score or "Scoring…" (ET-10), and opens and closes over BAND_MS.
const SCORE_H = 78;
const BAND_MS = 220;
const LINE_PT = 36;
// The card's text steps down from 36pt in 2pt steps to fit the gap, never under 20pt (then it scrolls).
const LINE_MIN = 20;
const LINE_STEP = 2;
// The card's padding and rim around the text, and the English line under it
// (ET-10: the English only shows after a tap on the card, so the fit leaves it out).
const CARD_PAD_V = 12 + 16 + 2;
const CARD_PAD_H = 16 * 2 + 20 * 2 + 2;
const EN_H = 23;
// The least a two-line sentence needs at the smallest step (1.75 line height), and the Easy chip's row above it.
// When the gap under the rail cannot hold that plus the score band, the score moves into the sheet's title row
// instead of taking the card's room (the video player's 16:9 box leaves a gap of 120pt on a 390x844 phone).
const CARD_NEED = 2 * LINE_MIN * 1.75 + CARD_PAD_V;
const CHIP_ROW = 44;
const GLASS = 'rgba(20,28,44,0.72)';
const RIM = 'rgba(255,255,255,0.14)';
const noop = () => {};
const OUT = Easing.out(Easing.cubic);
// The gold of the XP toast (session-celebration.tsx), for the score band's "+N XP".
const XP_GOLD = '#FFC857';

// The count and the step content it stands in for (the wave, the repeat
// tiles and their buttons) replace each other: one fades out in SWAP_OUT_MS,
// then the other fades in. The disc stays put while it counts; only its digit
// changes, in the same render as the "Starts after" caption.
const SWAP_OUT_MS = 120;
const SWAP_IN_MS = 180;

/**
 * The largest size, 36pt down to 20pt in 2pt steps, at which `chars`
 * characters are guessed to fit `w` by `h`. A first guess so the fit rarely
 * shows a step; the card's measured height has the last word.
 */
function guessPt(chars: number, enLines: number, w: number, h: number): number {
  for (let pt = LINE_PT; pt > LINE_MIN; pt -= LINE_STEP) {
    // A glyph measures about 1.17x its size once the ruby word spacing is in (8 chars at 36pt ran 331px).
    const perRow = Math.max(1, Math.floor(w / (pt * 1.17)));
    const rows = Math.ceil(Math.max(chars, 1) / perRow);
    if (rows * pt * 1.6 + enLines * EN_H + CARD_PAD_V <= h) return pt;
  }
  return LINE_MIN;
}

/** The card's fit pass: its line, size, the room kept for the English, and the measured text height once done. */
type Fit = { key: string; lineKey: string; mount: string; pt: number; room: number; done: boolean; shown: boolean; h: number };

type Frame = 'listen' | 'memorise' | 'say' | 'ready' | 'recording' | 'final' | 'compare';
type TKey = Parameters<ReturnType<typeof useT>['t']>[0];

/** A tile's look from the mock: its tint and the 145deg gradient's two alphas and rim. */
export type Look = { tint: string; from: number; to: number; rim: number; glow?: boolean };
const LISTEN: Look = { tint: verb.listen.c1, from: 0.38, to: 0.12, rim: 0.5 };
const MUMBLE: Look = { tint: verb.mumble.c1, from: 0.38, to: 0.12, rim: 0.5 };
const ALONG: Look = { tint: verb.along.c1, from: 0.38, to: 0.12, rim: 0.5 };
const READY: Look = { tint: verb.listen.c2, from: 0.38, to: 0.12, rim: 0.5 };
const REC: Look = { tint: verb.speak.c1, from: 0.55, to: 0.2, rim: 0.8, glow: true };
const FIN: Look = { tint: verb.tools.c1, from: 0.28, to: 0.08, rim: 0.45 };

/** The mock's five rail stations, in its order: Listen, Memorise, Get ready, Recording, Final take. */
const STATIONS: readonly { emoji: string; look: Look; name: TKey }[] = [
  { emoji: '👂', look: LISTEN, name: 'settings.onboarding.passListenTitle' },
  { emoji: '🫢', look: MUMBLE, name: 'settings.onboarding.passMemoriseTitle' },
  { emoji: '🌊', look: READY, name: 'ladder.readyTitle' },
  { emoji: '🎙️', look: REC, name: 'ladder.recordingTitle' },
  { emoji: '🙈', look: FIN, name: 'ladder.finalTitle' },
];

function frameOf(p: LadderStageProps): Frame {
  if (p.stage === 'listen') return 'listen';
  if (p.stage === 'memorise') return 'memorise';
  if (p.stage === 'say') return 'say';
  if (p.stage === 'compare') return 'compare';
  if (p.isRecording) return 'recording';
  return p.round === 2 ? 'final' : 'ready';
}

/** The rail station a frame lights; Say shares Memorise's, Compare is past them all. */
function stationOf(p: LadderStageProps, frame: Frame, count: number): number {
  switch (frame) {
    case 'listen':
      return 0;
    case 'memorise':
    case 'say':
      return 1;
    case 'ready':
      return 2;
    case 'recording':
      return p.round === 2 ? 4 : 3;
    case 'final':
      return 4;
    case 'compare':
      return count;
  }
}

const FRAME_LOOK: Record<Frame, Look> = {
  listen: LISTEN,
  memorise: MUMBLE,
  say: ALONG,
  ready: READY,
  recording: REC,
  final: FIN,
  compare: FIN,
};
// The sheet's rim alpha per frame, from the mock (recording draws a solid 2pt rim).
const SHEET_RIM: Record<Frame, number> = { listen: 0.4, memorise: 0.4, say: 0.4, ready: 0.45, recording: 1, final: 0.35, compare: 0.35 };

const TITLE: Record<Frame, TKey> = {
  listen: 'ladder.listenTitle',
  memorise: 'settings.onboarding.passMemoriseTitle',
  say: 'ladder.sayTitle',
  ready: 'ladder.readyTitle',
  recording: 'ladder.recordingTitle',
  final: 'ladder.finalTitle',
  compare: 'settings.onboarding.passCompareTitle',
};
const LINE: Record<Frame, TKey> = {
  listen: 'ladder.listenLine',
  memorise: 'ladder.memoriseLine',
  say: 'ladder.sayLine',
  ready: 'ladder.readyLine',
  recording: 'ladder.recordingLine',
  final: 'ladder.finalLine',
  compare: 'ladder.compareLine',
};
const RAIL_NAME: Record<Frame, TKey> = {
  listen: 'settings.onboarding.passListenTitle',
  memorise: 'settings.onboarding.passMemoriseTitle',
  say: 'settings.onboarding.passSayTitle',
  ready: 'ladder.readyTitle',
  recording: 'ladder.recordingTitle',
  final: 'ladder.finalTitle',
  compare: 'settings.onboarding.passCompareTitle',
};

/** The mock's static listening waveform (heights in pt). */
const WAVE = [38, 21, 14, 13, 19, 31, 30, 28, 11, 40, 45, 53, 36, 22, 18, 24, 20, 13, 22, 10, 27, 33, 53, 43, 34, 12, 32, 38, 33, 24, 11, 16];

/** A gradient tile (the mock's 145deg tint fill), or the flat done tile. */
export function Tile({ look, size, radius, fontSize, children, done }: {
  look: Look; size: number; radius: number; fontSize: number; children: ReactNode; done?: boolean;
}) {
  if (done) {
    return (
      <View style={[styles.tile, { width: size, height: size, borderRadius: radius, backgroundColor: 'rgba(255,255,255,0.06)', borderColor: RIM, opacity: 0.7 }]}>
        <Text style={[styles.tileText, { fontSize }]}>{children}</Text>
      </View>
    );
  }
  const inner = Math.max(size - 2, 0);
  return (
    <View
      style={[
        styles.tile,
        { width: size, height: size, borderRadius: radius, borderColor: withAlpha(look.tint, look.rim) },
        look.glow && { shadowColor: look.tint, shadowOpacity: 0.4, shadowRadius: 16, shadowOffset: { width: 0, height: 0 } },
      ]}>
      <Canvas style={StyleSheet.absoluteFill} pointerEvents="none">
        <RoundedRect x={0} y={0} width={inner} height={inner} r={Math.max(radius - 1, 0)}>
          <LinearGradient start={vec(0, 0)} end={vec(inner, inner)} colors={[withAlpha(look.tint, look.from), withAlpha(look.tint, look.to)]} />
        </RoundedRect>
      </Canvas>
      <Text style={[styles.tileText, { fontSize }]}>{children}</Text>
    </View>
  );
}

const Rail = memo(function Rail({ p, frame }: { p: LadderStageProps; frame: Frame }) {
  const { t } = useT();
  const dir = useDir();
  const reduced = useReducedMotion();
  const layout = reduced ? undefined : LinearTransition.duration(220).easing(OUT);
  // Station indices on the rail: the Memorise station is absent when prep is off, the Final take when finalOn is.
  const vis = STATIONS.map((_, k) => k).filter((k) => !(p.prep === false && k === 1) && !(p.finalOn === false && k === 4));
  const count = vis.length;
  const at = frame === 'compare' ? count : Math.max(0, vis.indexOf(stationOf(p, frame, STATIONS.length)));
  // A station tap jumps to its stage: Get ready and Recording both count in to the take.
  const jump = (i: number) => {
    if (i === 4) (p.onFinal ?? (() => p.onJump(3)))();
    else p.onJump(i >= 2 ? 3 : i);
  };
  const items: ReactNode[] = [];
  for (let i = 0; i < count; i++) {
    const base = STATIONS[vis[i]!]!;
    const st = vis[i] === 1 && frame === 'say' ? { ...base, emoji: '👁️', look: ALONG } : base;
    const cur = i === at;
    const done = i < at;
    // Keyed by station, not position: Get ready and Final come and go, and a position key would hand one station's row to another.
    if (i > 0) items.push(<View key={`l${vis[i]}`} style={[styles.ln, i <= at && styles.lnDone]} />);
    items.push(
      <Animated.View key={vis[i]} layout={layout} style={styles.stWrap}>
        <Pressable
          onPress={() => jump(vis[i]!)}
          hitSlop={4}
          accessibilityRole="button"
          accessibilityLabel={t(cur ? RAIL_NAME[frame] : st.name)}
          style={[styles.st, dir.row, cur && (dir.rtl ? styles.stCurRtl : styles.stCur)]}>
          {done ? (
            <Tile look={st.look} size={34} radius={17} fontSize={16} done>✓</Tile>
          ) : cur ? (
            <Tile look={st.look} size={40} radius={20} fontSize={19}>{st.emoji}</Tile>
          ) : (
            <View style={{ opacity: 0.45 }}>
              <Tile look={st.look} size={34} radius={17} fontSize={16} done>{st.emoji}</Tile>
            </View>
          )}
          {cur ? (
            <Animated.Text entering={reduced ? undefined : FadeIn.duration(200).easing(OUT)} numberOfLines={1} style={styles.stName}>
              {t(RAIL_NAME[frame])}
            </Animated.Text>
          ) : null}
        </Pressable>
      </Animated.View>,
    );
  }
  return <View style={[styles.rail, dir.row]}>{items}</View>;
});

function Card({ p, frame, hidden, maxH }: { p: LadderStageProps; frame: Frame; hidden: boolean; maxH: number }) {
  const reduced = useReducedMotion();
  const dir = useDir();
  const { t } = useT();
  const { width } = useWindowDimensions();
  const blocks = useSharedValue(hidden ? 1 : 0);
  const rim = useSharedValue(frame === 'recording' ? 1 : 0);
  useEffect(() => {
    blocks.value = withTiming(hidden ? 1 : 0, { duration: reduced ? 0 : 200, easing: OUT });
  }, [hidden, blocks, reduced]);
  useEffect(() => {
    rim.value = withTiming(frame === 'recording' ? 1 : 0, { duration: reduced ? 0 : 200, easing: OUT });
  }, [frame, rim, reduced]);
  const textStyle = useAnimatedStyle(() => ({ opacity: 1 - blocks.value }));
  const blockStyle = useAnimatedStyle(() => ({ opacity: blocks.value }));
  const rimStyle = useAnimatedStyle(() => ({ opacity: rim.value }));
  // M10's underline: use-ladder's `fill` runs 0 to 1 over the pass and stays 0 through the count.
  // Only the shared value goes into the worklet: `p` holds JSX and refs, which cannot be copied to the UI thread.
  const fill = p.fill;
  const ulStyle = useAnimatedStyle(() => {
    const f = Number.isFinite(fill.value) ? Math.min(1, Math.max(0, fill.value)) : 0;
    return { width: `${f * 100}%` };
  });
  const follow = frame === 'listen' || frame === 'say';
  const line = p.line ?? null;
  const words = line && line.words.length > 0 ? line.words : null;
  const units = useMemo(() => (words ? kinsokuUnits(words) : []), [words]);
  const chars = words ? words.reduce((n, w) => n + w.text.length, 0) : p.text.length;
  const innerW = Math.max(width - CARD_PAD_H, 1);
  // ET-10: the English is behind a tap on the card (tap again to hide it), so
  // the Japanese gets the whole card. It starts hidden on every line.
  const en = line?.en || '';
  const [enOn, setEnOn] = useState({ index: p.index, on: false });
  const showEn = enOn.index === p.index && enOn.on && en !== '';
  const toggleEn = () => setEnOn((v) => ({ index: p.index, on: !(v.index === p.index && v.on) }));
  // The English slot opens to the text's measured height as it fades in, and
  // closes the same way, so it never draws over the Japanese.
  const enV = useSharedValue(0);
  const enH = useSharedValue(0);
  const enLine = useRef(p.index);
  useLayoutEffect(() => {
    const newLine = enLine.current !== p.index;
    enLine.current = p.index;
    enV.value = newLine || reduced ? (showEn ? 1 : 0) : withTiming(showEn ? 1 : 0, { duration: 200, easing: OUT });
  }, [showEn, p.index, enV, reduced]);
  const enStyle = useAnimatedStyle(() => {
    const v = Number.isFinite(enV.value) ? Math.min(1, Math.max(0, enV.value)) : 0;
    const hh = Number.isFinite(enH.value) ? Math.max(0, enH.value) : 0;
    return { height: v * hh, opacity: v };
  });
  // The Easy chip's row sits above the text inside the same maxHeight.
  const [chipH, setChipH] = useState(0);
  const textMax = Math.max(maxH - (p.chip ? chipH : 0), 1);
  // The fit first sizes the Japanese to leave room for the English under it (the
  // slot's 4pt top, its 21pt lines and 16pt bottom), so a tap grows the card
  // without covering a word. When even 20pt leaves no room, the Japanese takes
  // the whole card and a tap makes the English take its bottom.
  const enLines = en ? Math.ceil((en.length * 7) / innerW) : 0;
  const enRoom = en ? 20 + enLines * 21 : 0;
  // The fit restarts from the guess for each line; the text stays hidden until
  // the measured card fits (or reaches 20pt). `mount` remounts the text per pass.
  const lineKey = `${p.index}|${p.text}|${Math.round(chipH)}`;
  const key = `${lineKey}|${Math.round(maxH)}`;
  const start = (room: number, shown = false, from = LINE_PT): Fit => ({
    key, lineKey, mount: key, pt: Math.min(from, guessPt(chars, 0, innerW, textMax - room)), room, done: false, shown, h: 0,
  });
  // The same line's gap changing (the score band opening or closing) keeps a
  // fitted size that still fits and never grows it mid-line; a size that no
  // longer fits steps down with the text shown.
  const regap = (f: Fit): Fit => {
    if (f.lineKey !== lineKey || !f.done) return start(enRoom);
    if (f.h > 0 && f.h + 2 > textMax - f.room) return start(f.room, true, f.pt);
    return { ...f, key };
  };
  const [fit, setFit] = useState(() => start(enRoom));
  if (fit.key !== key) setFit(regap(fit));
  const onSize = (_w: number, h: number) => {
    if (fit.key !== key || fit.done || !(h > 0)) return;
    if (h + 2 <= textMax - fit.room) setFit((f) => (f.pt === fit.pt && f.key === fit.key ? { ...f, done: true, h } : f));
    else if (fit.pt > LINE_MIN) setFit({ ...fit, pt: Math.max(LINE_MIN, fit.pt - LINE_STEP) });
    else if (fit.room > 0) setFit(start(0, fit.shown, fit.shown ? fit.pt : LINE_PT));
    else setFit({ ...fit, done: true, h });
  };
  // A unit never wraps, so a long one (a whole greeting) can be wider than the card while its height
  // still fits. Each unit reports its width; a wider one steps the size down to the width that fits.
  const onUnit = (uw: number) => {
    if (fit.key !== key || !(uw > innerW + 0.5) || fit.pt <= LINE_MIN) return;
    // Functional, so a height pass reporting in the same batch cannot overwrite the step.
    setFit((f) => {
      if (f.key !== key || f.pt <= LINE_MIN) return f;
      const next = Math.max(LINE_MIN, Math.floor((f.pt * innerW) / uw / LINE_STEP) * LINE_STEP);
      return { ...f, pt: Math.min(next, f.pt - LINE_STEP), done: false, h: 0 };
    });
  };
  const pt = fit.pt;
  const rowH = pt * 1.9;
  const plain = { fontSize: pt, lineHeight: pt * 1.75 };
  // The card's cap eases to a new gap with the score band (BAND_MS), so its edge
  // moves with the band instead of jumping; a new line takes its gap at once.
  const cap = useSharedValue(maxH);
  const capLine = useRef(p.index);
  useLayoutEffect(() => {
    const newLine = capLine.current !== p.index;
    capLine.current = p.index;
    cap.value = newLine || reduced ? maxH : withTiming(maxH, { duration: BAND_MS, easing: OUT });
  }, [maxH, p.index, cap, reduced]);
  const capStyle = useAnimatedStyle(() => ({ maxHeight: Number.isFinite(cap.value) ? Math.max(1, cap.value) : 1 }));
  return (
    <Animated.View style={[styles.card, capStyle]}>
      <Pressable
        style={styles.cardPress}
        onPress={en ? toggleEn : undefined}
        disabled={!en}
        accessibilityRole={en ? 'button' : undefined}
        accessibilityLabel={en ? (showEn ? en : t('player.translationHidden')) : undefined}>
      {p.chip ? (
        <View style={styles.chipRow} pointerEvents="box-none" onLayout={(e) => setChipH(Math.round(e.nativeEvent.layout.height) || 0)}>
          {p.chip}
        </View>
      ) : null}
      {/* Remounted per line, size step and fit pass, so each one reports its height. */}
      <ScrollView
        key={`${fit.mount}|${pt}|${fit.room}`}
        style={styles.cardScroll}
        bounces={false}
        showsVerticalScrollIndicator={false}
        contentContainerStyle={[styles.cardBody, !fit.done && !fit.shown && styles.fitting]}
        onContentSizeChange={onSize}>
        <Animated.View style={textStyle} pointerEvents="none">
          {words ? (
            <View style={styles.units}>
              {units.map((unit) => (
                <View key={unit[0]} style={styles.unit} onLayout={(e) => onUnit(e.nativeEvent.layout.width)}>
                  {unit.map((wi) => (
                    <RubyWord
                      key={wi}
                      word={words[wi]!}
                      showRuby
                      index={wi}
                      selected={false}
                      onLayout={noop}
                      showPosAndRomaji={false}
                      scale={pt / 22}
                      highlight={follow ? p.highlight : undefined}
                      litColor={XP_GOLD}
                    />
                  ))}
                </View>
              ))}
            </View>
          ) : (
            <Text style={[styles.plain, plain]}>{p.text}</Text>
          )}
        </Animated.View>
        <Animated.View style={[styles.blocks, blockStyle]} pointerEvents="none">
          {(words ? words.map((w) => w.text.length) : Array.from(p.text, () => 1)).map((n, i) => (
            <View key={i} style={[styles.blockRow, { height: rowH, paddingTop: rowH * 0.26 }]}>
              <View style={[styles.block, { width: (Math.max(25, Math.min(n, 4) * 25.5) * pt) / LINE_PT }]} />
            </View>
          ))}
        </Animated.View>
      </ScrollView>
      {en ? (
        <Animated.View style={[styles.enSlot, enStyle]} pointerEvents="none">
          <Text
            style={[styles.en, dir.content]}
            onLayout={(e) => {
              const h = e.nativeEvent.layout.height;
              if (h > 0) enH.value = h;
            }}>
            {en}
          </Text>
        </Animated.View>
      ) : null}
      </Pressable>
      {frame === 'say' ? (
        <View pointerEvents="none" style={styles.ul}>
          <Animated.View style={[styles.ulFill, ulStyle]} />
        </View>
      ) : null}
      <Animated.View pointerEvents="none" style={[styles.recRim, dir.rtl && styles.recRimRtl, rimStyle]} />
    </Animated.View>
  );
}

function Pill({ label, icon, kind, onPress, big }: { label: string; icon?: string; kind: 'tools' | 'mumble' | 'along' | 'speak' | 'listen'; onPress: () => void; big?: boolean }) {
  return (
    <PrismButton shape="pill" verb={kind} label={label} height={big ? 56 : 48} press="light" onPress={onPress} accessibilityRole="button">
      {icon ? <Text style={styles.pillIcon}>{icon}</Text> : null}
    </PrismButton>
  );
}

/** The mock's `.pill.big.blue`: a flat listen-blue pill, 56pt high. */
function BluePill({ label, icon, onPress }: { label: string; icon: string; onPress: () => void }) {
  const dir = useDir();
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={label}
      style={({ pressed }) => [styles.bluePill, dir.row, pressed && { opacity: 0.7 }]}>
      <Text style={styles.blueText}>{icon}</Text>
      <Text style={styles.blueText}>{label}</Text>
    </Pressable>
  );
}

/** The mock's 36pt round header button with "?", for a player whose header is native. */
export function LadderHelpButton({ onPress }: { onPress: () => void }) {
  const { t } = useT();
  return (
    <Pressable onPress={onPress} hitSlop={4} accessibilityRole="button" accessibilityLabel={t('player.help')} style={({ pressed }) => [styles.ib, pressed && { opacity: 0.7 }]}>
      <Text style={styles.ibText}>?</Text>
    </Pressable>
  );
}

function fmt(s: number): string {
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

/** The new take's score, banded like the island's score row (>= 80, 50-79, < 50); fades in rising 8pt. */
function ScoreValue({ total, keptUp, compact }: { total: number; keptUp?: string; compact?: boolean }) {
  const reduced = useReducedMotion();
  const o = useSharedValue(reduced ? 1 : 0);
  useEffect(() => {
    if (!reduced) o.value = withTiming(1, { duration: 220, easing: OUT });
  }, [o, reduced]);
  const rise = useAnimatedStyle(() => {
    const v = Number.isFinite(o.value) ? o.value : 1;
    return { opacity: v, transform: [{ translateY: (1 - v) * 8 }] };
  });
  const colour = total >= 80 ? tide.listen : total >= 50 ? tide.text : tide.record;
  return (
    <Animated.View style={[styles.scoreIn, compact && styles.scoreInEnd, rise]}>
      <View style={styles.scoreRow}>
        <Text style={[styles.scoreNum, compact && styles.scoreNumC, { color: colour }]}>{Math.round(total)}</Text>
        <Text style={[styles.scoreOf, compact && styles.scoreOfC]}>/100</Text>
      </View>
      {keptUp ? <Text style={[styles.scoreKept, compact && styles.scoreKeptC]}>{keptUp}</Text> : null}
    </Animated.View>
  );
}

/**
 * The XP a take (or any award while the stage is up) paid: a small gold
 * "+N XP" next to the score that fades in rising 10pt over 600ms out-cubic,
 * holds 1.2s, then fades out. Only a pop after this view mounted plays.
 */
function XpPop({ beside, inline }: { beside: boolean; inline?: boolean }) {
  const { t } = useT();
  const dir = useDir();
  const { n, id, cap } = useInlineXp();
  const [since] = useState(id);
  const reduced = useReducedMotion();
  const o = useSharedValue(0);
  const r = useSharedValue(0);
  const live = id !== since && (n > 0 || cap);
  useEffect(() => {
    if (!live) return;
    o.value = 0;
    r.value = reduced ? 1 : 0;
    o.value = withSequence(
      withTiming(1, { duration: 600, easing: OUT }),
      withDelay(1200, withTiming(0, { duration: 200, easing: Easing.linear })),
    );
    if (!reduced) r.value = withTiming(1, { duration: 600, easing: OUT });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);
  const style = useAnimatedStyle(() => {
    const ov = Number.isFinite(o.value) ? o.value : 0;
    const rv = Number.isFinite(r.value) ? r.value : 1;
    return { opacity: ov, transform: [{ translateY: (1 - rv) * 10 }] };
  });
  if (!live) return null;
  return (
    <Animated.View style={[inline ? (dir.rtl ? styles.xpInlineRtl : styles.xpInline) : beside ? (dir.rtl ? styles.xpBesideRtl : styles.xpBeside) : styles.xpAlone, style]}>
      <Text style={[styles.xpText, beside && dir.text]}>{isolate(t('review.xpEarned', { n }))}</Text>
      {cap ? <Text style={[styles.xpCap, beside ? dir.text : { textAlign: 'center' }, dir.writing]}>{t('ladder.xpCap')}</Text> : null}
    </Animated.View>
  );
}

/** Whether the score band has anything to show: the take's score, or "Scoring…" while it computes. */
function bandOpen(score: LadderStageProps['score']): boolean {
  const total = score?.total;
  return (typeof total === 'number' && Number.isFinite(total)) || !!score?.scoring;
}

/**
 * The score's band under the rail: the take's score or "Scoring…". ET-10: it
 * is 0 high while it has nothing to show, so the card takes its room, and
 * opens or closes over BAND_MS. A new line closes it at once, with the card's
 * own swap to that line.
 */
function ScoreBand({ score, index, compact }: { score: LadderStageProps['score']; index: number; compact: boolean }) {
  const { t } = useT();
  const reduced = useReducedMotion();
  const total = score?.total;
  const on = typeof total === 'number' && Number.isFinite(total);
  const open = bandOpen(score) && !compact;
  const h = useSharedValue(open ? SCORE_H : 0);
  const shownLine = useRef(index);
  useLayoutEffect(() => {
    const newLine = shownLine.current !== index;
    shownLine.current = index;
    const to = open ? SCORE_H : 0;
    h.value = newLine || reduced ? to : withTiming(to, { duration: BAND_MS, easing: OUT });
  }, [open, index, h, reduced]);
  const bandStyle = useAnimatedStyle(() => {
    const v = Number.isFinite(h.value) ? Math.min(SCORE_H, Math.max(0, h.value)) : 0;
    return { height: v };
  });
  return (
    <Animated.View style={[styles.scoreBand, bandStyle]} pointerEvents="none">
      <View style={styles.scoreInner}>
        {compact ? null : on ? (
          <ScoreValue key={`${total}|${score?.keptUp ?? ''}|${score?.at ?? 0}`} total={total} keptUp={score?.keptUp} />
        ) : score?.scoring ? (
          <Text style={styles.scoring}>{t('ladder.scoring')}</Text>
        ) : null}
        {compact ? null : <XpPop beside={on} />}
      </View>
    </Animated.View>
  );
}

/** The score in the sheet's title row, for a gap too short for the band (see CARD_NEED). */
function TightScore({ score }: { score: LadderStageProps['score'] }) {
  const { t } = useT();
  const total = score?.total;
  const on = typeof total === 'number' && Number.isFinite(total);
  return (
    <View style={styles.tightScore} pointerEvents="none">
      {on ? (
        <ScoreValue key={`${total}|${score?.keptUp ?? ''}|${score?.at ?? 0}`} total={total} keptUp={score?.keptUp} compact />
      ) : score?.scoring ? (
        <Text style={styles.scoring}>{t('ladder.scoring')}</Text>
      ) : null}
      <XpPop beside={on} inline />
    </View>
  );
}

function Sheet({ p, frame, onPeek, tight }: { p: LadderStageProps; frame: Frame; onPeek: () => void; tight: boolean }) {
  const { t } = useT();
  const dir = useDir();
  const reduced = useReducedMotion();
  const [secs, setSecs] = useState(0);
  const stopped = !!p.stopped;
  // The take's clock: runs while the mic is open, holds once it closes.
  useEffect(() => {
    if (!p.isRecording) {
      setSecs(0);
      return;
    }
    if (stopped) return;
    const start = Date.now();
    const id = setInterval(() => setSecs(Math.floor((Date.now() - start) / 1000)), 250);
    return () => clearInterval(id);
  }, [p.isRecording, stopped]);
  const look = FRAME_LOOK[frame];
  const rec = frame === 'recording';
  const counting = p.phase === 'count' && p.beat !== null;
  const waiting = p.phase === 'waiting';
  const showTiles = (frame === 'memorise' || frame === 'say') && !counting;
  // A fresh frame fades in whole (the sheet's own 220ms), so its parts start at once; a swap
  // inside the frame (the count starting or ending) waits for the outgoing part to leave.
  const shownFrame = useRef<Frame | null>(null);
  const fresh = shownFrame.current !== frame;
  useEffect(() => {
    shownFrame.current = frame;
  }, [frame]);
  const fadeIn = reduced ? undefined : FadeIn.delay(fresh ? 0 : SWAP_OUT_MS).duration(SWAP_IN_MS).easing(OUT);
  const fadeOut = reduced ? undefined : FadeOut.duration(SWAP_OUT_MS).easing(OUT);
  const tightScore = tight && bandOpen(p.score);
  const next = () => p.onJump(Math.min(p.index + 1, p.total - 1));
  const record = p.onRecord ?? (() => p.onJump(3));
  return (
    <Animated.View
      key={frame}
      entering={reduced ? undefined : FadeIn.duration(220).easing(OUT)}
      style={[
        styles.sheet,
        rec ? { borderColor: tide.record, borderWidth: 2 } : { borderColor: withAlpha(look.tint, SHEET_RIM[frame]), borderWidth: 1 },
      ]}>
      <View style={[styles.titleRow, dir.row]}>
        {rec ? <View style={styles.blink} /> : null}
        <Text style={[styles.h3, dir.text, rec && { color: tide.record }]}>{t(TITLE[frame])}</Text>
        {showTiles ? (
          <Animated.View entering={fadeIn} exiting={fadeOut}>
            <Pressable
              onPress={next}
              hitSlop={8}
              accessibilityRole="button"
              style={({ pressed }) => [
                styles.badge,
                { backgroundColor: withAlpha(look.tint, 0.2), borderColor: withAlpha(look.tint, 0.55) },
                pressed && { opacity: 0.7 },
              ]}>
              <Text style={styles.badgeText}>{t('ladder.ready')}</Text>
            </Pressable>
          </Animated.View>
        ) : null}
        {tightScore ? <TightScore score={p.score} /> : null}
        {frame === 'memorise' ? <Text style={[styles.motif, tightScore && styles.afterScore]}>🫢</Text> : null}
        {frame === 'say' ? (
          <View style={[styles.lineMotif, tightScore && styles.afterScore]}>
            <View style={[styles.lmBar, { width: 24, backgroundColor: look.tint }]} />
            <View style={[styles.lmBar, { width: 16, backgroundColor: look.tint, opacity: 0.6 }]} />
            <View style={[styles.lmBar, { width: 32, backgroundColor: verb.along.c2 }]} />
          </View>
        ) : null}
      </View>
      <Text style={[styles.p, dir.text]}>{t(LINE[frame], { count: p.repeats })}</Text>

      {frame === 'listen' && !counting ? (
        <Animated.View entering={fadeIn} exiting={fadeOut} style={styles.waveBox}>
          {WAVE.map((h, i) => (
            <View key={i} style={[styles.bar, { height: h, backgroundColor: look.tint }]} />
          ))}
        </Animated.View>
      ) : null}
      {showTiles ? (
        <Animated.View entering={fadeIn} exiting={fadeOut} style={[styles.tiles, dir.row]}>
          {Array.from({ length: p.repeats }, (_, i) => {
            const n = i + 1;
            return n < p.repeat ? (
              <Tile key={n} look={look} size={56} radius={28} fontSize={22} done>✓</Tile>
            ) : n === p.repeat ? (
              <Tile key={n} look={look} size={56} radius={28} fontSize={22}>{n}</Tile>
            ) : (
              <Tile key={n} look={look} size={56} radius={28} fontSize={22} done>{n}</Tile>
            );
          })}
        </Animated.View>
      ) : null}
      {rec ? (
        <View style={[styles.recRow, dir.row]}>
          <Text style={styles.timer}>{fmt(secs)}</Text>
          {p.level ? <LevelBars level={p.level} live /> : null}
        </View>
      ) : null}

      {/* The count's own fixed box: one disc for the whole count, only its digit changes. */}
      <View pointerEvents="none" style={styles.countBox}>
        {counting ? (
          <Animated.View entering={fadeIn} exiting={fadeOut} style={styles.digit}>
            <Tile look={look} size={112} radius={56} fontSize={58}>{p.beat}</Tile>
          </Animated.View>
        ) : null}
      </View>

      <View style={styles.ctr}>
        {counting ? (
          <Animated.Text entering={fadeIn} exiting={fadeOut} style={styles.small}>
            {t('ladder.startsAfter', { n: p.beat ?? 0 })}
          </Animated.Text>
        ) : null}
        {rec ? (
          <>
            <Pressable
              onPress={p.onStop ?? p.onEnd}
              accessibilityRole="button"
              accessibilityLabel={t('ladder.tapStop')}
              style={[styles.stop, stopped && { opacity: 0.5 }]}>
              <View style={styles.stopSq} />
            </Pressable>
            <Text style={styles.small}>{t('ladder.tapStop')}</Text>
          </>
        ) : null}
        {(frame === 'listen' || frame === 'compare') && !counting ? (
          <Animated.View entering={fadeIn} exiting={fadeOut}>
            <BluePill icon="⏸" label={t('ladder.pause')} onPress={p.onEnd} />
          </Animated.View>
        ) : null}
        {showTiles ? (
          <Animated.View entering={fadeIn} exiting={fadeOut}>
            <Pill label={t('ladder.again')} icon="🔁" kind="tools" onPress={() => p.onJump(p.index)} />
          </Animated.View>
        ) : null}
        {frame === 'final' && waiting ? (
          <View style={[styles.pills, dir.row]}>
            <Pill label={t('ladder.peek')} icon="👁" kind="tools" onPress={onPeek} />
            <Pill label={t('ladder.record')} icon="🎙" kind="speak" big onPress={record} />
          </View>
        ) : null}
        {frame === 'ready' && waiting ? <Pill label={t('ladder.record')} icon="🎙" kind="speak" big onPress={record} /> : null}
      </View>
    </Animated.View>
  );
}

/** The mock's stage background: 180deg #070A12, #101A2A at 55%, #16243A. */
function StageSky({ w, h }: { w: number; h: number }) {
  if (!(w > 0) || !(h > 0)) return null;
  return (
    <Canvas style={StyleSheet.absoluteFill} pointerEvents="none">
      <Rect x={0} y={0} width={w} height={h}>
        <LinearGradient start={vec(0, 0)} end={vec(0, h)} colors={[...tideSkies.night]} positions={[0, 0.55, 1]} />
      </Rect>
    </Canvas>
  );
}

/**
 * The ladder's stage view, laid over the player under its header: the emoji
 * rail, the line card (text hidden to blocks on the blind take) and the stage
 * sheet. Mounted by the island, video and podcast players for the five-stage
 * ladder; once the run is done the player's own dock is back. `top` is the space above it: the
 * island's own header by default, 0 under a native header, the video's height
 * under a video. `followsReveal` is for the island player, the only one whose content fades in
 * through lib/content-reveal.
 */
export const LadderStageView = memo(function LadderStageView({ top, followsReveal, ...p }: LadderStageProps & { top?: number; followsReveal?: boolean }) {
  const insets = useSafeAreaInsets();
  const reduced = useReducedMotion();
  const { width } = useWindowDimensions();
  const [h, setH] = useState(0);
  // The room under the rail (the score band, the card's gap and the sheet's space).
  const [roomH, setRoomH] = useState(0);
  const frame = frameOf(p);
  // Peek lives here so the Sheet's pill reveals the Card's text.
  const [peek, setPeek] = useState(false);
  // XP paid while the stage is up pops in its score band, not the toast.
  useEffect(() => holdInlineXp(), []);
  useEffect(() => setPeek(false), [p.textHidden, p.index, p.round]);
  const sheetBottom = Math.max(insets.bottom - 8, 12);
  // The gap between the rail and the sheet that the line card fits into, less
  // the score band's open height while it has a score to show. Taken from the
  // band's end state, not its animated height, so the card fits once per change.
  const roomGap = roomH > 0 ? Math.max(0, roomH - sheetBottom - SHEET_H) : 0;
  const tight = roomH > 0 && roomGap - SCORE_H < CARD_NEED + (p.chip ? CHIP_ROW : 0);
  const gapH = roomH > 0 ? Math.max(0, roomGap - (bandOpen(p.score) && !tight ? SCORE_H : 0)) : 0;
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
      entering={reduced || behindLoader || overReveal ? undefined : FadeIn.duration(220).easing(OUT)}
      exiting={reduced ? undefined : FadeOut.duration(180)}
      onLayout={(e) => setH(e.nativeEvent.layout.height || 0)}
      style={[styles.root, { backgroundColor: tideSkies.night[1], top: top ?? insets.top + HEADER_H }]}>
      <StageSky w={width} h={h} />
      <Animated.View style={[styles.fill, gateStyle]}>
        <Rail p={p} frame={frame} />
        <View style={styles.fill} onLayout={(e) => setRoomH(Math.round(e.nativeEvent.layout.height) || 0)}>
          <ScoreBand score={p.score} index={p.index} compact={tight} />
          <View style={[styles.cardWrap, { marginBottom: sheetBottom + SHEET_H }]}>
            {gapH > 0 ? <Card p={p} frame={frame} hidden={p.textHidden && !peek} maxH={gapH} /> : null}
          </View>
        </View>
        <View style={[styles.sheetBox, { bottom: sheetBottom }]}>
          <Sheet p={p} frame={frame} onPeek={() => setPeek((v) => !v)} tight={tight} />
        </View>
      </Animated.View>
    </Animated.View>
  );
});

const styles = StyleSheet.create({
  // Opaque and clipped: nothing of the player under it shows or pokes through.
  root: { position: 'absolute', left: 0, right: 0, bottom: 0, zIndex: 20, elevation: 20, overflow: 'hidden' },
  fill: { flex: 1 },
  // bl58-easy-for-me: the Easy chip's row at the card's top.
  chipRow: { flexDirection: 'row', justifyContent: 'flex-end', paddingTop: 8, paddingHorizontal: 12, zIndex: 6 },
  rail: {
    marginTop: 6,
    marginHorizontal: 16,
    height: 64,
    borderRadius: 32,
    paddingHorizontal: 6,
    flexDirection: 'row',
    alignItems: 'center',
    overflow: 'hidden',
    backgroundColor: GLASS,
    borderWidth: 1,
    borderColor: RIM,
  },
  // Spelled out: react-native-web reads `flex: 0` as a zero basis and the stations collapse to 0 wide.
  stWrap: { flexGrow: 0, flexShrink: 0 },
  st: { height: 48, flexDirection: 'row', alignItems: 'center', gap: 8, borderRadius: 24 },
  stCur: { paddingLeft: 3, paddingRight: 10 },
  stCurRtl: { paddingRight: 3, paddingLeft: 10 },
  stName: { fontFamily: fonts.uiMedium, fontWeight: '700', fontSize: 13, color: '#fff', flexShrink: 1 },
  ln: { flex: 1, height: 2, marginHorizontal: 2, minWidth: 2, backgroundColor: 'rgba(255,255,255,0.14)' },
  lnDone: { backgroundColor: 'rgba(255,255,255,0.4)' },
  tile: { alignItems: 'center', justifyContent: 'center', borderWidth: 1 },
  tileText: { color: tide.text, fontWeight: '700' },
  // The band clips while it opens or closes; its content keeps the full height, top-anchored.
  scoreBand: { overflow: 'hidden' },
  scoreInner: { height: SCORE_H, alignItems: 'center', justifyContent: 'center' },
  scoreIn: { alignItems: 'center' },
  scoreInEnd: { alignItems: 'flex-end' },
  scoreRow: { flexDirection: 'row', alignItems: 'baseline', gap: 4 },
  scoreNum: { fontFamily: fonts.uiMedium, fontSize: 44, lineHeight: 50, fontWeight: '700', fontVariant: ['tabular-nums'] },
  scoreOf: { fontFamily: fonts.ui, fontSize: 17, color: tide.textDim },
  scoreNumC: { fontSize: 28, lineHeight: 32 },
  scoreOfC: { fontSize: 14 },
  scoreKeptC: { marginTop: 0, fontSize: 12, lineHeight: 16 },
  scoreKept: { marginTop: 2, fontFamily: fonts.ui, fontSize: 13, lineHeight: 18, color: tide.textDim },
  scoring: { fontFamily: fonts.ui, fontSize: 13, color: tide.textDim },
  // Right of the centred score (its row is up to about 120pt wide), level with the number.
  xpBeside: { position: 'absolute', left: '50%', marginLeft: 66, top: 18, maxWidth: 120 },
  // Hebrew reads the score first from the right, so the XP sits to its left.
  xpBesideRtl: { position: 'absolute', right: '50%', marginRight: 66, top: 18, maxWidth: 120 },
  // In the sheet's title row: beside the compact score, on the title's side of it.
  xpInline: { position: 'absolute', right: '100%', marginRight: 10, top: 4, maxWidth: 120 },
  xpInlineRtl: { position: 'absolute', left: '100%', marginLeft: 10, top: 4, maxWidth: 120 },
  xpAlone: { position: 'absolute', left: 0, right: 0, top: 26, alignItems: 'center' },
  xpText: { fontFamily: fonts.ui, fontSize: 15, fontWeight: '700', color: XP_GOLD },
  xpCap: { fontFamily: fonts.ui, fontSize: 12, lineHeight: 16, color: tide.textDim },
  cardWrap: { flex: 1, justifyContent: 'center', overflow: 'hidden' },
  card: {
    marginHorizontal: 16,
    borderRadius: 24,
    overflow: 'hidden',
    backgroundColor: GLASS,
    borderWidth: 1,
    borderColor: RIM,
  },
  cardBody: { paddingTop: 12, paddingHorizontal: 20, paddingBottom: 16 },
  fitting: { opacity: 0 },
  units: { flexDirection: 'row', flexWrap: 'wrap', columnGap: 8 },
  unit: { flexDirection: 'row' },
  plain: { fontFamily: fonts.serifJp, fontWeight: '600', color: '#F5F5FA' },
  blocks: { position: 'absolute', left: 20, right: 20, top: 12, flexDirection: 'row', flexWrap: 'wrap' },
  blockRow: { justifyContent: 'center' },
  block: {
    height: 18,
    borderRadius: 8,
    marginHorizontal: 2,
    backgroundColor: 'rgba(244,242,248,0.14)',
    borderWidth: 1,
    borderColor: 'rgba(244,242,248,0.22)',
  },
  cardPress: { flexShrink: 1 },
  // Gives way to the English when the card is at its full height.
  cardScroll: { flexGrow: 0, flexShrink: 1 },
  // The English under the text: its slot opens to the text's height, the text keeps its own. It never
  // draws over the Japanese: a card at its full height clips the Japanese at the slot's top edge.
  enSlot: { overflow: 'hidden' },
  en: { position: 'absolute', top: 0, left: 20, right: 20, paddingTop: 4, paddingBottom: 16, fontFamily: fonts.ui, fontSize: 14, lineHeight: 21, color: tide.textDim },
  // M10's `.card .ul`: 12% in from each side, 3pt tall, the stage green over its quarter-alpha track.
  ul: { position: 'absolute', left: '12%', right: '12%', bottom: 3, height: 3, borderRadius: 2, overflow: 'hidden', backgroundColor: withAlpha(verb.along.c1, 0.25) },
  ulFill: { height: 3, borderRadius: 2, backgroundColor: verb.along.c1 },
  recRim: { ...StyleSheet.absoluteFill, borderRadius: 24, borderLeftWidth: 3, borderColor: tide.record },
  recRimRtl: { borderLeftWidth: 0, borderRightWidth: 3 },
  sheetBox: { position: 'absolute', left: 8, right: 8, height: SHEET_H },
  sheet: {
    flex: 1,
    borderRadius: 32,
    paddingTop: 20,
    paddingHorizontal: 20,
    backgroundColor: 'rgba(14,22,38,0.94)',
  },
  titleRow: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  h3: { fontFamily: fonts.uiMedium, fontSize: 22, fontWeight: '700', color: tide.text },
  // M10's `.pill`: the Ready badge beside the title, tinted by the stage.
  badge: { height: 22, borderRadius: 11, paddingHorizontal: 9, borderWidth: 1, alignItems: 'center', justifyContent: 'center' },
  badgeText: { fontFamily: fonts.uiMedium, fontSize: 12, fontWeight: '600', color: '#fff' },
  p: { marginTop: 4, fontFamily: fonts.ui, fontSize: 14, lineHeight: 20, color: tide.textDim },
  blink: { width: 10, height: 10, borderRadius: 5, backgroundColor: tide.record, shadowColor: tide.record, shadowOpacity: 1, shadowRadius: 10, shadowOffset: { width: 0, height: 0 } },
  tightScore: { marginLeft: 'auto', alignItems: 'flex-end' },
  afterScore: { marginLeft: 10 },
  motif: { marginLeft: 'auto', fontSize: 22 },
  lineMotif: { marginLeft: 'auto', gap: 4, alignItems: 'flex-end' },
  lmBar: { height: 4, borderRadius: 2 },
  waveBox: { marginTop: 30, height: 44, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 4 },
  bar: { width: 4, borderRadius: 2 },
  tiles: { marginTop: 28, flexDirection: 'row', justifyContent: 'center', gap: 14 },
  recRow: { marginTop: 18, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  timer: { fontVariant: ['tabular-nums'], fontSize: 40, fontWeight: '700', color: '#fff' },
  ctr: { position: 'absolute', left: 0, right: 0, bottom: 22, alignItems: 'center', gap: 10 },
  countBox: { position: 'absolute', left: 0, right: 0, bottom: 70, height: 112, alignItems: 'center' },
  digit: { position: 'absolute', top: 0 },
  pills: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  pillIcon: { fontSize: 15 },
  bluePill: {
    height: 56,
    borderRadius: 28,
    paddingHorizontal: 30,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    backgroundColor: 'rgba(124,200,255,0.12)',
    borderWidth: 1,
    borderColor: 'rgba(124,200,255,0.45)',
  },
  blueText: { fontFamily: fonts.uiMedium, fontSize: 17, fontWeight: '600', color: verb.listen.c1 },
  ib: {
    width: 36,
    height: 36,
    borderRadius: 18,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(255,255,255,0.08)',
    borderWidth: 1,
    borderColor: RIM,
  },
  ibText: { fontSize: 15, color: tide.text },
  small: { fontFamily: fonts.ui, fontSize: 13, color: tide.textDim },
  stop: {
    width: 76,
    height: 76,
    borderRadius: 38,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(255,84,104,0.2)',
    borderWidth: 2,
    borderColor: tide.record,
    shadowColor: tide.record,
    shadowOpacity: 0.5,
    shadowRadius: 28,
    shadowOffset: { width: 0, height: 0 },
  },
  stopSq: { width: 26, height: 26, borderRadius: 7, backgroundColor: tide.record },
});
