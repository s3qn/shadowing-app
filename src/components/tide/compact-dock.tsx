import { memo, type ReactNode, useCallback, useEffect, useRef, useState } from 'react';
import { type LayoutChangeEvent, Pressable, StyleSheet, Text, View } from 'react-native';
import Animated, {
  Easing,
  cancelAnimation,
  interpolate,
  useAnimatedReaction,
  useAnimatedStyle,
  useDerivedValue,
  useReducedMotion,
  useSharedValue,
  withDelay,
  withSpring,
  withTiming,
  type SharedValue,
} from 'react-native-reanimated';
import { Canvas, Circle, Group, LinearGradient, Path, vec } from '@shopify/react-native-skia';
import { SymbolView } from 'expo-symbols';

import { GlassPanel } from '@/components/prism/glass-panel';
import { PrismFace } from '@/components/prism/prism-face';
import { DOCK_PILL_H, DOCK_PILL_W, POP } from '@/components/tide/popover-bubble';
import { speedLabel } from '@/components/tide/speed-popover';
import { fonts } from '@/constants/fonts';
import { Radius, prism, tide, verb, withAlpha } from '@/constants/theme';
import { hapticImpact } from '@/lib/haptics';
import { useT } from '@/lib/i18n';
import { COUNT_IN_BEAT_MS } from '@/lib/pass-programme';

export type DockAnchorKey = 'speed' | 'repeat' | 'reading' | 'blind' | 'play' | 'record';
/** A control's box, relative to the dock's root View. Tray pills sit above the capsule, so their y is negative. */
export type DockAnchor = { x: number; y: number; width: number };
export type DockPill = {
  key: 'repeat' | 'reading' | 'blind' | 'catch';
  /** 17 pt icon. The screen colours it: `DOCK_GOLD_INK` when on, `tide.textDim` when off. */
  icon: ReactNode;
  value: string;
  on: boolean;
  /** Its popover is open: a gold ring. Optional, the screen sets it. */
  selected?: boolean;
  onPress: () => void;
};

export type CompactDockProps = {
  playMode: 'idle' | 'playing';
  onToggle: () => void;
  onPrev: () => void;
  onNext: () => void;
  prevDisabled: boolean;
  nextDisabled: boolean;
  recording: boolean;
  /** 0..1 live meter level, read on the UI thread so a sample never renders the dock. */
  level: SharedValue<number>;
  onRecord: () => void;
  recordLabel: string;
  /** The Shadow ring's stage arc: 0..4 while the five stages run, undefined or -1 when idle. */
  stageIndex?: number;
  speed: number;
  speedOn: boolean;
  /** The chip tap: the screen opens its SpeedPopover. */
  onSpeed: () => void;
  /** Tray pills. An empty list hides the gear entirely. */
  pills: DockPill[];
  trayOpen: boolean;
  onTrayToggle: () => void;
  /** Fullscreen video: no chip, no gear. */
  compact?: boolean;
  /** Rendered above the capsule, centred, 8 pt gap. */
  slot?: ReactNode;
  /** What the Shadow button shows: the ring, the count digit, or a dimmed ring (press off). 'stop' keeps the ring: the arc marks the stage. */
  face?: 'dot' | 'count' | 'stop' | 'dim';
  /** The beat the count is on (3, 2, 1), or null. Pulses one ring per beat. */
  countIn?: number | null;
  /** One count beat in ms, so the beat ring matches the pace. Defaults to Auto Echo's. */
  beatMs?: number;
  /** The play face is off (a count, a recording or a take is playing). */
  ringDisabled?: boolean;
  /** Mid-run: the chip and the gear are off and the tray stays closed. */
  locked?: boolean;
  /** Called only when a box changed. */
  onAnchor: (key: DockAnchorKey, box: DockAnchor) => void;
};

/** The ink of anything "on" in the dock: gold means on. */
export const DOCK_GOLD_INK = POP.goldInk;

