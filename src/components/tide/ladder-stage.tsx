import { Canvas, LinearGradient, Rect, RoundedRect, vec } from '@shopify/react-native-skia';
import { memo, useEffect, useMemo, useState, type ReactNode } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, useWindowDimensions, View } from 'react-native';
import Animated, {
  Easing,
  FadeIn,
  FadeOut,
  Keyframe,
  LinearTransition,
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

// Built to the approved mock .claude/design/A2-r2.html: the emoji stage rail
// under the header, the 36pt line card centred in the gap, the stage sheet in
// the thumb zone. Motion is damped timing only (no springs).

const HEADER_H = 48;
const SHEET_H = 318;
// The score band under the rail: the 44pt number's 50pt line, the 13pt kept-up line and their gaps.
const SCORE_H = 78;
const LINE_PT = 36;
// The card's text steps down from 36pt in 2pt steps to fit the gap, never under 20pt (then it scrolls).
const LINE_MIN = 20;
const LINE_STEP = 2;
// The card's padding and rim around the text, and the English line under it.
const CARD_PAD_V = 12 + 16 + 2;
const CARD_PAD_H = 16 * 2 + 20 * 2 + 2;
const EN_H = 23;
const GLASS = 'rgba(20,28,44,0.72)';
const RIM = 'rgba(255,255,255,0.14)';
const noop = () => {};
const OUT = Easing.out(Easing.cubic);
// The gold of the XP toast (session-celebration.tsx), for the score band's "+N XP".
const XP_GOLD = '#FFC857';

// The count digits crossfade: the outgoing one fades out shrinking to 0.94,
// the incoming one fades in settling from 1.06, both 220ms.
const DIGIT_IN = new Keyframe({
  0: { opacity: 0, transform: [{ scale: 1.06 }] },
  100: { opacity: 1, transform: [{ scale: 1 }], easing: OUT },
}).duration(220);
const DIGIT_OUT = new Keyframe({
  0: { opacity: 1, transform: [{ scale: 1 }] },
  100: { opacity: 0, transform: [{ scale: 0.94 }], easing: OUT },
}).duration(220);

/**
 * The largest size, 36pt down to 20pt in 2pt steps, at which `chars`
 * characters are guessed to fit `w` by `h`. A first guess so the fit rarely
 * shows a step; the card's measured height has the last word.
 */
function guessPt(chars: number, enLines: number, w: number, h: number): number {
  for (let pt = LINE_PT; pt > LINE_MIN; pt -= LINE_STEP) {
    const perRow = Math.max(1, Math.floor(w / pt));
    const rows = Math.ceil(Math.max(chars, 1) / perRow);
    if (rows * pt * 1.6 + enLines * EN_H + CARD_PAD_V <= h) return pt;
  }
  return LINE_MIN;
}

type Frame = 'listen' | 'memorise' | 'say' | 'ready' | 'recording' | 'final' | 'compare';
type TKey = Parameters<ReturnType<typeof useT>['t']>[0];

/** A tile's look from the mock: its tint and the 145deg gradient's two alphas and rim. */
export type Look = { tint: string; from: number; to: number; rim: number; glow?: boolean };
const LISTEN: Look = { tint: verb.listen.c1, from: 0.38, to: 0.12, rim: 0.5 };
const MEM: Look = { tint: verb.read.c1, from: 0.38, to: 0.12, rim: 0.5 };
const READY: Look = { tint: verb.listen.c2, from: 0.38, to: 0.12, rim: 0.5 };
const REC: Look = { tint: verb.speak.c1, from: 0.55, to: 0.2, rim: 0.8, glow: true };
const FIN: Look = { tint: verb.tools.c1, from: 0.28, to: 0.08, rim: 0.45 };

/** The mock's five rail stations, in its order: Listen, Memorise, Get ready, Recording, Final take. */
const STATIONS: readonly { emoji: string; look: Look; name: TKey }[] = [
  { emoji: '👂', look: LISTEN, name: 'settings.onboarding.passListenTitle' },
  { emoji: '📖', look: MEM, name: 'settings.onboarding.passMemoriseTitle' },
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
  memorise: MEM,
  say: MEM,
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
  const count = p.finalOn === false ? STATIONS.length - 1 : STATIONS.length;
  const at = stationOf(p, frame, count);
  // A station tap jumps to its stage: Get ready and Recording both count in to the take.
  const jump = (i: number) => {
    if (i === 4) (p.onFinal ?? (() => p.onJump(3)))();
    else p.onJump(i >= 2 ? 3 : i);
  };
  const items: ReactNode[] = [];
  for (let i = 0; i < count; i++) {
    const st = STATIONS[i]!;
    const cur = i === at;
    const done = i < at;
    if (i > 0) items.push(<View key={`l${i}`} style={[styles.ln, i <= at && styles.lnDone]} />);
    items.push(
      <Animated.View key={i} layout={layout} style={styles.stWrap}>
        <Pressable
          onPress={() => jump(i)}
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
  const line = p.line ?? null;
  const words = line && line.words.length > 0 ? line.words : null;
  const units = useMemo(() => (words ? kinsokuUnits(words) : []), [words]);
  const chars = words ? words.reduce((n, w) => n + w.text.length, 0) : p.text.length;
  const innerW = Math.max(width - CARD_PAD_H, 1);
  const enLines = line?.en ? Math.ceil((line.en.length * 7) / innerW) : 0;
  // The fit restarts from the guess for each line and each gap height; the
  // text stays hidden until the measured card fits (or reaches 20pt).
  const key = `${p.index}|${p.text}|${Math.round(maxH)}`;
  const [fit, setFit] = useState({ key, pt: guessPt(chars, enLines, innerW, maxH), done: false });
  if (fit.key !== key) setFit({ key, pt: guessPt(chars, enLines, innerW, maxH), done: false });
  const onSize = (_w: number, h: number) => {
    if (fit.key !== key || fit.done || !(h > 0)) return;
    if (h + 2 > maxH && fit.pt > LINE_MIN) setFit({ key, pt: Math.max(LINE_MIN, fit.pt - LINE_STEP), done: false });
    else setFit({ key, pt: fit.pt, done: true });
  };
  const pt = fit.pt;
  const rowH = pt * 1.9;
  const plain = { fontSize: pt, lineHeight: pt * 1.75 };
  return (
    <View style={[styles.card, { maxHeight: maxH }]}>
      {/* Remounted per line and per size step, so each one reports its height. */}
      <ScrollView
        key={`${key}|${pt}`}
        bounces={false}
        showsVerticalScrollIndicator={false}
        contentContainerStyle={[styles.cardBody, !fit.done && styles.fitting]}
        onContentSizeChange={onSize}>
        <Animated.View style={textStyle} pointerEvents="none">
          {words ? (
            <View style={styles.units}>
              {units.map((unit) => (
                <View key={unit[0]} style={styles.unit}>
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
        {line?.en ? <Text style={[styles.en, dir.content]}>{line.en}</Text> : null}
      </ScrollView>
      <Animated.View pointerEvents="none" style={[styles.recRim, dir.rtl && styles.recRimRtl, rimStyle]} />
    </View>
  );
}

function Pill({ label, icon, kind, onPress, big }: { label: string; icon?: string; kind: 'tools' | 'read' | 'speak' | 'listen'; onPress: () => void; big?: boolean }) {
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
function ScoreValue({ total, keptUp }: { total: number; keptUp?: string }) {
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
    <Animated.View style={[styles.scoreIn, rise]}>
      <View style={styles.scoreRow}>
        <Text style={[styles.scoreNum, { color: colour }]}>{Math.round(total)}</Text>
        <Text style={styles.scoreOf}>/100</Text>
      </View>
      {keptUp ? <Text style={styles.scoreKept}>{keptUp}</Text> : null}
    </Animated.View>
  );
}

/**
 * The XP a take (or any award while the stage is up) paid: a small gold
 * "+N XP" next to the score that fades in rising 10pt over 600ms out-cubic,
 * holds 1.2s, then fades out. Only a pop after this view mounted plays.
 */
function XpPop({ beside }: { beside: boolean }) {
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
    <Animated.View style={[beside ? (dir.rtl ? styles.xpBesideRtl : styles.xpBeside) : styles.xpAlone, style]}>
      <Text style={[styles.xpText, beside && dir.text]}>{isolate(t('review.xpEarned', { n: cap ? 0 : n }))}</Text>
      {cap ? <Text style={[styles.xpCap, beside ? dir.text : { textAlign: 'center' }, dir.writing]}>{t('ladder.xpCap')}</Text> : null}
    </Animated.View>
  );
}

/** The score's fixed band under the rail: the take's score, "Scoring…" while it computes, else empty. */
function ScoreBand({ score }: { score: LadderStageProps['score'] }) {
  const { t } = useT();
  const total = score?.total;
  const on = typeof total === 'number' && Number.isFinite(total);
  return (
    <View style={styles.scoreBand} pointerEvents="none">
      {on ? (
        <ScoreValue key={`${total}|${score?.keptUp ?? ''}|${score?.at ?? 0}`} total={total} keptUp={score?.keptUp} />
      ) : score?.scoring ? (
        <Text style={styles.scoring}>{t('ladder.scoring')}</Text>
      ) : null}
      <XpPop beside={on} />
    </View>
  );
}

function Sheet({ p, frame, onPeek }: { p: LadderStageProps; frame: Frame; onPeek: () => void }) {
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
  // What the count swaps out (the wave, the repeat tiles) fades with the digits' 220ms.
  const fadeIn = reduced ? undefined : FadeIn.duration(220).easing(OUT);
  const fadeOut = reduced ? undefined : FadeOut.duration(220).easing(OUT);
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

      {/* The count's own fixed box: its digits crossfade in place, nothing else moves. */}
      <View pointerEvents="none" style={styles.countBox}>
        {counting ? (
          <Animated.View
            key={p.beat}
            entering={reduced ? undefined : DIGIT_IN}
            exiting={reduced ? undefined : DIGIT_OUT}
            style={styles.digit}>
            <Tile look={look} size={112} radius={56} fontSize={58}>{p.beat}</Tile>
          </Animated.View>
        ) : null}
      </View>

      <View style={styles.ctr}>
        {counting ? <Text style={styles.small}>{t('ladder.startsAfter', { n: p.beat ?? 0 })}</Text> : null}
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
          <BluePill icon="⏸" label={t('ladder.pause')} onPress={p.onEnd} />
        ) : null}
        {(frame === 'memorise' || frame === 'say') && !counting ? (
          <View style={[styles.pills, dir.row]}>
            <Pill label={t('ladder.again')} icon="🔁" kind="tools" onPress={() => p.onJump(p.index)} />
            <Pill label={t('ladder.ready')} kind="read" onPress={next} />
          </View>
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
 * under a video.
 */
export const LadderStageView = memo(function LadderStageView({ top, ...p }: LadderStageProps & { top?: number }) {
  const insets = useSafeAreaInsets();
  const reduced = useReducedMotion();
  const { width } = useWindowDimensions();
  const [h, setH] = useState(0);
  // The gap between the rail and the sheet, which the line card fits into.
  const [gapH, setGapH] = useState(0);
  const frame = frameOf(p);
  // Peek lives here so the Sheet's pill reveals the Card's text.
  const [peek, setPeek] = useState(false);
  // XP paid while the stage is up pops in its score band, not the toast.
  useEffect(() => holdInlineXp(), []);
  useEffect(() => setPeek(false), [p.textHidden, p.index, p.round]);
  const sheetBottom = Math.max(insets.bottom - 8, 12);
  return (
    <Animated.View
      entering={reduced ? undefined : FadeIn.duration(220).easing(OUT)}
      exiting={reduced ? undefined : FadeOut.duration(180)}
      onLayout={(e) => setH(e.nativeEvent.layout.height || 0)}
      style={[styles.root, { backgroundColor: tideSkies.night[1], top: top ?? insets.top + HEADER_H }]}>
      <StageSky w={width} h={h} />
      <Rail p={p} frame={frame} />
      <ScoreBand score={p.score} />
      <View
        style={[styles.cardWrap, { marginBottom: sheetBottom + SHEET_H }]}
        onLayout={(e) => setGapH(Math.round(e.nativeEvent.layout.height) || 0)}>
        {gapH > 0 ? <Card p={p} frame={frame} hidden={p.textHidden && !peek} maxH={gapH} /> : null}
      </View>
      <View style={[styles.sheetBox, { bottom: sheetBottom }]}>
        <Sheet p={p} frame={frame} onPeek={() => setPeek((v) => !v)} />
      </View>
    </Animated.View>
  );
});

const styles = StyleSheet.create({
  // Opaque and clipped: nothing of the player under it shows or pokes through.
  root: { position: 'absolute', left: 0, right: 0, bottom: 0, zIndex: 20, elevation: 20, overflow: 'hidden' },
  rail: {
    marginTop: 6,
    marginHorizontal: 16,
    height: 64,
    borderRadius: 32,
    paddingHorizontal: 8,
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: GLASS,
    borderWidth: 1,
    borderColor: RIM,
  },
  stWrap: { flex: 0 },
  st: { height: 48, flexDirection: 'row', alignItems: 'center', gap: 8, borderRadius: 24 },
  stCur: { paddingLeft: 3, paddingRight: 10 },
  stCurRtl: { paddingRight: 3, paddingLeft: 10 },
  stName: { fontFamily: fonts.uiMedium, fontWeight: '700', fontSize: 13, color: '#fff' },
  ln: { flex: 1, height: 2, marginHorizontal: 2, minWidth: 4, backgroundColor: 'rgba(255,255,255,0.14)' },
  lnDone: { backgroundColor: 'rgba(255,255,255,0.4)' },
  tile: { alignItems: 'center', justifyContent: 'center', borderWidth: 1 },
  tileText: { color: tide.text, fontWeight: '700' },
  // A fixed height whether it holds a score, "Scoring…" or nothing, so the card never jumps.
  scoreBand: { height: SCORE_H, alignItems: 'center', justifyContent: 'center' },
  scoreIn: { alignItems: 'center' },
  scoreRow: { flexDirection: 'row', alignItems: 'baseline', gap: 4 },
  scoreNum: { fontFamily: fonts.uiMedium, fontSize: 44, lineHeight: 50, fontWeight: '700', fontVariant: ['tabular-nums'] },
  scoreOf: { fontFamily: fonts.ui, fontSize: 17, color: tide.textDim },
  scoreKept: { marginTop: 2, fontFamily: fonts.ui, fontSize: 13, lineHeight: 18, color: tide.textDim },
  scoring: { fontFamily: fonts.ui, fontSize: 13, color: tide.textDim },
  // Right of the centred score (its row is up to about 120pt wide), level with the number.
  xpBeside: { position: 'absolute', left: '50%', marginLeft: 66, top: 18, maxWidth: 120 },
  // Hebrew reads the score first from the right, so the XP sits to its left.
  xpBesideRtl: { position: 'absolute', right: '50%', marginRight: 66, top: 18, maxWidth: 120 },
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
  en: { marginTop: 2, fontFamily: fonts.ui, fontSize: 14, lineHeight: 21, color: tide.textDim },
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
  p: { marginTop: 4, fontFamily: fonts.ui, fontSize: 14, lineHeight: 20, color: tide.textDim },
  blink: { width: 10, height: 10, borderRadius: 5, backgroundColor: tide.record, shadowColor: tide.record, shadowOpacity: 1, shadowRadius: 10, shadowOffset: { width: 0, height: 0 } },
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