const CAPSULE_H = 56;
const HIT = 44;
const GAP = 8;
const MAX_PILLS = 4;
const OPEN_SPRING = { damping: 20, stiffness: 220 } as const;
const GOLD_FILL = withAlpha(verb.read.c1, 0.12);
const GOLD_RING = withAlpha(verb.read.c1, 0.4);

const num = (v: number, fallback = 0) => {
  'worklet';
  return Number.isFinite(v) ? v : fallback;
};

/** A 44 pt hit box that scales on press (Tide Drop, scale form). */
function DockPress({
  onPress,
  disabled,
  label,
  pressed: pressedScale = 0.96,
  pressT,
  style,
  children,
}: {
  onPress: () => void;
  disabled?: boolean;
  label: string;
  pressed?: number;
  /** 1 while held, 0 otherwise. The Shadow ring draws its lip from it. */
  pressT?: SharedValue<number>;
  style?: object;
  children: ReactNode;
}) {
  const reduced = useReducedMotion();
  const scale = useSharedValue(1);
  const animated = useAnimatedStyle(() => ({ transform: [{ scale: num(scale.value, 1) }] }));
  useEffect(
    () => () => {
      cancelAnimation(scale);
    },
    [scale],
  );
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      disabled={disabled}
      onPress={onPress}
      onPressIn={() => {
        if (disabled) return;
        void hapticImpact();
        if (pressT) pressT.value = 1;
        if (!reduced) scale.value = withTiming(pressedScale, { duration: 80, easing: Easing.out(Easing.quad) });
      }}
      onPressOut={() => {
        if (pressT) pressT.value = 0;
        if (!reduced) scale.value = withSpring(1, prism.press.spring);
      }}>
      <Animated.View style={[styles.hit, style, disabled && styles.disabled, animated]}>{children}</Animated.View>
    </Pressable>
  );
}

const SHADOW_BLUE = '#7CC8FF';
const SHADOW_RED = '#FF5468';
/** R04 gradient stops: red 85% to 15%, blue from 40%. */
const FRINGE = [withAlpha(SHADOW_RED, 0.85), withAlpha(SHADOW_RED, 0.85), SHADOW_BLUE, SHADOW_BLUE];
const FRINGE_AT = [0, 0.15, 0.4, 1];
/** Segments 2 (Mumble) and 3 (Read along) take their stage pair, c1 to c2 (M10). */
const SEG_COLORS: Record<number, string[]> = {
  1: [verb.mumble.c1, verb.mumble.c2],
  2: [verb.along.c1, verb.along.c2],
};
/** The canvas is 38 + 2 * PAD so the 3pt current segment is not clipped at the 38 box. */
const PAD = 2;
const SEG_LEN = 18.62;
const SEG_STEP = SEG_LEN + 4;
const STAGE_COUNT = 5;

/** One stage segment of the arc, from 12 o'clock, in canvas coordinates. */
function segmentPath(i: number) {
  const pt = (arc: number) => {
    const a = -Math.PI / 2 + arc / 18;
    return `${(PAD + 19 + 18 * Math.cos(a)).toFixed(3)} ${(PAD + 19 + 18 * Math.sin(a)).toFixed(3)}`;
  };
  const start = 2 + SEG_STEP * i;
  return `M${pt(start)}A18 18 0 0 1 ${pt(start + SEG_LEN)}`;
}
const SEGMENTS = Array.from({ length: STAGE_COUNT }, (_, i) => segmentPath(i));

/** Current stage 3pt full, finished 2.4pt full, upcoming 2.4pt at 0.22. Crossfades over 200 ms. */
function Segment({ d, i, stage }: { d: string; i: number; stage: number }) {
  const w = useSharedValue(i === stage ? 3 : 2.4);
  const a = useSharedValue(i > stage ? 0.22 : 1);
  useEffect(() => {
    const ease = { duration: 200, easing: Easing.out(Easing.quad) };
    w.value = withTiming(i === stage ? 3 : 2.4, ease);
    a.value = withTiming(i > stage ? 0.22 : 1, ease);
    return () => {
      cancelAnimation(w);
      cancelAnimation(a);
    };
  }, [i, stage, w, a]);
  const width = useDerivedValue(() => num(w.value, 2.4));
  const opacity = useDerivedValue(() => num(a.value, 1));
  return (
    <Path path={d} style="stroke" strokeWidth={width} opacity={opacity}>
      <LinearGradient start={vec(PAD + 1, 0)} end={vec(PAD + 37, 0)} colors={SEG_COLORS[i] ?? FRINGE} positions={SEG_COLORS[i] ? undefined : FRINGE_AT} />
    </Path>
  );
}

/**
 * The Shadow button's face (designs/bl56/R04): a hollow Prism Edge ring, a white
 * top line and two offset sound arcs with a dot. While the stages run the ring
 * becomes five segments. Pressed, only the lip disc shows.
 */
function ShadowRing({ stage, pressT, hideGlyph }: { stage: number; pressT: SharedValue<number>; hideGlyph: boolean }) {
  const running = Number.isFinite(stage) && stage >= 0;
  const lip = useDerivedValue(() => 0.28 * num(pressT.value));
  const ringGrad = <LinearGradient start={vec(PAD + 1, 0)} end={vec(PAD + 37, 0)} colors={FRINGE} positions={FRINGE_AT} />;
  const glyphGrad = <LinearGradient start={vec(PAD + 9, 0)} end={vec(PAD + 29, 0)} colors={FRINGE} positions={FRINGE_AT} />;
  const c = PAD + 19;
  return (
    <Canvas pointerEvents="none" style={styles.shadowCanvas}>
      <Circle cx={c} cy={c} r={17} opacity={lip}>
        {ringGrad}
      </Circle>
      {running ? (
        SEGMENTS.map((d, i) => <Segment key={i} d={d} i={i} stage={stage} />)
      ) : (
        <Circle cx={c} cy={c} r={18} style="stroke" strokeWidth={2}>
          {ringGrad}
        </Circle>
      )}
      <Path path={`M${PAD + 8.6} ${PAD + 7.0}A16.5 16.5 0 0 1 ${PAD + 29.4} ${PAD + 7.0}`} style="stroke" strokeWidth={1.4} strokeCap="round" color="#FFFFFF" opacity={0.85} />
      {hideGlyph ? null : (
        <Group>
          <Path path={`M${PAD + 14} ${PAD + 12.5}A8 8 0 0 1 ${PAD + 14} ${PAD + 25.5}`} style="stroke" strokeWidth={2.4} strokeCap="round" opacity={0.45}>
            {glyphGrad}
          </Path>
          <Path path={`M${PAD + 21} ${PAD + 11}A10 10 0 0 1 ${PAD + 21} ${PAD + 27}`} style="stroke" strokeWidth={2.4} strokeCap="round">
            {glyphGrad}
          </Path>
          <Circle cx={PAD + 11} cy={c} r={1.4}>
            {glyphGrad}
          </Circle>
        </Group>
      )}
    </Canvas>
  );
}

function Glyph({ ch }: { ch: string }) {
  return <Text style={styles.glyph}>{ch}</Text>;
}

/**
 * The listening dock: one 56 pt glass capsule with prev, play, next, record, a
 * speed chip and a gear. The gear opens a pill tray above the capsule (Repeat,
 * Reading, Blind) and turns gold while any of them is on. The screen owns the
 * tray's open state and the popovers; this component only draws and reports
 * where the chip and the pills are.
 */
export const CompactDock = memo(function CompactDock({
  playMode,
  onToggle,
  onPrev,
  onNext,
  prevDisabled,
  nextDisabled,
  recording,
  level,
  onRecord,
  recordLabel,
  stageIndex = -1,
  speed,
  speedOn,
  onSpeed,
  pills,
  trayOpen,
  onTrayToggle,
  compact,
  slot,
  face = 'dot',
  countIn = null,
  beatMs = COUNT_IN_BEAT_MS,
  ringDisabled,
  locked,
  onAnchor,
}: CompactDockProps) {
  const { t } = useT();
  const reduced = useReducedMotion();
  const playing = playMode === 'playing';
  const showGear = !compact && pills.length > 0;
  const anyOn = pills.some((p) => p.on);
  const open = trayOpen && !locked;

  // Faces: only the play face lights.
  const off = useSharedValue(0);
  const playT = useSharedValue(0);
  useEffect(() => {
    playT.value = withTiming(playing ? 1 : 0, { duration: 160 });
  }, [playing, playT]);
  const recT = useSharedValue(0);
  useEffect(() => {
    recT.value = withTiming(recording ? 1 : 0, { duration: 200 });
  }, [recording, recT]);

  const shadowPress = useSharedValue(0);
  useEffect(() => () => cancelAnimation(shadowPress), [shadowPress]);

  // Record glow: breathes with the mic level, as the old record button did.
  const smoothLevel = useSharedValue(0);
  useAnimatedReaction(
    () => (recording ? level.value : 0),
    (v, prev) => {
      if (v === prev) return;
      const safe = Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : 0;
      smoothLevel.value = withTiming(safe, { duration: 80 });
    },
    [recording],
  );
  const glowStyle = useAnimatedStyle(() => {
    const l = num(smoothLevel.value);
    return {
      opacity: num(recT.value) * interpolate(l, [0, 1], [0.15, 0.6]),
      transform: [{ scale: interpolate(l, [0, 1], [1, 1.35]) }],
    };
  });

  // One ring leaves the red button per count beat: 0 at the beat, 1 when the
  // next is due. With reduced motion it stands still while the count runs.
  const beat = useSharedValue(0);
  useEffect(() => {
    cancelAnimation(beat);
    beat.value = 0;
    if (countIn === null || reduced) return;
    beat.value = withTiming(1, { duration: beatMs, easing: Easing.out(Easing.cubic) });
    return () => cancelAnimation(beat);
  }, [countIn, reduced, beat, beatMs]);
  const beatStyle = useAnimatedStyle(() => {
    if (reduced) return { opacity: 0.8, transform: [{ scale: 1.1 }] };
    const b = Math.min(1, Math.max(0, num(beat.value)));
    return { opacity: 0.85 * (1 - b), transform: [{ scale: 1 + 0.22 * b }] };
  }, [reduced]);

  // Gear gold.
  const goldT = useSharedValue(0);
  useEffect(() => {
    goldT.value = withTiming(anyOn ? 1 : 0, { duration: 200, easing: Easing.out(Easing.quad) });
  }, [anyOn, goldT]);
  const goldStyle = useAnimatedStyle(() => ({ opacity: num(goldT.value) }));

  // Anchors: nested layouts, reported only when a box changes.
  const boxes = useRef<Partial<Record<DockAnchorKey, DockAnchor>>>({});
  const capsule = useRef({ x: 0, y: 0 });
  const chip = useRef<{ x: number; y: number; width: number } | null>(null);
  const tray = useRef({ x: 0, y: 0 });
  const trayPad = useRef({ x: 0, y: 0 });
  const pillBoxes = useRef<Partial<Record<string, { x: number; y: number; width: number }>>>({});
  const report = useCallback(
    (key: DockAnchorKey, box: DockAnchor) => {
      const old = boxes.current[key];
      if (old && old.x === box.x && old.y === box.y && old.width === box.width) return;
      boxes.current[key] = box;
      onAnchor(key, box);
    },
    [onAnchor],
  );
  const reportChip = useCallback(() => {
    const c = chip.current;
    if (c) report('speed', { x: capsule.current.x + c.x, y: capsule.current.y + c.y, width: c.width });
  }, [report]);
  const ctl = useRef<Partial<Record<'play' | 'record', { x: number; y: number; width: number }>>>({});
  const reportCtl = useCallback(() => {
    for (const key of ['play', 'record'] as const) {
      const c = ctl.current[key];
      if (c) report(key, { x: capsule.current.x + c.x, y: capsule.current.y + c.y, width: c.width });
    }
  }, [report]);
  const reportPills = useCallback(() => {
    for (const [key, b] of Object.entries(pillBoxes.current)) {
      if (!b) continue;
      report(key as DockAnchorKey, {
        x: capsule.current.x + tray.current.x + trayPad.current.x + b.x,
        y: capsule.current.y + tray.current.y + trayPad.current.y + b.y,
        width: b.width,
      });
    }
  }, [report]);

  // The tray opens above the slot, so the slot's pills stay reachable under it.
  const [slotH, setSlotH] = useState(0);
  const onSlotLayout = useCallback((e: LayoutChangeEvent) => {
    const h = e.nativeEvent.layout.height;
    if (Number.isFinite(h)) setSlotH((old) => (Math.abs(old - h) > 0.5 ? h : old));
  }, []);
  const slotSpace = slot ? slotH + GAP : 0;

  // Tray motion.
  const [mounted, setMounted] = useState(false);
  const progress = useSharedValue(0);
  const p0 = useSharedValue(0);
  const p1 = useSharedValue(0);
  const p2 = useSharedValue(0);
  const p3 = useSharedValue(0);
  const pillT = [p0, p1, p2, p3];
  const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    if (closeTimer.current) {
      clearTimeout(closeTimer.current);
      closeTimer.current = null;
    }
    const go = (v: number) => (reduced ? withTiming(v, { duration: 150 }) : withSpring(v, OPEN_SPRING));
    if (open && showGear) {
      setMounted(true);
      progress.value = go(1);
      pillT.forEach((sv, i) => {
        sv.value = reduced ? withTiming(1, { duration: 150 }) : withDelay(40 * i, withSpring(1, OPEN_SPRING));
      });
    } else {
      progress.value = go(0);
      pillT.forEach((sv) => {
        sv.value = go(0);
      });
      closeTimer.current = setTimeout(() => {
        closeTimer.current = null;
        setMounted(false);
      }, 300);
    }
    return () => {
      if (closeTimer.current) clearTimeout(closeTimer.current);
    };
    // pillT is MAX_PILLS stable shared values.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, showGear, reduced]);
  const trayStyle = useAnimatedStyle(() => {
    const p = num(progress.value);
    return { opacity: p, transform: [{ translateY: 10 * (1 - p) }, { scale: 0.96 + 0.04 * p }] };
  });

  return (
    // box-none: the root spans the screen's width over the transcript, so
    // only the capsule, the tray and the slot's own controls take touches.
    <View style={styles.root} pointerEvents="box-none">
      {slot ? (
        <View style={styles.slot} onLayout={onSlotLayout} pointerEvents="box-none">
          {slot}
        </View>
      ) : null}
      <View
        style={styles.capsuleWrap}
        onLayout={(e: LayoutChangeEvent) => {
          capsule.current = { x: e.nativeEvent.layout.x, y: e.nativeEvent.layout.y };
          reportChip();
          reportCtl();
          reportPills();
        }}>
      <GlassPanel radius={Radius.pill} style={styles.capsule}>
        <View style={styles.capsuleRow}>
          <DockPress onPress={onPrev} disabled={prevDisabled} label={t('player.previousLine')}>
            <PrismFace shape="round" size={38} verb="listen" onT={off} flat>
              <Glyph ch="‹" />
            </PrismFace>
          </DockPress>
          <View
            onLayout={(e) => {
              const { x, y, width } = e.nativeEvent.layout;
              ctl.current.play = { x, y, width };
              reportCtl();
            }}>
            <DockPress onPress={onToggle} disabled={ringDisabled} label={playing ? t('player.stop') : t('player.play')} pressed={0.94}>
            <PrismFace shape="round" size={44} verb="listen" onT={playT} flat>
              {playing ? <View style={styles.stopSquare} /> : <View style={styles.playTriangle} />}
            </PrismFace>
          </DockPress>
          </View>
          <DockPress onPress={onNext} disabled={nextDisabled} label={t('player.nextLine')}>
            <PrismFace shape="round" size={38} verb="listen" onT={off} flat>
              <Glyph ch="›" />
            </PrismFace>
          </DockPress>
          <View
            onLayout={(e) => {
              const { x, y, width } = e.nativeEvent.layout;
              ctl.current.record = { x, y, width };
              reportCtl();
            }}>
            <DockPress onPress={onRecord} disabled={face === 'dim'} label={recordLabel} pressed={0.94} pressT={shadowPress}>
              <Animated.View pointerEvents="none" style={[styles.recordGlow, glowStyle]} />
              <View style={styles.shadowBox}>
                <ShadowRing stage={stageIndex} pressT={shadowPress} hideGlyph={face === 'count'} />
                {face === 'count' ? <Text style={styles.countDigit}>{countIn ?? ''}</Text> : null}
              </View>
              {countIn !== null ? <Animated.View pointerEvents="none" style={[styles.beatRing, beatStyle]} /> : null}
            </DockPress>
          </View>
          {compact ? null : (
            <View
              onLayout={(e) => {
                const { x, y, width } = e.nativeEvent.layout;
                chip.current = { x, y, width };
                reportChip();
              }}>
              <DockPress
                onPress={onSpeed}
                disabled={locked}
                label={t('player.speedSetting', { label: speedLabel(speed) })}
                style={styles.chipHit}>
                <View style={styles.chip}>
                  <Text style={[styles.chipLabel, speedOn && styles.chipLabelOn]}>{speedLabel(speed)}</Text>
                </View>
              </DockPress>
            </View>
          )}
          {showGear ? (
            <DockPress onPress={onTrayToggle} disabled={locked} label={t('player.dockSettings')}>
              <View style={styles.gear}>
                <Animated.View pointerEvents="none" style={[styles.gearGold, goldStyle]} />
                <SymbolView name={{ ios: 'gearshape.fill', android: 'settings' }} size={20} tintColor={tide.textDim} />
                <Animated.View pointerEvents="none" style={[styles.gearGlyphGold, goldStyle]}>
                  <SymbolView name={{ ios: 'gearshape.fill', android: 'settings' }} size={20} tintColor={DOCK_GOLD_INK} />
                </Animated.View>
              </View>
            </DockPress>
          ) : null}
        </View>
      </GlassPanel>
      {mounted && showGear ? (
        <Animated.View
          style={[styles.tray, { bottom: CAPSULE_H + GAP + slotSpace }, trayStyle]}
          pointerEvents={open ? 'auto' : 'none'}
          onLayout={(e) => {
            tray.current = { x: e.nativeEvent.layout.x, y: e.nativeEvent.layout.y };
            reportPills();
          }}>
          <View style={styles.trayCapsule}>
            <View
              style={styles.trayColumn}
              onLayout={(e) => {
                trayPad.current = { x: e.nativeEvent.layout.x, y: e.nativeEvent.layout.y };
                reportPills();
              }}>
              {pills.slice(0, MAX_PILLS).map((p, i) => (
                <TrayPill
                  key={p.key}
                  pill={p}
                  t={pillT[i]!}
                  onBox={(b) => {
                    pillBoxes.current[p.key] = b;
                    reportPills();
                  }}
                />
              ))}
            </View>
          </View>
        </Animated.View>
      ) : null}
      </View>
    </View>
  );
});

function TrayPill({
  pill,
  t,
  onBox,
}: {
  pill: DockPill;
  t: SharedValue<number>;
  onBox: (b: { x: number; y: number; width: number }) => void;
}) {
  const animated = useAnimatedStyle(() => {
    const v = num(t.value);
    return { opacity: v, transform: [{ translateY: 8 * (1 - v) }] };
  });
  return (
    <Animated.View
      style={animated}
      onLayout={(e) => {
        const { x, y, width } = e.nativeEvent.layout;
        onBox({ x, y, width });
      }}>
      <DockPress onPress={pill.onPress} label={pill.value} style={styles.pillHit}>
        <View style={[styles.pill, pill.selected && styles.pillSelected]}>
          {pill.icon}
          <Text style={[styles.pillValue, pill.on && styles.pillValueOn]} numberOfLines={1}>{pill.value}</Text>
        </View>
      </DockPress>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  root: { alignItems: 'center', paddingTop: GAP, paddingBottom: GAP },
  // zIndex: a cat perched in the slot draws over the capsule's top edge, not behind it.
  slot: { alignItems: 'center', marginBottom: GAP, zIndex: 1 },
  capsuleWrap: { height: CAPSULE_H },
  capsule: { height: CAPSULE_H },
  capsuleRow: {
    flex: 1,
    flexDirection: 'row',
    direction: 'ltr',
    alignItems: 'center',
    padding: 6,
    gap: 4,
  },
  hit: { width: HIT, height: HIT, alignItems: 'center', justifyContent: 'center' },
  disabled: { opacity: 0.35 },
  glyph: { fontFamily: fonts.ui, fontSize: 22, color: tide.text },
  playTriangle: {
    width: 0,
    height: 0,
    marginLeft: 3,
    borderTopWidth: 8,
    borderBottomWidth: 8,
    borderLeftWidth: 14,
    borderTopColor: 'transparent',
    borderBottomColor: 'transparent',
    borderLeftColor: verb.listen.c1,
  },
  stopSquare: { width: 14, height: 14, borderRadius: 3, backgroundColor: verb.listen.c1 },
  recordGlow: {
    position: 'absolute',
    width: 48,
    height: 48,
    borderRadius: 24,
    backgroundColor: SHADOW_BLUE,
  },
  shadowBox: { width: 38, height: 38, alignItems: 'center', justifyContent: 'center' },
  shadowCanvas: { position: 'absolute', left: -PAD, top: -PAD, width: 38 + 2 * PAD, height: 38 + 2 * PAD },
  countDigit: { fontFamily: fonts.uiMedium, fontWeight: '500', fontSize: 20, color: SHADOW_BLUE, fontVariant: ['tabular-nums'] },
  beatRing: { position: 'absolute', width: 50, height: 50, borderRadius: 25, borderWidth: 2, borderColor: SHADOW_BLUE },
  chipHit: { width: 56 },
  chip: {
    height: 36,
    minWidth: 56,
    paddingHorizontal: 10,
    borderRadius: 18,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(255,255,255,0.07)',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.14)',
  },
  chipLabel: { fontFamily: fonts.uiMedium, fontSize: 12, color: tide.text, fontVariant: ['tabular-nums'] },
  chipLabelOn: { color: verb.listen.c1 },
  gear: { width: 38, height: 38, borderRadius: 19, alignItems: 'center', justifyContent: 'center' },
  gearGold: {
    ...StyleSheet.absoluteFill,
    borderRadius: 19,
    backgroundColor: GOLD_FILL,
    borderWidth: 1,
    borderColor: GOLD_RING,
  },
  gearGlyphGold: { ...StyleSheet.absoluteFill, alignItems: 'center', justifyContent: 'center' },
  // Above the capsule, outside its box. RN Android hit-tests children past
  // their parent's bounds while no ancestor clips (overflow visible).
  tray: { position: 'absolute', right: 0 },
  trayCapsule: {
    flexDirection: 'column',
    width: DOCK_PILL_W + 16,
    borderRadius: POP.radius,
    backgroundColor: POP.surface,
    borderWidth: 1,
    borderColor: POP.border,
    boxShadow: POP.shadow,
  },
  trayColumn: { padding: 8 - 1, gap: 6 },
  pillHit: { width: DOCK_PILL_W, height: DOCK_PILL_H },
  pill: {
    width: DOCK_PILL_W,
    height: DOCK_PILL_H,
    paddingHorizontal: 12,
    borderRadius: 14,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 7,
    borderWidth: 1,
    borderColor: 'transparent',
  },
  pillSelected: { backgroundColor: POP.goldSelFill, borderColor: POP.goldSelRing },
  pillValue: { flexShrink: 1, fontFamily: fonts.uiMedium, fontWeight: '600', fontSize: 13, color: POP.offInk },
  pillValueOn: { color: DOCK_GOLD_INK },
});
